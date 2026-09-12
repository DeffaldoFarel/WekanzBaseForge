// Smoke test M18d: rate limiter dengan Redis backend nyata (port 16379)
process.env.REDIS_URL = 'redis://127.0.0.1:16379';

import { checkRateLimit, secondsUntilReset, resetAllRateLimits, closeRateLimiter } from '../src/auth/rateLimiter.js';

async function main() {
  // Tunggu Redis ready
  await new Promise((r) => setTimeout(r, 500));

  await resetAllRateLimits();

  // 1. Limit 3 per window
  const results: boolean[] = [];
  for (let i = 0; i < 5; i++) {
    results.push(await checkRateLimit('smoke:key1', 3, 60_000));
  }
  console.log('5 request, limit 3 →', results.join(','));
  if (results.join(',') !== 'true,true,true,false,false') {
    console.error('FAIL: pola rate limit salah');
    process.exit(1);
  }

  // 2. Retry-After harus > 0 saat ditolak
  const retry = await secondsUntilReset('smoke:key1');
  console.log('Retry-After:', retry, 'detik');
  if (retry <= 0 || retry > 60) {
    console.error('FAIL: retry-after tidak masuk akal');
    process.exit(1);
  }

  // 3. Key berbeda = hitungan terpisah
  const other = await checkRateLimit('smoke:key2', 3, 60_000);
  console.log('key berbeda diizinkan:', other);
  if (!other) { console.error('FAIL: key terpisah harus diizinkan'); process.exit(1); }

  // 4. Verifikasi key benar-benar ada di Redis (bukan memory fallback)
  const { default: Redis } = await import('ioredis');
  const probe = new Redis('redis://127.0.0.1:16379');
  const ttl = await probe.ttl('rl:smoke:key1');
  const val = await probe.get('rl:smoke:key1');
  await probe.quit();
  console.log('Redis rl:smoke:key1 =', val, 'ttl =', ttl);
  if (val === null || Number(val) < 3 || ttl <= 0 || ttl > 60) {
    console.error('FAIL: hitungan tidak tersimpan di Redis');
    process.exit(1);
  }

  // 5. Reset menghapus dari Redis
  await resetAllRateLimits();
  const probe2 = new Redis('redis://127.0.0.1:16379');
  const gone = await probe2.get('rl:smoke:key1');
  await probe2.quit();
  console.log('setelah reset, key =', gone);
  if (gone !== null) { console.error('FAIL: reset tidak menghapus key Redis'); process.exit(1); }

  // 6. Setelah reset → diizinkan lagi
  const again = await checkRateLimit('smoke:key1', 3, 60_000);
  console.log('setelah reset diizinkan:', again);
  if (!again) { console.error('FAIL'); process.exit(1); }

  await closeRateLimiter();
  console.log('\n✅ M18d Redis rate limiter: SEMUA CHECK LULUS (backend Redis nyata)');
  process.exit(0);
}

main().catch((e) => { console.error('ERR:', e); process.exit(1); });
