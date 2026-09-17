# M29 — Vector Search: Embeddings & Similarity

## Apa yang kupikirkan sebelumnya

Vector search = pgvector = native C extension = harus pakai sqlite-vec. Tanpa
binary native, BaseForge tidak bisa bersaing di era AI. Kubayangkan harus
compile C++, cross-platform build matrix, dan loadExtension API yang belum
stabil di node:sqlite.

## Apa yang ternyata benar

**Vector search adalah MATEMATIKA + API DESIGN, bukan ekstensi native.**
Cosine similarity: dot product / (norm × norm). L2: Pythagoras. Top-k:
partial sort. Seluruh "vector database" untuk < 50K vectors adalah 60 baris
JavaScript. Ekstensi native (sqlite-vec, Faiss, HNSW) diperlukan hanya saat
brute-force scan terlalu lambat — dan itu adalah MASALAH PERFORMA, bukan
MASALAH FUNGSIONALITAS.

Desain API-nya yang sulit: field type, endpoint, pre-filter integration,
security parity. Semuanya bisa dibangun dan dites HARI INI dengan pure JS.
Swap ke sqlite-vec nanti = ganti internal engine, API tetap.

## Aha! moment

**1. `![] === false` — JavaScript empty array is truthy.**
Bug klasik yang menelan 30 menit debugging: `validateVector` mengembalikan
`[]` untuk input invalid, dan check `if (!queryVector)` TIDAK PERNAH fire
karena `![]` adalah `false`. Query vector kosong lolos validasi, scan
berjalan dengan vector kosong, similarity selalu 0, API mengembalikan 200
 dengan hasil kosong. Fix: `queryVector.length === 0`. Pelajaran: **function
yang mengembalikan array untuk error harus diperiksa dengan `.length`, bukan
truthiness** — atau lebih baik: return `null` untuk error.

**2. Security parity dengan aggregate M19 — similarity membocorkan data.**
Test "private_vec" (listRule null) mengembalikan 0 hasil untuk anonymous.
Ini SAMA PERTIMBANGAN dengan aggregate: bahkan tanpa membaca record,
similarity score sudah membocorkan informasi ("record ini mirip dengan query
Anda"). listRule dievaluasi SEBELUM scan — bukan setelah ranking.

**3. Pre-filter + vector search = composability yang menang.**
`filter: "category = 'tech'"` sebelum similarity scan — filter M04 (lexer/
parser/AST dari M04!) compose dengan vector search tanpa perubahan apa pun
di parser. Inilah keuntungan arsitektur yang modular sejak awal.

**4. Storage: JSON string di TEXT column.**
Embedding `[0.1, 0.2, 0.3]` disimpan sebagai `'{"0":0.1,"1":0.2,...}'`... 
TIDAK — disimpan sebagai `'[0.1, 0.2, 0.3]'` (JSON array). SQLite TEXT
column, parse saat scan. Swap ke sqlite-vec: buat vec0 virtual table
TERPISAH (bukan ubah kolom) + sync trigger. Kolom TEXT tetap untuk
kompatibilitas API (deserialize ke array).

## Keputusan yang dipertahankan

- **Cosine sebagai default** — industri embedding (OpenAI, Cohere) menghasilkan
  vektor ternormalisasi; cosine = dot product untuk vektor ternormalisasi.
- **k max 100** — mencegah "SELECT *" equivalent di vector search.
- **minScore opsional** — RAG pipelines sering butuh threshold (0.7+) untuk
  memangkas konteks yang tidak relevan.
- **Metric L2 tersedia** — beberapa model (Sentence-BERT tertentu) memakai
  L2 distance. Skor dikonversi `1/(1+d)` agar higher=better (konsisten ranking).

## Pertanyaan yang masih tersisa

- sqlite-vec integration: buat vec0 virtual table + sync trigger saat
  `node:sqlite.loadExtension` stabil → brute-force JS jadi fallback
- ANN index (HNSW/IVF): untuk 100K+ vectors, approximate nearest neighbor
  diperlukan — tapi API TIDAK BERUBAH
- Embedding generation: `$http.send` (M25) sudah bisa panggil OpenAI
  embeddings API dari function — tinggal buat helper function bawaan
- Hybrid search (BM25 + vector): gabungkan FTS5 score dan cosine score
