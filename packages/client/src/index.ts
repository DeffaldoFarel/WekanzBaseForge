// ============================================================================
// @wekanz/baseforge — Official TypeScript Client SDK
// ============================================================================

export { BaseForge } from './client.js';
export { BaseService } from './services/baseService.js';
export { AuthService } from './services/authService.js';
export { RecordService } from './services/recordService.js';
export { FilesService } from './services/filesService.js';
export { FunctionsService } from './services/functionsService.js';
export { RealtimeService } from './services/realtimeService.js';

export {
  MemoryAuthStore,
  LocalStorageAuthStore,
  createDefaultAuthStore,
} from './authStore.js';

export {
  ClientResponseError,
  type AuthUser,
  type AuthResponse,
  type TokenPair,
  type RecordModel,
  type ListResult,
  type ListOptions,
  type GetOneOptions,
  type FileOptions,
  type ClientOptions,
  type RealtimeEvent,
  type RealtimeListener,
  type AuthStore,
} from './types.js';
