import { BaseService } from './baseService.js';
import type { FileOptions } from '../types.js';

export class FilesService extends BaseService {
  /**
   * Menghasilkan URL publik untuk file yang di-upload
   *
   * @param collection Nama koleksi tabel
   * @param recordId ID record pemilik file
   * @param filename Nama file yang tersimpan
   * @param options Opsi thumbnail (misal { thumb: '100x100' })
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
}
