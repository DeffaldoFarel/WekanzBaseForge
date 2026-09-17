import { BaseService } from './baseService.js';
import type { FileOptions } from '../types.js';

export interface BucketUploadOptions {
  /** Optional determinate fileId (for migration from Appwrite/Firebase) */
  fileId?: string;
}

export interface BucketUploadResult {
  fileId: string;
  filename: string;
  contentType: string;
  size: number;
  url: string;
}

export class FilesService extends BaseService {
  /**
   * URL untuk file yang ter-attach ke record (field type file)
   */
  getUrl(
    collection: string,
    recordId: string,
    filename: string,
    options: FileOptions = {}
  ): string {
    const base = this.client.baseUrl.replace(/\/$/, '');
    const pid = encodeURIComponent(this.client.projectId);
    const col = encodeURIComponent(collection);
    const rid = encodeURIComponent(recordId);
    const file = encodeURIComponent(filename);

    let url = `${base}/api/files/${pid}/${col}/${rid}/${file}`;

    if (options.thumb) {
      url += `?thumb=${encodeURIComponent(options.thumb)}`;
    }

    return url;
  }

  // ─── M35: Bucket-style storage (decoupled from records) ─────────────────────

  /**
   * URL untuk bucket file (decoupled, ala Appwrite getFileView).
   *
   * @param fileId ID dari bucketUpload
   */
  getBucketUrl(fileId: string): string {
    const base = this.client.baseUrl.replace(/\/$/, '');
    const pid = encodeURIComponent(this.client.projectId);
    return `${base}/api/files/${pid}/bucket/${encodeURIComponent(fileId)}`;
  }

  /**
   * Upload file ke bucket → return fileId + URL.
   * Decoupled dari records — file punya ID sendiri, bisa dipakai di mana saja.
   *
   * @param file File/Blob dari input element
   * @param filename Nama file
   * @param options Optional fileId untuk determinate ID (migration)
   */
  async uploadToBucket(
    file: File | Blob,
    filename?: string,
    options: BucketUploadOptions = {}
  ): Promise<BucketUploadResult> {
    const name = filename ?? (file instanceof File ? file.name : 'file');
    const formData = new FormData();
    formData.append('file', file, name);
    if (options.fileId) {
      formData.append('fileId', options.fileId);
    }

    const path = `api/p/${this.client.projectId}/storage/upload`;
    const result = await this.request<BucketUploadResult>(path, {
      method: 'POST',
      body: formData,
    });
    return result;
  }

  /**
   * Hapus file dari bucket.
   * User biasa hanya bisa hapus file miliknya sendiri.
   */
  async deleteBucketFile(fileId: string): Promise<boolean> {
    const path = `api/p/${this.client.projectId}/storage/bucket/${encodeURIComponent(fileId)}`;
    const result = await this.request<{ ok: boolean }>(path, { method: 'DELETE' });
    return result.ok;
  }

  /**
   * List bucket files milik user yang sedang login.
   */
  async listBucketFiles(): Promise<Array<{
    fileId: string;
    filename: string;
    contentType: string;
    size: number;
    uploadedAt: string;
    uploadedBy: string | null;
  }>> {
    const path = `api/p/${this.client.projectId}/storage/bucket`;
    const result = await this.request<{ files: Array<{
      fileId: string;
      filename: string;
      contentType: string;
      size: number;
      uploadedAt: string;
      uploadedBy: string | null;
    }> }>(path);
    return result.files;
  }
}
