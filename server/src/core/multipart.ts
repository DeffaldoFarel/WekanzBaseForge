// ============================================================================
// M14: MULTIPART PARSER — dari nol, Buffer-based
//
// multipart/form-data adalah format yang dipakai browser untuk upload file.
// Struktur body:
//
//   --BOUNDARY\r\n
//   Content-Disposition: form-data; name="title"\r\n
//   \r\n
//   nilai teks\r\n
//   --BOUNDARY\r\n
//   Content-Disposition: form-data; name="doc"; filename="a.pdf"\r\n
//   Content-Type: application/pdf\r\n
//   \r\n
//   <bytes binary>\r\n
//   --BOUNDARY--\r\n
//
// Kita parse dari BUFFER (bukan string!) karena file adalah bytes binary —
// mengubah ke utf-8 akan merusaknya.
// ============================================================================

export interface MultipartFile {
  fieldName: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface MultipartResult {
  fields: Record<string, string>;      // field teks
  files: MultipartFile[];              // semua file
}

// Ekstrak boundary dari header Content-Type
// Contoh: multipart/form-data; boundary=----WebKitFormBoundaryABC123
export function extractBoundary(contentType: string): string | null {
  const match = contentType.match(/boundary="?([^";]+)"?/i);
  return match ? match[1] : null;
}

export function parseMultipart(body: Buffer, boundary: string): MultipartResult {
  const result: MultipartResult = { fields: {}, files: [] };

  const delimiter = Buffer.from(`--${boundary}`);
  const CRLF = Buffer.from('\r\n');

  // Posisi awal: cari delimiter pertama
  let pos = body.indexOf(delimiter);
  if (pos === -1) throw new Error('Malformed multipart: boundary tidak ditemukan');

  while (pos !== -1) {
    pos += delimiter.length;

    // Cek apakah ini bagian terakhir: "--BOUNDARY--"
    if (body.slice(pos, pos + 2).toString() === '--') break;

    // Lewati \r\n setelah delimiter
    if (body.slice(pos, pos + 2).toString() === '\r\n') pos += 2;

    // ── Baca HEADERS bagian ini (sampai \r\n\r\n) ──
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), pos);
    if (headerEnd === -1) break;

    const headerText = body.slice(pos, headerEnd).toString('utf-8');
    const contentStart = headerEnd + 4;

    // ── Baca CONTENT (sampai delimiter berikutnya, mundur \r\n) ──
    const nextDelimiter = body.indexOf(delimiter, contentStart);
    if (nextDelimiter === -1) break; // malformed — bagian tak ditutup
    const contentEnd = nextDelimiter - 2; // mundur \r\n sebelum delimiter
    const content = body.slice(contentStart, contentEnd);

    // ── Parse header Content-Disposition ──
    const nameMatch = headerText.match(/name="([^"]*)"/i);
    const fileMatch = headerText.match(/filename="([^"]*)"/i);
    const typeMatch = headerText.match(/content-type:\s*([^\r\n]+)/i);

    const fieldName = nameMatch ? nameMatch[1] : '';

    if (fileMatch) {
      // Ini FILE
      result.files.push({
        fieldName,
        filename: sanitizeFilename(fileMatch[1]),
        contentType: typeMatch ? typeMatch[1].trim() : 'application/octet-stream',
        data: content,
      });
    } else if (fieldName) {
      // Ini FIELD TEKS
      result.fields[fieldName] = content.toString('utf-8');
    }

    pos = nextDelimiter;
  }

  return result;
}

// ─── Sanitasi filename — PERTAHANAN #1 terhadap path traversal ──────────────
// Attacker bisa kirim filename="../../etc/passwd" — kita buang semua path.
export function sanitizeFilename(raw: string): string {
  // Ambil nama file saja (buang direktori, handle / dan \ untuk Windows)
  const base = raw.split(/[/\\]/).pop() ?? 'file';
  // Buang karakter berbahaya; izinkan alfanumerik, titik, dash, underscore
  const clean = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  // Hindari ".hidden" & nama kosong
  if (clean === '' || clean === '.' || clean === '..') return 'file';
  return clean.slice(0, 150); // batasi panjang
}
