// ============================================================================
// M14b: TEST THUMBNAILS — parse format PocketBase + generate via Sharp
//
// PROOF yang dicari:
// 1. parseThumbSize: semua format valid + reject invalid
// 2. Generate thumb benar-benar menghasilkan gambar ukuran baru
// 3. Cache: generate kedua = baca disk (cepat), isi identik
// 4. isThumbable: hanya gambar; data.xyz → error ramah
// 5. deleteThumbs menghapus folder cache
// ============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';

import { parseThumbSize, isThumbable, getThumb, deleteThumbs } from '../src/core/thumbs.js';

const TEST_DIR = path.join(os.tmpdir(), 'baseforge-m14b-tests');
process.env.STORAGE_DIR = path.join(TEST_DIR, `storage-${Date.now()}`);

// Gambar test 200x100 (lebar 2x tinggi) via Sharp — deterministic!
async function makeTestImage(width = 200, height = 100, color = { r: 30, g: 144, b: 255 }): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
}

async function imageSize(buf: Buffer): Promise<{ width: number; height: number }> {
  const meta = await sharp(buf).metadata();
  return { width: meta.width ?? 0, height: meta.height ?? 0 };
}

describe('M14b: parseThumbSize (PocketBase format)', () => {
  test('M14b: format valid — 100x300, 100x300t/b/f, 0x300, 100x0', () => {
    assert.deepEqual(parseThumbSize('100x300'), { width: 100, height: 300, mode: '' });
    assert.deepEqual(parseThumbSize('100x300t'), { width: 100, height: 300, mode: 't' });
    assert.deepEqual(parseThumbSize('100x300b'), { width: 100, height: 300, mode: 'b' });
    assert.deepEqual(parseThumbSize('100x300f'), { width: 100, height: 300, mode: 'f' });
    assert.deepEqual(parseThumbSize('0x300'), { width: 0, height: 300, mode: '' });
    assert.deepEqual(parseThumbSize('100x0'), { width: 100, height: 0, mode: '' });
  });

  test('M14b: format invalid ditolak — abc, 0x0, 100, 100x, negatif', () => {
    assert.equal(parseThumbSize('abc'), null);
    assert.equal(parseThumbSize('0x0'), null);
    assert.equal(parseThumbSize('100'), null);
    assert.equal(parseThumbSize('100x'), null);
    assert.equal(parseThumbSize('-5x100'), null);
    assert.equal(parseThumbSize('100x300z'), null);
  });
});

describe('M14b: isThumbable', () => {
  test('M14b: hanya gambar yang didukung', () => {
    assert.equal(isThumbable('photo.JPG'), true);
    assert.equal(isThumbable('img.png'), true);
    assert.equal(isThumbable('anim.gif'), true);
    assert.equal(isThumbable('pic.webp'), true);
    assert.equal(isThumbable('doc.pdf'), false);
    assert.equal(isThumbable('data.xyz'), false);
    assert.equal(isThumbable('noext'), false);
  });
});

describe('M14b: getThumb (lazy generate + cache)', () => {
  test('M14b: 0x50 → tinggi 50, lebar proporsional (100)', async () => {
    const img = await makeTestImage(200, 100);
    const thumb = await getThumb('projT', 'rec1', 'photo.png', '0x50', img);
    const size = await imageSize(thumb);
    assert.equal(size.height, 50);
    assert.equal(size.width, 100, 'aspect ratio harus terjaga');
  });

  test('M14b: 50x0 → lebar 50, tinggi proporsional (25)', async () => {
    const img = await makeTestImage(200, 100);
    const thumb = await getThumb('projT', 'rec1', 'photo.png', '50x0', img);
    const size = await imageSize(thumb);
    assert.equal(size.width, 50);
    assert.equal(size.height, 25);
  });

  test('M14b: 40x40 → crop center jadi persegi', async () => {
    const img = await makeTestImage(200, 100);
    const thumb = await getThumb('projT', 'rec1', 'photo.png', '40x40', img);
    const size = await imageSize(thumb);
    assert.equal(size.width, 40);
    assert.equal(size.height, 40);
  });

  test('M14b: 40x40f → fit tanpa crop (40x20, preserve ratio)', async () => {
    const img = await makeTestImage(200, 100);
    const thumb = await getThumb('projT', 'rec1', 'photo.png', '40x40f', img);
    const size = await imageSize(thumb);
    assert.equal(size.width, 40);
    assert.equal(size.height, 20, 'fit: tinggi menyesuaikan ratio');
  });

  test('M14b: CACHE — request kedua menghasilkan bytes identik (baca disk)', async () => {
    const img = await makeTestImage(300, 300);
    const thumb1 = await getThumb('projC', 'rec2', 'avatar.jpg', '64x64', img);
    const thumb2 = await getThumb('projC', 'rec2', 'avatar.jpg', '64x64', img);
    assert.ok(thumb1.equals(thumb2), 'cache hit harus identik');

    // Verifikasi file cache benar-benar ada di disk
    const cachePath = path.join(process.env.STORAGE_DIR!, 'projC', 'thumbs_avatar.jpg', '64x64_avatar.jpg');
    assert.ok(fs.existsSync(cachePath), 'folder thumbs_<filename> harus ada');
  });

  test('M14b: thumbnail ukuran beda = file cache beda', async () => {
    const img = await makeTestImage(300, 300);
    const t1 = await getThumb('projC', 'rec2', 'avatar.jpg', '64x64', img);
    const t2 = await getThumb('projC', 'rec2', 'avatar.jpg', '32x32', img);
    const s1 = await imageSize(t1);
    const s2 = await imageSize(t2);
    assert.equal(s1.width, 64);
    assert.equal(s2.width, 32);
    // kedua cache ada
    assert.ok(fs.existsSync(path.join(process.env.STORAGE_DIR!, 'projC', 'thumbs_avatar.jpg', '64x64_avatar.jpg')));
    assert.ok(fs.existsSync(path.join(process.env.STORAGE_DIR!, 'projC', 'thumbs_avatar.jpg', '32x32_avatar.jpg')));
  });

  test('M14b: file non-gambar → error ramah (bukan crash)', async () => {
    await assert.rejects(
      () => getThumb('projT', 'rec1', 'data.xyz', '40x40', Buffer.from('bukan gambar')),
      /bukan gambar/
    );
  });

  test('M14b: format invalid → error dengan contoh', async () => {
    const img = await makeTestImage();
    await assert.rejects(
      () => getThumb('projT', 'rec1', 'photo.png', 'besar', img),
      /Invalid thumb format/
    );
  });

  test('M14b: deleteThumbs menghapus folder cache', async () => {
    const img = await makeTestImage(100, 100);
    await getThumb('projD', 'rec3', 'del.png', '32x32', img);
    const dir = path.join(process.env.STORAGE_DIR!, 'projD', 'thumbs_del.png');
    assert.ok(fs.existsSync(dir));

    deleteThumbs('projD', 'del.png');
    assert.equal(fs.existsSync(dir), false);
  });
});
