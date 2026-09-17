// ============================================================================
// M30: S3 CLIENT — AWS Signature V4 + S3 REST API via native fetch
//
// Zero dependency: node:crypto untuk HMAC-SHA256, fetch untuk HTTP.
// Kompatibel dengan: AWS S3, Cloudflare R2, MinIO, DO Spaces, Backblaze B2.
//
// AWS Signature V4 (RFC untuk signing):
//   1. CanonicalRequest = Method + URI + Query + Headers + PayloadHash
//   2. StringToSign = Algorithm + Date + Scope + Hash(CanonicalRequest)
//   3. SigningKey = HMAC chain (secret → date → region → service → "aws4_request")
//   4. Signature = HexEncode(HMAC(SigningKey, StringToSign))
//
// Layout S3: s3://<bucket>/<projectId>/<recordId>_<filename>
// (mirror layout lokal: <storageRoot>/<projectId>/<recordId>_<filename>)
// ============================================================================

import crypto from 'node:crypto';

// ─── Konfigurasi ──────────────────────────────────────────────────────────────

export interface S3Config {
  endpoint: string;      // e.g. https://s3.amazonaws.com or https://<account>.r2.cloudflarestorage.com
  region: string;        // e.g. us-east-1, auto (R2)
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** opsional: prefix path dalam bucket (untuk shared bucket) */
  prefix?: string;
}

// ─── AWS Signature V4 ─────────────────────────────────────────────────────────

function hmac(key: crypto.BinaryLike | crypto.KeyObject, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function getAmzDate(): { amzDate: string; dateStamp: string } {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, ''); // 20260917T123456Z
  const dateStamp = amzDate.slice(0, 8); // 20260917
  return { amzDate, dateStamp };
}

/**
 * Sign request AWS Signature V4 dan return headers untuk fetch().
 * Ini jantung S3 auth — 30 baris crypto yang menjuta-juta operasi/hari di AWS.
 */
export function signS3Request(
  config: S3Config,
  method: string,
  key: string,
  payload: Buffer | null,
  extraHeaders?: Record<string, string>
): { url: string; headers: Record<string, string> } {
  const { amzDate, dateStamp } = getAmzDate();
  const payloadHash = payload ? sha256Hex(payload) : sha256Hex('');

  // Canonical URI: /<bucket>/<key> (path-style) atau /<key> (virtual-host)
  // Path-style lebih universal (MinIO/R2 memerlukannya)
  const canonicalUri = `/${config.bucket}/${config.prefix ? config.prefix + '/' : ''}${key}`;

  // Canonical headers (MUST sorted)
  const headers: Record<string, string> = {
    host: new URL(config.endpoint).host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...extraHeaders,
  };
  const sortedKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${headers[k]}\n`).join('');
  const signedHeaders = sortedKeys.join(';');

  // Canonical request
  const canonicalRequest = [
    method,
    canonicalUri,
    '', // no query string for basic ops
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  // Credential scope
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;

  // String to sign
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  // Signing key (HMAC chain)
  const kDate = hmac(`AWS4${config.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, config.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');

  // Signature
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  // Authorization header
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const url = `${config.endpoint.replace(/\/$/, '')}${canonicalUri}`;

  return {
    url,
    headers: {
      ...headers,
      Authorization: authorization,
    },
  };
}

// ─── S3 OPERATIONS (semua via fetch) ─────────────────────────────────────────

export interface S3Object {
  key: string;
  size: number;
  lastModified: string;
  etag: string;
}

/** PUT object (save file). Return true jika sukses. */
export async function s3Put(
  config: S3Config,
  key: string,
  data: Buffer,
  contentType?: string
): Promise<boolean> {
  const extra: Record<string, string> = {};
  if (contentType) extra['content-type'] = contentType;

  const { url, headers } = signS3Request(config, 'PUT', key, data, extra);
  const res = await fetch(url, {
    method: 'PUT',
    headers,
    body: new Uint8Array(data),
  });
  return res.ok;
}

/** GET object (read file). Return Buffer atau null jika tidak ada. */
export async function s3Get(config: S3Config, key: string): Promise<Buffer | null> {
  const { url, headers } = signS3Request(config, 'GET', key, null);
  const res = await fetch(url, { method: 'GET', headers });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`S3 GET failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}

/** DELETE object. Idempotent (204 atau 404 keduanya OK). */
export async function s3Delete(config: S3Config, key: string): Promise<void> {
  const { url, headers } = signS3Request(config, 'DELETE', key, null);
  const res = await fetch(url, { method: 'DELETE', headers });
  // S3 DELETE selalu 204 (bahkan jika object tidak ada) — idempotent
  if (!res.ok && res.status !== 404) {
    throw new Error(`S3 DELETE failed: ${res.status}`);
  }
}

/**
 * LIST objects dengan prefix (untuk storage explorer).
 * Menggunakan GET /<bucket>?list-type=2&prefix=<prefix> — query string signing.
 */
export async function s3List(config: S3Config, prefix: string): Promise<S3Object[]> {
  const { amzDate, dateStamp } = getAmzDate();
  const payloadHash = sha256Hex('');

  const fullPrefix = `${config.prefix ? config.prefix + '/' : ''}${prefix}`;
  const canonicalUri = `/${config.bucket}`;
  const queryString = `list-type=2&prefix=${encodeURIComponent(fullPrefix)}`;

  const headers: Record<string, string> = {
    host: new URL(config.endpoint).host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  const sortedKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${headers[k]}\n`).join('');
  const signedHeaders = sortedKeys.join(';');

  const canonicalRequest = [
    'GET',
    canonicalUri,
    queryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${config.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, config.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const url = `${config.endpoint.replace(/\/$/, '')}${canonicalUri}?${queryString}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { ...headers, Authorization: authorization },
  });

  if (!res.ok) {
    throw new Error(`S3 LIST failed: ${res.status}`);
  }

  // Parse XML response (ListBucketResult)
  const xml = await res.text();
  const objects: S3Object[] = [];

  // Simple XML parsing (tanpa dependency — regex untuk <Contents> blocks)
  const contents = xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? [];
  for (const block of contents) {
    const key = block.match(/<Key>([^<]+)<\/Key>/)?.[1] ?? '';
    const size = parseInt(block.match(/<Size>([^<]+)<\/Size>/)?.[1] ?? '0', 10);
    const lastModified = block.match(/<LastModified>([^<]+)<\/LastModified>/)?.[1] ?? '';
    const etag = block.match(/<ETag>([^<]+)<\/ETag>/)?.[1] ?? '';
    if (key) objects.push({ key, size, lastModified, etag });
  }
  return objects;
}

/** Health check: HEAD bucket. */
export async function s3HeadBucket(config: S3Config): Promise<boolean> {
  const { url, headers } = signS3Request(config, 'HEAD', '', null);
  const res = await fetch(url, { method: 'HEAD', headers });
  return res.ok;
}
