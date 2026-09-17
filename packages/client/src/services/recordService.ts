import { BaseService } from './baseService.js';
import type { BaseForge } from '../client.js';
import type {
  RecordModel,
  ListResult,
  ListOptions,
  GetOneOptions,
} from '../types.js';
import { ClientResponseError } from '../types.js';

export class RecordService extends BaseService {
  readonly collectionName: string;

  constructor(client: BaseForge, collectionName: string) {
    super(client);
    this.collectionName = collectionName;
  }

  /** Path dasar endpoint koleksi */
  protected get basePath(): string {
    return `api/p/${this.client.projectId}/collections/${this.collectionName}/records`;
  }

  /**
   * Mengambil daftar record dengan pagination, sorting, filtering, & expand
   */
  async getList<T = RecordModel>(
    page = 1,
    perPage = 20,
    options: ListOptions = {}
  ): Promise<ListResult<T>> {
    const params: Record<string, unknown> = {
      page,
      perPage,
      sort: options.sort,
      filter: options.filter,
      search: options.search,
      expand: options.expand,
    };

    return this.request<ListResult<T>>(this.basePath, {
      method: 'GET',
      params,
      headers: options.headers,
    });
  }

  /**
   * Mengambil SELURUH record dalam koleksi (otomatis mem-page hingga selesai)
   */
  async getFullList<T = RecordModel>(
    batchSize = 200,
    options: Omit<ListOptions, 'page' | 'perPage'> = {}
  ): Promise<T[]> {
    let page = 1;
    const allItems: T[] = [];

    while (true) {
      const res = await this.getList<T>(page, batchSize, options);
      allItems.push(...res.items);
      if (res.page >= res.totalPages || res.items.length === 0) {
        break;
      }
      page++;
    }

    return allItems;
  }

  /**
   * Mengambil record pertama yang cocok dengan filter yang diberikan
   */
  async getFirstListItem<T = RecordModel>(
    filter: string,
    options: Omit<ListOptions, 'filter' | 'page' | 'perPage'> = {}
  ): Promise<T> {
    const res = await this.getList<T>(1, 1, { ...options, filter });
    if (!res.items || res.items.length === 0) {
      throw new ClientResponseError(404, `No record found matching filter: "${filter}"`, null, 'NOT_FOUND');
    }
    return res.items[0];
  }

  /**
   * Mengambil satu baris record berdasarkan ID
   */
  async getOne<T = RecordModel>(id: string, options: GetOneOptions = {}): Promise<T> {
    const res = await this.request<{ record: T }>(`${this.basePath}/${encodeURIComponent(id)}`, {
      method: 'GET',
      params: { expand: options.expand },
      headers: options.headers,
    });
    return res.record;
  }

  /**
   * Membuat record baru (menerima JSON object atau FormData untuk upload file).
   * M34: kalau data punya field `id`, server akan pakai itu sebagai document ID
   * (untuk migration dari Appwrite/PocketBase yang punya existing IDs).
   */
  async create<T = RecordModel>(data: Record<string, unknown> | FormData): Promise<T> {
    const res = await this.request<{ record: T }>(this.basePath, {
      method: 'POST',
      body: data as BodyInit,
    });
    return res.record;
  }

  /**
   * M34: Membuat record dengan custom document ID.
   * ID harus 1-64 karakter [a-zA-Z0-9_-]. Duplikat → 409 DOCUMENT_ID_TAKEN.
   */
  async createWithId<T = RecordModel>(
    id: string,
    data: Record<string, unknown>
  ): Promise<T> {
    return this.create<T>({ ...data, id });
  }

  /**
   * Mengubah record yang sudah ada
   */
  async update<T = RecordModel>(id: string, data: Record<string, unknown> | FormData): Promise<T> {
    const res = await this.request<{ record: T }>(`${this.basePath}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: data as BodyInit,
    });
    return res.record;
  }

  /**
   * Menghapus record berdasarkan ID
   */
  async delete(id: string): Promise<boolean> {
    await this.request(`${this.basePath}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    return true;
  }

  /**
   * Autentikasi ke Auth Collection menggunakan identity/email & password (PocketBase Parity)
   */
  async authWithPassword<T = RecordModel>(
    identity: string,
    password: string
  ): Promise<{ token: string; refreshToken?: string; record: T }> {
    const res = await this.request<{ token: string; refreshToken?: string; record: T }>(
      `api/p/${this.client.projectId}/collections/${this.collectionName}/auth-with-password`,
      {
        method: 'POST',
        body: { identity, password },
      }
    );
    this.client.authStore.save(res.token, res.refreshToken || '', res.record as unknown as import('../types.js').AuthUser);
    return res;
  }

  /**
   * Memperbarui token sesi pengguna saat ini
   */
  async authRefresh<T = RecordModel>(): Promise<{ token: string; refreshToken?: string; record: T }> {
    const res = await this.request<{ token: string; refreshToken?: string; record: T }>(
      `api/p/${this.client.projectId}/collections/${this.collectionName}/auth-refresh`,
      {
        method: 'POST',
      }
    );
    this.client.authStore.save(res.token, res.refreshToken || '', res.record as unknown as import('../types.js').AuthUser);
    return res;
  }
}
