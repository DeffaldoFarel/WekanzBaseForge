import type { AuthStore, ClientOptions } from './types.js';
import { createDefaultAuthStore } from './authStore.js';
import { AuthService } from './services/authService.js';
import { RecordService } from './services/recordService.js';
import { FilesService } from './services/filesService.js';
import { FunctionsService } from './services/functionsService.js';
import { RealtimeService } from './services/realtimeService.js';

export class BaseForge {
  baseUrl: string;
  projectId: string;
  authStore: AuthStore;

  readonly auth: AuthService;
  readonly files: FilesService;
  readonly functions: FunctionsService;
  readonly realtime: RealtimeService;

  protected recordServices: Map<string, RecordService> = new Map();

  constructor(options: ClientOptions | string = {}) {
    if (typeof options === 'string') {
      this.baseUrl = options;
      this.projectId = '';
      this.authStore = createDefaultAuthStore();
    } else {
      this.baseUrl = options.baseUrl || 'http://localhost:5100';
      this.projectId = options.projectId || '';
      this.authStore = options.authStore || createDefaultAuthStore();
    }

    this.auth = new AuthService(this);
    this.files = new FilesService(this);
    this.functions = new FunctionsService(this);
    this.realtime = new RealtimeService(this);
  }

  /**
   * Mengatur atau mengganti ID Project yang ditargetkan
   */
  setProject(projectId: string): this {
    this.projectId = projectId;
    this.recordServices.clear();
    return this;
  }

  /**
   * Mengakses layanan CRUD untuk koleksi tabel tertentu
   *
   * @param name Nama koleksi tabel
   */
  collection(name: string): RecordService {
    let service = this.recordServices.get(name);
    if (!service) {
      service = new RecordService(this, name);
      this.recordServices.set(name, service);
    }
    return service;
  }
}
