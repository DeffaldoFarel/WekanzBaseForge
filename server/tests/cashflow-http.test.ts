import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {getSchemaVersion, getCollectionByName, updateCollection} from '../src/core/schema.js';
import {initPlatformDb, closePlatformDb} from '../src/core/platformDb.js';
import {closeAllProjectDbs, getProjectDb} from '../src/core/projectDbManager.js';
import {Router} from '../src/core/router.js';
import {createAdminRouter} from '../src/api/adminRoutes.js';
import {createDatabaseRouter} from '../src/api/databaseRoutes.js';
import {createPublicRouter} from '../src/api/publicRoutes.js';
import {createApiKeyRouter} from '../src/api/apiKeyRoutes.js';
import {sandboxedDbCall} from '../src/core/dbSandbox.js';
import {realtimeHub} from '../src/core/realtime.js';
import {closeRateLimiter} from '../src/auth/rateLimiter.js';
import {BaseForge} from '../../packages/client/src/client.js';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cashflow-http-'));
let server:http.Server, root='', pid='', token='', service='';
const contract={version:1,sourceOwner:'userId',targetOwner:'userId',targetMode:'trackingMode',assetMode:'asset_ledger',tradingMode:'trading_cashflow',flowField:'flowType',quantityField:'amount',valueField:'idr',immutableModeWhenReferenced:true};
async function request(method:string, route:string, body?:unknown, credential?:{kind:'admin'|'service', value:string}) {
  const headers:Record<string,string>={'content-type':'application/json'};
  if(credential?.kind==='admin') headers.authorization='Bear'+'er '+credential.value;
  if(credential?.kind==='service') headers['x-api-key']=credential.value;
  const res=await fetch(root+route,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:res.status,data:await res.json() as any};
}
const admin=()=>({kind:'admin' as const,value:token});
const key=()=>({kind:'service' as const,value:service});
before(async()=>{
  process.env.NODE_ENV='test'; process.env.DATA_DIR=dir; process.env.STORAGE_DIR=path.join(dir,'storage');
  process.env.ADMIN_EMAIL='cashflow@test.local'; process.env.ADMIN_PASSWORD='cashflow-test-pass';
  initPlatformDb();
  const r=new Router(); r.merge(createAdminRouter()); r.merge(createDatabaseRouter()); r.merge(createPublicRouter()); r.merge(createApiKeyRouter());
  server=http.createServer((req,res)=>{void r.handle(req,res)}); await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  root='http://127.0.0.1:'+ (server.address() as {port:number}).port;
  const login=await request('POST','/api/admin/auth/login',{email:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD}); assert.equal(login.status,200); token=login.data.token;
  const project=await request('POST','/api/admin/projects',{name:'isolated-cashflow-http'},admin()); assert.equal(project.status,201); pid=project.data.project.id;
  const api=await request('POST',`/api/admin/projects/${pid}/api-keys`,{scope:'write'},admin()); assert.equal(api.status,201); service=api.data.key;
});
after(async()=>{ if(server) await new Promise<void>(resolve=>server.close(()=>resolve())); closeAllProjectDbs(); closePlatformDb(); closeRateLimiter(); fs.rmSync(dir,{recursive:true,force:true}); });

test('capability is public over HTTP',async()=>{
  const response=await request('GET','/api/capabilities');
  assert.equal(response.status,200); assert.deepEqual(response.data,{capabilities:{cashflowIntegrity:[1]}});
});

test('HTTP public, admin and service writes enforce opt-in and failures emit no realtime events',async()=>{
  const base=`/api/admin/projects/${pid}/collections`;
  let response=await request('POST',base,{name:'accounts',fields:[{name:'userId',type:'text'},{name:'trackingMode',type:'text'}],rules:{viewRule:'',createRule:'',updateRule:'',listRule:''}},admin()); assert.equal(response.status,201,JSON.stringify(response.data));
  const fields=[{name:'userId',type:'text'},{name:'accountId',type:'relation',options:{collectionId:'accounts',cashflowIntegrity:contract}},{name:'flowType',type:'text'},{name:'amount',type:'number',options:{signed:true}},{name:'idr',type:'number',options:{signed:true}}];
  response=await request('POST',base,{name:'activities',fields,rules:{viewRule:'',createRule:'',updateRule:'',listRule:''}},admin()); assert.equal(response.status,201,JSON.stringify(response.data));
  response=await request('POST',`${base}/accounts/records`,{id:'acct',userId:'u1',trackingMode:'trading_cashflow'},admin()); assert.equal(response.status,201);
  const publicPath=`/api/p/${pid}/collections/activities/records`, adminPath=`${base}/activities/records`;
  const invalid={userId:'u1',accountId:'acct',amount:null,idr:5};
  let publications=0;
  const original=realtimeHub.publish;
  realtimeHub.publish=function(...args:Parameters<typeof original>){publications++; return original.apply(this,args)};
  try {
    for(const [route,credential] of [[publicPath,undefined],[adminPath,admin()],[publicPath,key()]] as const){
      const result=await request('POST',route,invalid,credential); assert.ok(result.status>=400,JSON.stringify(result)); assert.match(result.data.error.message,/cashflow/i);
    }
    // DB writes through the public, admin, service-key and function paths
    // publish only after the core mutation succeeds.
    const sandbox=await sandboxedDbCall({op:'create',collection:'activities',data:invalid},{db:getProjectDb(pid),dbAccess:true,depth:0,callCounter:{count:0},maxDbCalls:10,onRealtimeWrite:()=>{publications++},onWrite:()=>{publications++}}).then(()=>null,err=>err);
    assert.match(String(sandbox),/cashflow/i); assert.equal(publications,0);
    assert.equal((getProjectDb(pid).prepare('SELECT count(*) AS n FROM activities').get() as {n:number}).n,0);
    const good=await request('POST',publicPath,{...invalid,flowType:'deposit'},key()); assert.equal(good.status,201,JSON.stringify(good.data));
    assert.equal(publications,1);
    const badUpdate=await request('PATCH',`${publicPath}/${good.data.record.id}`,{idr:-2},key()); assert.ok(badUpdate.status>=400); assert.equal(publications,1);
    const batch=await request('POST',`${adminPath}/batch`,{records:[{...invalid,flowType:'deposit'},invalid]},admin());
    assert.ok(batch.status>=400); assert.match(batch.data.error.message,/cashflow/i);
    assert.equal(publications,1);
    assert.equal((getProjectDb(pid).prepare('SELECT count(*) AS n FROM activities').get() as {n:number}).n,1);
  } finally {realtimeHub.publish=original;}
  response=await request('POST',base,{name:'legacy',fields:fields.map(f=>f.name==='accountId'?{...f,options:{collectionId:'accounts'}}:f),rules:{createRule:''}},admin()); assert.equal(response.status,201);
  response=await request('POST',`/api/p/${pid}/collections/legacy/records`,invalid); assert.equal(response.status,201,JSON.stringify(response.data));
});

test('legacy asset row accepts missing flow and valid same-mode edits',async()=>{
  const base=`/api/admin/projects/${pid}/collections`;
  let res=await request('POST',`${base}/accounts/records`,{id:'asset',userId:'u1',trackingMode:'asset_ledger'},admin()); assert.equal(res.status,201);
  const pub=`/api/p/${pid}/collections/activities/records`;
  res=await request('POST',pub,{userId:'u1',accountId:'asset',amount:2,idr:4}); assert.equal(res.status,201,JSON.stringify(res.data));
  const id=res.data.record.id;
  res=await request('PATCH',`${pub}/${id}`,{amount:3}); assert.equal(res.status,200);
  res=await request('PATCH',`${pub}/${id}`,{accountId:'acct',amount:null,idr:-4,flowType:'withdrawal'}); assert.equal(res.status,200,JSON.stringify(res.data));
  res=await request('PATCH',`${pub}/${id}`,{accountId:'asset',amount:3,flowType:null}); assert.equal(res.status,200,JSON.stringify(res.data));
});

test('successful opt-in activation then stale patch cannot remove protection',async()=>{
  const base=`/api/admin/projects/${pid}/collections`;
  const fields=[{name:'userId',type:'text'},{name:'accountId',type:'relation',options:{collectionId:'accounts'}},{name:'flowType',type:'text'},{name:'amount',type:'number'},{name:'idr',type:'number',options:{signed:true}}];
  let result=await request('POST',base,{name:'activation',fields,rules:{createRule:''}},admin()); assert.equal(result.status,201);
  result=await request('GET',`${base}/activation`,undefined,admin()); const oldVersion=result.data.schemaVersion;
  const opted=fields.map(f=>f.name==='accountId'?{...f,options:{...f.options,cashflowIntegrity:contract}}:f);
  result=await request('PATCH',`${base}/activation`,{fields:opted,expectedSchemaVersion:oldVersion},admin()); assert.equal(result.status,200,JSON.stringify(result.data));
  result=await request('PATCH',`${base}/activation`,{fields,expectedSchemaVersion:oldVersion},admin()); assert.equal(result.status,409,JSON.stringify(result.data));
  result=await request('POST',`/api/p/${pid}/collections/activation/records`,{userId:'u1',accountId:'acct',idr:1,amount:null});
  assert.ok(result.status>=400); assert.match(result.data.error.message,/cashflow/i);
});

test('schema reads return metadata and version from one SQLite snapshot',async()=>{
  const base=`/api/admin/projects/${pid}/collections`;
  let result=await request('POST',base,{name:'snap',fields:[{name:'a',type:'text'}]},admin()); assert.equal(result.status,201);
  const db=getProjectDb(pid), filename=path.join(dir,'projects',pid,'data.db');
  const other=new DatabaseSync(filename); other.exec('PRAGMA busy_timeout=1');
  const original=db.prepare.bind(db); let injected=false;
  (db as any).prepare=(sql:string)=>{
    const statement=original(sql);
    if(!injected && sql.includes('AS schemaVersion FROM _collections')) {
      return new Proxy(statement,{get(target,property){
        if(property==='get') return (...args:any[])=>{
          const row=target.get(...args);
          injected=true;
          const v=getSchemaVersion(other,'snap');
          updateCollection(other,'snap',{fields:[{name:'a',type:'text'},{name:'b',type:'text'}],expectedSchemaVersion:v});
          return row;
        };
        const value=Reflect.get(target,property,target); return typeof value==='function'?value.bind(target):value;
      }});
    }
    return statement;
  };
  try {
    result=await request('GET',`${base}/snap`,undefined,admin()); assert.equal(result.status,200);
    assert.equal(injected,true);
    const edit=await request('PUT',`${base}/snap`,{fields:result.data.collection.fields,expectedSchemaVersion:result.data.schemaVersion},admin());
    assert.equal(edit.status,409,JSON.stringify(edit.data));
    assert.ok(getCollectionByName(other,'snap')!.fields.some(field=>field.name==='b'));
  } finally {(db as any).prepare=original; other.close();}
});

test('legacy schema-edit clients can PATCH and PUT unrelated collections without a version', async()=>{
  const base=`/api/admin/projects/${pid}/collections`;
  const created=await request('POST',base,{name:'legacyEditor',fields:[{name:'a',type:'text'}],rules:{createRule:'',viewRule:''}},admin()); assert.equal(created.status,201);
  let result=await request('POST',`/api/p/${pid}/collections/legacyEditor/records`,{id:'kept',a:'original'}); assert.equal(result.status,201,JSON.stringify(result.data));
  result=await request('PATCH',`${base}/legacyEditor`,{fields:[{name:'a',type:'text'},{name:'b',type:'text'}]},admin());
  assert.equal(result.status,200,JSON.stringify(result.data));
  result=await request('PUT',`${base}/legacyEditor`,{fields:[{name:'a',type:'text'}]},admin());
  assert.equal(result.status,200,JSON.stringify(result.data));
  result=await request('GET',`/api/p/${pid}/collections/legacyEditor/records/kept`);
  assert.equal(result.status,200,JSON.stringify(result.data)); assert.equal(result.data.record.a,'original');
});

test('TypeScript package client CRUD remains operational on an unrelated collection',async()=>{
  const base=`/api/admin/projects/${pid}/collections`;
  const result=await request('POST',base,{
    name:'sdkLegacy',fields:[{name:'value',type:'text'}],
    rules:{listRule:'',viewRule:'',createRule:'',updateRule:'',deleteRule:''},
  },admin());
  assert.equal(result.status,201,JSON.stringify(result.data));
  const records=new BaseForge({baseUrl:root,projectId:pid}).collection('sdkLegacy');
  const created=await records.create<{id:string;value:string}>({id:'sdk-row',value:'before'});
  assert.equal(created.value,'before');
  assert.equal((await records.getOne<{id:string;value:string}>(created.id)).value,'before');
  assert.equal((await records.update<{id:string;value:string}>(created.id,{value:'after'})).value,'after');
  assert.equal((await records.getList<{id:string;value:string}>()).items[0].value,'after');
  assert.equal(await records.delete(created.id),true);
});

test('HTTP activation and edits to active sources and their targets require a version',async()=>{
  const base=`/api/admin/projects/${pid}/collections`;
  const targetFields=[{name:'userId',type:'text'},{name:'trackingMode',type:'text'}];
  const sourceFields=[{name:'userId',type:'text'},{name:'accountId',type:'relation',options:{collectionId:'scopeAccounts'}},{name:'flowType',type:'text'},{name:'amount',type:'number'},{name:'idr',type:'number',options:{signed:true}}];
  const opted=sourceFields.map(f=>f.name==='accountId'?{...f,options:{...f.options,cashflowIntegrity:contract}}:f);
  let result=await request('POST',base,{name:'scopeAccounts',fields:targetFields},admin()); assert.equal(result.status,201);
  result=await request('POST',base,{name:'scopeActivities',fields:sourceFields},admin()); assert.equal(result.status,201);
  const originalVersion=result.data.collection.schemaVersion;
  for(const method of ['PATCH','PUT']) {
    result=await request(method,`${base}/scopeActivities`,{fields:opted},admin());
    assert.equal(result.status,409,`${method} activation: ${JSON.stringify(result.data)}`);
    assert.equal(result.data.error.code,'SCHEMA_VERSION_CONFLICT');
  }
  result=await request('PATCH',`${base}/scopeActivities`,{fields:opted,expectedSchemaVersion:originalVersion},admin()); assert.equal(result.status,200,JSON.stringify(result.data));
  for(const [name,fields] of [['scopeActivities',opted],['scopeAccounts',targetFields]] as const) {
    for(const method of ['PATCH','PUT']) {
      result=await request('GET',`${base}/${name}`,undefined,admin());
      result=await request(method,`${base}/${name}`,{fields,expectedSchemaVersion:result.data.schemaVersion},admin());
      assert.equal(result.status,200,`${method} ${name}: ${JSON.stringify(result.data)}`);
    }
  }
  result=await request('GET',`${base}/scopeActivities`,undefined,admin());
  assert.deepEqual(result.data.collection.fields.find((f:any)=>f.name==='accountId').options.cashflowIntegrity,contract);
});

test('HTTP active source accepts equivalent contract keys in a different order',async()=>{
  const base=`/api/admin/projects/${pid}/collections`;
  const fields=[{name:'userId',type:'text'},{name:'accountId',type:'relation',options:{collectionId:'reorderAccounts',cashflowIntegrity:contract}},{name:'flowType',type:'text'},{name:'amount',type:'number'},{name:'idr',type:'number',options:{signed:true}}];
  let result=await request('POST',base,{name:'reorderAccounts',fields:[{name:'userId',type:'text'},{name:'trackingMode',type:'text'}]},admin()); assert.equal(result.status,201);
  result=await request('POST',base,{name:'reorderSource',fields},admin()); assert.equal(result.status,201,JSON.stringify(result.data));
  const reordered=Object.fromEntries(Object.entries(contract).reverse());
  const equivalent=fields.map(f=>f.name==='accountId'?{...f,options:{...f.options,cashflowIntegrity:reordered}}:f);
  for(const method of ['PATCH','PUT']) {
    result=await request('GET',`${base}/reorderSource`,undefined,admin());
    result=await request(method,`${base}/reorderSource`,{fields:equivalent,expectedSchemaVersion:result.data.schemaVersion},admin());
    assert.equal(result.status,200,`${method}: ${JSON.stringify(result.data)}`);
  }
  result=await request('GET',`${base}/reorderSource`,undefined,admin());
  assert.deepEqual(result.data.collection.fields.find((f:any)=>f.name==='accountId').options.cashflowIntegrity,contract);
});

test('HTTP malformed stored markers still protect their declared target',async()=>{
  const base=`/api/admin/projects/${pid}/collections`;
  const target=[{name:'userId',type:'text'},{name:'trackingMode',type:'text'}];
  const source=[{name:'userId',type:'text'},{name:'accountId',type:'relation',options:{collectionId:'brokenTarget',cashflowIntegrity:contract}},{name:'flowType',type:'text'},{name:'amount',type:'number'},{name:'idr',type:'number'}];
  let result=await request('POST',base,{name:'brokenTarget',fields:target},admin()); assert.equal(result.status,201);
  result=await request('POST',base,{name:'brokenSource',fields:source},admin()); assert.equal(result.status,201);
  for(const marker of [null,{...contract,version:99}]) {
    const corrupted=source.map(f=>f.name==='accountId'?{...f,options:{...f.options,cashflowIntegrity:marker}}:f);
    getProjectDb(pid).prepare('UPDATE _collections SET fields=? WHERE name=?').run(JSON.stringify(corrupted),'brokenSource');
    for(const method of ['PATCH','PUT']) {
      result=await request(method,`${base}/brokenTarget`,{fields:target,expectedSchemaVersion:(await request('GET',`${base}/brokenTarget`,undefined,admin())).data.schemaVersion},admin());
      assert.equal(result.status,400,JSON.stringify(result.data)); assert.match(result.data.error.message,/cashflow/i);
    }
  }
  result=await request('POST',base,{name:'stillUnrelated',fields:[{name:'a',type:'text'}]},admin()); assert.equal(result.status,201);
  result=await request('PATCH',`${base}/stillUnrelated`,{fields:[{name:'a',type:'text'},{name:'c',type:'text'}]},admin());
  assert.equal(result.status,200,JSON.stringify(result.data));
});

test('HTTP optional compare-and-swap rejects explicit malformed or stale versions',async()=>{
  const base=`/api/admin/projects/${pid}/collections`;
  const fields=[{name:'a',type:'text'}];
  let result=await request('POST',base,{name:'optionalCas',fields},admin()); assert.equal(result.status,201);
  const version=result.data.collection.schemaVersion;
  for(const method of ['PATCH','PUT']) {
    for(const bad of [null,'1',-1,1.5,{},false]) {
      result=await request(method,`${base}/optionalCas`,{fields,expectedSchemaVersion:bad},admin());
      assert.equal(result.status,409,`${method} ${JSON.stringify(bad)}: ${JSON.stringify(result.data)}`);
      assert.equal(result.data.error.code,'SCHEMA_VERSION_CONFLICT');
    }
  }
  result=await request('PATCH',`${base}/optionalCas`,{fields:[...fields,{name:'b',type:'text'}],expectedSchemaVersion:version},admin()); assert.equal(result.status,200);
  for(const method of ['PATCH','PUT']) {
    result=await request(method,`${base}/optionalCas`,{fields,expectedSchemaVersion:version},admin());
    assert.equal(result.status,409,`${method} stale: ${JSON.stringify(result.data)}`);
  }
  result=await request('GET',`${base}/optionalCas`,undefined,admin());
  assert.deepEqual(result.data.collection.fields.map((f:any)=>f.name),['a','b']);
});

test('HTTP supplied schema versions enforce compare-and-swap on unrelated edits',async()=>{
  const base=`/api/admin/projects/${pid}/collections`;
  let result=await request('POST',base,{name:'versioned',fields:[{name:'a',type:'text'}]},admin()); assert.equal(result.status,201);
  result=await request('GET',`${base}/versioned`,undefined,admin()); assert.equal(result.status,200); const version=result.data.schemaVersion; assert.equal(typeof version,'number');
  result=await request('PATCH',`${base}/versioned`,{fields:[{name:'a',type:'text'},{name:'b',type:'text'}],expectedSchemaVersion:version},admin()); assert.equal(result.status,200,JSON.stringify(result.data));
  result=await request('PUT',`${base}/versioned`,{fields:[{name:'a',type:'text'}],expectedSchemaVersion:version},admin()); assert.equal(result.status,409,JSON.stringify(result.data));
  result=await request('GET',`${base}/versioned`,undefined,admin()); assert.equal(result.data.collection.fields.length,2);
  result=await request('PUT',`${base}/versioned`,{fields:[{name:'a',type:'text'}],expectedSchemaVersion:result.data.schemaVersion},admin()); assert.equal(result.status,200,JSON.stringify(result.data));
});
