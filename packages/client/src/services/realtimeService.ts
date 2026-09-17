import { BaseService } from './baseService.js';
import type { RealtimeListener, RealtimeEvent, RecordModel } from '../types.js';

/** Emitted saat SSE reconnects — adapter bisa re-fetch initial data */
export type ReconnectListener = () => void;

// ─── Reconnect constants ─────────────────────────────────────────────────────

const INITIAL_RETRY_MS = 1000;     // 1 detik
const MAX_RETRY_MS = 30_000;       // 30 detik
const BACKOFF_MULTIPLIER = 2;       // exponential: 1s → 2s → 4s → 8s → 16s → 30s (capped)

export class RealtimeService extends BaseService {
  protected eventSource: EventSource | null = null;
  protected clientId: string | null = null;
  protected listeners: Map<string, Set<RealtimeListener<never>>> = new Map();
  protected connectPromise: Promise<string> | null = null;

  // M36: reconnect state
  protected reconnectListeners = new Set<ReconnectListener>();
  protected retryCount = 0;
  protected reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  protected manuallyClosed = false;

  /**
   * M36: Register callback yang dipanggil SETELAH SSE reconnect sukses.
   * Adapter bisa pakai ini untuk re-fetch initial data (karena delta yang
   * terlewat saat disconnect tidak bisa di-recover).
   */
  onReconnect(listener: ReconnectListener): () => void {
    this.reconnectListeners.add(listener);
    return () => this.reconnectListeners.delete(listener);
  }

  /**
   * M36: Apakah SSE sedang connected?
   */
  get isConnected(): boolean {
    return this.clientId !== null && this.eventSource !== null;
  }

  /**
   * M36: Jumlah retry attempts sejak disconnect terakhir.
   */
  get reconnectAttempts(): number {
    return this.retryCount;
  }

  // ─── Core: buka koneksi SSE ─────────────────────────────────────────────────

  protected async connect(): Promise<string> {
    if (this.clientId) return this.clientId;
    if (this.connectPromise) return this.connectPromise;

    this.manuallyClosed = false;

    this.connectPromise = new Promise((resolve, reject) => {
      const url = `${this.client.baseUrl.replace(/\/$/, '')}/api/p/${this.client.projectId}/realtime`;

      const EventSourceCtor =
        (typeof window !== 'undefined' ? window.EventSource : (globalThis as unknown as { EventSource?: typeof EventSource }).EventSource);

      if (!EventSourceCtor) {
        reject(new Error('EventSource is not supported in this runtime environment'));
        return;
      }

      const es = new EventSourceCtor(url);
      this.eventSource = es;

      es.addEventListener('PB_CONNECT', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          this.clientId = data.clientId;
          this.connectPromise = null;
          this.retryCount = 0;
          this.clearReconnectTimer();
          resolve(this.clientId!);
        } catch (err) {
          reject(err);
        }
      });

      // Handle CRUD Events
      const handleEvent = (action: 'create' | 'update' | 'delete') => (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          const record = (action === 'delete' ? data : data) as RecordModel;
          const collection = (e as unknown as { originCollection?: string }).originCollection;
          this.dispatch(action, record, collection);
        } catch (err) {
          console.error(`Error parsing ${action} realtime event:`, err);
        }
      };

      es.addEventListener('PB_CREATE', handleEvent('create'));
      es.addEventListener('PB_UPDATE', handleEvent('update'));
      es.addEventListener('PB_DELETE', handleEvent('delete'));

      // M36: SSE error handler — auto-reconnect jika sudah connected
      es.onerror = () => {
        if (!this.clientId) {
          // Initial connect gagal → reject (caller bisa retry via subscribe)
          this.connectPromise = null;
          reject(new Error('SSE connection failed'));
          return;
        }

        // ── M36: AUTO-RECONNECT ──
        // Koneksi drop SETELAH connected → reconnect dengan exponential backoff
        this.handleDisconnect();
      };
    });

    return this.connectPromise;
  }

  // ─── M36: Reconnect logic ─────────────────────────────────────────────────

  /**
   * Dipanggil saat SSE connection drop setelah berhasil connect.
   * Menutup EventSource, reset state, dan schedule reconnect.
   */
  protected handleDisconnect(): void {
    if (this.manuallyClosed) return; // unsubscribe → close → jangan reconnect

    // Tutup EventSource yang mati
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.clientId = null;
    this.connectPromise = null;

    // Schedule reconnect
    this.scheduleReconnect();
  }

  /**
   * Schedule reconnect dengan exponential backoff.
   * Delay = min(initial * multiplier^retry, max)
   */
  protected scheduleReconnect(): void {
    this.clearReconnectTimer();

    const delay = Math.min(
      INITIAL_RETRY_MS * Math.pow(BACKOFF_MULTIPLIER, this.retryCount),
      MAX_RETRY_MS
    );

    console.warn(
      `[realtime] connection lost — reconnecting in ${delay}ms (attempt ${this.retryCount + 1})`
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.reconnect();
      } catch (err) {
        // Reconnect gagal → retry lagi dengan backoff yang lebih panjang
        console.error('[realtime] reconnect failed:', err);
        this.retryCount++;
        this.scheduleReconnect();
      }
    }, delay);
  }

  /**
   * Reconnect: buka koneksi SSE baru + re-sync semua subscriptions.
   * Dipanggil oleh scheduleReconnect.
   */
  protected async reconnect(): Promise<void> {
    if (this.manuallyClosed || this.listeners.size === 0) return;

    // Buka koneksi baru
    const newClientId = await this.connect();

    // Re-sync semua subscriptions yang masih aktif
    await this.syncSubscriptions(newClientId);

    // Reset retry count
    this.retryCount = 0;

    // Notify reconnect listeners (adapter bisa re-fetch)
    for (const listener of this.reconnectListeners) {
      try {
        listener();
      } catch (err) {
        console.error('[realtime] reconnect listener error:', err);
      }
    }

    console.log('[realtime] reconnected successfully');
  }

  protected clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ─── Dispatch + Subscribe (tetap sama) ───────────────────────────────────

  protected dispatch(action: 'create' | 'update' | 'delete', record: RecordModel, collection?: string): void {
    const event: RealtimeEvent<RecordModel> = { action, record };

    for (const [topic, set] of this.listeners.entries()) {
      const [topicCol, topicId] = topic.split('/');

      const matchesCol = !collection || topicCol === '*' || topicCol === collection;
      const matchesId = topicId === '*' || topicId === record.id;

      if (matchesCol && matchesId) {
        for (const listener of set) {
          try {
            listener(event as never);
          } catch (listenerErr) {
            console.error('Realtime listener error:', listenerErr);
          }
        }
      }
    }
  }

  async subscribe<T = RecordModel>(
    topic: string,
    listener: RealtimeListener<T>
  ): Promise<() => Promise<void>> {
    // 1. Simpan listener
    const current = this.listeners.get(topic) ?? new Set();
    current.add(listener as RealtimeListener<never>);
    this.listeners.set(topic, current);

    // 2. Buka koneksi jika belum ada (jika sedang reconnect, connect() akan retry)
    const clientId = await this.connect();

    // 3. Daftarkan subscriptions ke server
    await this.syncSubscriptions(clientId);

    // 4. Return fungsi unsubscribe
    return async () => {
      await this.unsubscribe(topic, listener as RealtimeListener<never>);
    };
  }

  async unsubscribe(topic?: string, listener?: RealtimeListener<never>): Promise<void> {
    if (!topic) {
      this.listeners.clear();
    } else if (listener) {
      const set = this.listeners.get(topic);
      if (set) {
        set.delete(listener);
        if (set.size === 0) this.listeners.delete(topic);
      }
    } else {
      this.listeners.delete(topic);
    }

    if (this.clientId) {
      await this.syncSubscriptions(this.clientId);
    }

    // M36: hanya close jika SEMUA listener sudah unsubscribe
    // dan tidak ada reconnect timer pending
    if (this.listeners.size === 0 && this.eventSource) {
      this.manuallyClosed = true;
      this.clearReconnectTimer();
      this.eventSource.close();
      this.eventSource = null;
      this.clientId = null;
      this.retryCount = 0;
    }
  }

  protected async syncSubscriptions(clientId: string): Promise<void> {
    const subscriptions = Array.from(this.listeners.keys());
    await this.request(`api/p/${this.client.projectId}/realtime`, {
      method: 'POST',
      body: { clientId, subscriptions },
    });
  }
}
