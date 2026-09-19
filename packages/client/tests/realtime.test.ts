// Ops-7: Realtime SDK dispatch — envelope { collection, action, record }
// Bagian A: unit test dispatch (FakeEventSource + fetch stub, tanpa server).
// Bagian B: integration end-to-end ke server nyata di localhost:5100
//           (auto-skip bila server tidak jalan).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { BaseForge, MemoryAuthStore } from '../src/index.js';
import type { RecordModel, RealtimeEvent } from '../src/types.js';

const g = globalThis as unknown as { EventSource?: unknown };

// ─── A. FakeEventSource ──────────────────────────────────────────────────────
type EvHandler = (e: { data: string }) => void;

class FakeEventSource {
  static last: FakeEventSource | null = null;
  handlers = new Map<string, Set<EvHandler>>();
  closed = false;
  constructor(public url: string) {
    FakeEventSource.last = this;
    // Auto-connect setelah handler PB_CONNECT terpasang (microtask)
    queueMicrotask(() => this.emit('PB_CONNECT', { clientId: 'fake_client_1' }));
  }
  addEventListener(type: string, h: EvHandler): void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(h);
  }
  emit(type: string, data: unknown): void {
    this.emitRaw(type, JSON.stringify(data));
  }
  emitRaw(type: string, data: string): void {
    for (const h of this.handlers.get(type) ?? []) h({ data });
  }
  close(): void {
    this.closed = true;
  }
}

function okFetch(): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ ok: true, subscriptions: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

function waitFor(cond: () => boolean, timeoutMs = 6000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

// ─── A. UNIT: dispatch envelope ──────────────────────────────────────────────
describe('Ops-7 unit: dispatch envelope { collection, action, record }', () => {
  const origFetch = globalThis.fetch;
  let origES: unknown;

  before(() => {
    origES = g.EventSource;
    g.EventSource = FakeEventSource;
    globalThis.fetch = okFetch();
  });
  after(() => {
    g.EventSource = origES;
    globalThis.fetch = origFetch;
    FakeEventSource.last = null;
  });

  test('listener menerima RECORD murni (bukan envelope) + action benar', async () => {
    const bf = new BaseForge({
      baseUrl: 'http://fake.local',
      projectId: 'p1',
      authStore: new MemoryAuthStore(),
    });
    const got: RealtimeEvent[] = [];
    const unsub = await bf.realtime.subscribe('notes/*', (e) => got.push(e));

    const es = FakeEventSource.last!;
    es.emit('PB_CREATE', {
      collection: 'notes',
      action: 'create',
      record: { id: 'r1', created: '', updated: '', userId: 'u9', title: 'halo' },
    });

    assert.equal(got.length, 1, 'listener harus menerima 1 event');
    assert.equal(got[0].action, 'create');
    assert.equal(got[0].record.id, 'r1');
    assert.equal((got[0].record as RecordModel & { title?: string }).title, 'halo');
    // Inti bug Ops-7: record harus record MURNI — bukan envelope yang bocor masuk
    assert.equal('collection' in got[0].record, false, 'record tidak boleh berupa envelope');
    await unsub();
  });

  test('filter per-collection: topik notes/* tidak menerima event collection lain', async () => {
    const bf = new BaseForge({
      baseUrl: 'http://fake.local',
      projectId: 'p1',
      authStore: new MemoryAuthStore(),
    });
    const notes: RealtimeEvent[] = [];
    const others: RealtimeEvent[] = [];
    await bf.realtime.subscribe('notes/*', (e) => notes.push(e));
    await bf.realtime.subscribe('other/*', (e) => others.push(e));

    const es = FakeEventSource.last!;
    es.emit('PB_CREATE', {
      collection: 'other',
      action: 'create',
      record: { id: 'o1', created: '', updated: '' },
    });
    assert.equal(notes.length, 0, 'listener notes/* tidak boleh menerima event other');

    es.emit('PB_CREATE', {
      collection: 'notes',
      action: 'create',
      record: { id: 'n1', created: '', updated: '' },
    });
    assert.equal(notes.length, 1, 'listener notes/* menerima event notes');
    assert.equal(others.length, 1, 'listener other/* hanya menerima event other');
    await bf.realtime.unsubscribe();
  });

  test('topik recordId notes/r2 hanya menerima record dengan id r2', async () => {
    const bf = new BaseForge({
      baseUrl: 'http://fake.local',
      projectId: 'p1',
      authStore: new MemoryAuthStore(),
    });
    const got: RealtimeEvent[] = [];
    await bf.realtime.subscribe('notes/r2', (e) => got.push(e));

    const es = FakeEventSource.last!;
    es.emit('PB_UPDATE', {
      collection: 'notes',
      action: 'update',
      record: { id: 'r1', created: '', updated: '' },
    });
    assert.equal(got.length, 0, 'r1 tidak boleh sampai ke topik r2');

    es.emit('PB_UPDATE', {
      collection: 'notes',
      action: 'update',
      record: { id: 'r2', created: '', updated: '', title: 'target' },
    });
    assert.equal(got.length, 1, 'r2 harus sampai ke topik notes/r2');
    assert.equal(got[0].record.id, 'r2');
    await bf.realtime.unsubscribe();
  });

  test('PB_DELETE: record = snapshot penuh (M38), bukan { id } saja', async () => {
    const bf = new BaseForge({
      baseUrl: 'http://fake.local',
      projectId: 'p1',
      authStore: new MemoryAuthStore(),
    });
    const got: RealtimeEvent[] = [];
    await bf.realtime.subscribe('notes/*', (e) => got.push(e));

    FakeEventSource.last!.emit('PB_DELETE', {
      collection: 'notes',
      action: 'delete',
      record: { id: 'r3', created: '', updated: '', userId: 'u9', title: 'mau dihapus' },
    });

    assert.equal(got.length, 1);
    assert.equal(got[0].action, 'delete');
    const rec = got[0].record as RecordModel & { userId?: string; title?: string };
    assert.equal(rec.id, 'r3');
    assert.equal(rec.userId, 'u9', 'snapshot delete harus membawa field record');
    await bf.realtime.unsubscribe();
  });

  test('fallback: payload non-envelope (record telanjang) tetap ter-dispatch', async () => {
    const bf = new BaseForge({
      baseUrl: 'http://fake.local',
      projectId: 'p1',
      authStore: new MemoryAuthStore(),
    });
    const got: RealtimeEvent[] = [];
    await bf.realtime.subscribe('notes/*', (e) => got.push(e));

    // Payload legacy/custom tanpa envelope — dispatch tetap jalan, collection undefined
    FakeEventSource.last!.emitRaw('PB_CREATE', JSON.stringify({ id: 'r4', created: '', updated: '' }));
    assert.equal(got.length, 1);
    assert.equal(got[0].record.id, 'r4');
    await bf.realtime.unsubscribe();
  });
});

// ─── B. INTEGRATION: SSE nyata ke server localhost:5100 ─────────────────────
class MiniEventSource {
  handlers = new Map<string, Set<EvHandler>>();
  onerror: (() => void) | null = null;
  closed = false;
  private ac = new AbortController();

  constructor(url: string) {
    void this.start(url);
  }
  private async start(url: string): Promise<void> {
    try {
      const res = await fetch(url, {
        headers: { accept: 'text/event-stream' },
        signal: this.ac.signal,
      });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let ev = 'message';
          const datas: string[] = [];
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) ev = line.slice(6).trim();
            else if (line.startsWith('data:')) datas.push(line.slice(5).trim());
          }
          if (datas.length > 0) this.fire(ev, datas.join('\n'));
        }
      }
      if (!this.closed) this.onerror?.();
    } catch {
      if (!this.closed) this.onerror?.();
    }
  }
  private fire(type: string, data: string): void {
    for (const h of this.handlers.get(type) ?? []) h({ data });
  }
  addEventListener(type: string, h: EvHandler): void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(h);
  }
  close(): void {
    this.closed = true;
    this.ac.abort();
  }
}

describe('Ops-7 integration: SSE end-to-end (server nyata)', () => {
  const BASE_URL = 'http://localhost:5100';
  let serverUp = false;
  let adminToken = '';
  let projectId = '';
  let origES: unknown;
  let bf: BaseForge;

  before(async () => {
    try {
      const res = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(2000) });
      serverUp = res.ok;
    } catch {
      serverUp = false;
    }
    if (!serverUp) return;

    // 1. Login admin dev lokal (fixture client.test.ts)
    const loginRes = await fetch(`${BASE_URL}/api/admin/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@baseforge.local', password: 'admin123' }),
    });
    assert.equal(loginRes.status, 200, 'Admin login harus berhasil');
    adminToken = (await loginRes.json()).token;

    // 2. Project + collection notes (rules publik, pola client.test.ts)
    const projRes = await fetch(`${BASE_URL}/api/admin/projects`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `ops7_rt_${Date.now()}` }),
    });
    assert.equal(projRes.status, 201, 'Create project harus berhasil');
    projectId = (await projRes.json()).project.id;

    await fetch(`${BASE_URL}/api/admin/projects/${projectId}/collections`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'notes',
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'userId', type: 'text' },
        ],
        rules: { listRule: '', viewRule: '', createRule: '', updateRule: '', deleteRule: '' },
      }),
    });

    // 3. Pasang polyfill SSE + client SDK
    origES = g.EventSource;
    g.EventSource = MiniEventSource;
    bf = new BaseForge({ baseUrl: BASE_URL, projectId, authStore: new MemoryAuthStore() });
  });

  after(async () => {
    g.EventSource = origES;
    if (projectId && adminToken) {
      await fetch(`${BASE_URL}/api/admin/projects/${projectId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
    }
  });

  test('create → update → delete: listener menerima delta via SSE nyata', async (t) => {
    if (!serverUp) return t.skip('server localhost:5100 tidak jalan — integration di-skip');

    const events: RealtimeEvent[] = [];
    await bf.realtime.subscribe('notes/*', (e) => events.push(e));

    // CREATE
    const created = await bf.collection('notes').create({ title: 'ops7-live', userId: 'u_live' });
    await waitFor(() => events.length >= 1);
    assert.equal(events[0].action, 'create');
    assert.equal(events[0].record.id, created.id);
    assert.equal((events[0].record as RecordModel & { title?: string }).title, 'ops7-live');
    assert.equal('collection' in events[0].record, false, 'record murni, bukan envelope');

    // UPDATE
    await bf.collection('notes').update(created.id as string, { title: 'ops7-updated' });
    await waitFor(() => events.length >= 2);
    assert.equal(events[1].action, 'update');
    assert.equal((events[1].record as RecordModel & { title?: string }).title, 'ops7-updated');

    // DELETE (M38: snapshot penuh)
    await bf.collection('notes').delete(created.id as string);
    await waitFor(() => events.length >= 3);
    assert.equal(events[2].action, 'delete');
    assert.equal(events[2].record.id, created.id);
    const delRec = events[2].record as RecordModel & { userId?: string };
    assert.equal(delRec.userId, 'u_live', 'delete harus membawa snapshot penuh');

    await bf.realtime.unsubscribe();
  });

  test('filter collection: subscriber notes/* tidak menerima event collection lain', async (t) => {
    if (!serverUp) return t.skip('server localhost:5100 tidak jalan — integration di-skip');

    // Collection kedua untuk cross-talk test
    await fetch(`${BASE_URL}/api/admin/projects/${projectId}/collections`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'journal',
        fields: [{ name: 'body', type: 'text' }],
        rules: { listRule: '', viewRule: '', createRule: '', updateRule: '', deleteRule: '' },
      }),
    });

    const notesEvents: RealtimeEvent[] = [];
    await bf.realtime.subscribe('notes/*', (e) => notesEvents.push(e));
    await bf.collection('journal').create({ body: 'bukan notes' });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(notesEvents.length, 0, 'event journal tidak boleh bocor ke notes/*');

    const n = await bf.collection('notes').create({ title: 'murni-notes' });
    await waitFor(() => notesEvents.length >= 1);
    assert.equal(notesEvents[0].record.id, n.id);
    await bf.realtime.unsubscribe();
  });
});
