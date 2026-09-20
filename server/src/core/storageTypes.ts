// Shared types untuk storage (dipakai adapter + routes + dashboard)
export interface StoredFileInfo {
  name: string; // nama asli file
  recordId: string;
  storedName: string; // nama fisik: <recordId>_<filename>
  size: number;
  mtime: string;
  mime: string;
  isImage: boolean;
  collectionName: string | null;
  isOrphaned: boolean;
  /** M35: true bila file bucket (decoupled) — recordId = fileId di _bucket_files. */
  isBucket?: boolean;
}
