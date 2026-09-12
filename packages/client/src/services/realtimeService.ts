import { BaseService } from './baseService.js';
import type { RealtimeListener, RealtimeEvent, RecordModel } from '../types.js';

export class RealtimeService extends BaseService {
  protected eventSource: EventSource | null = null;
  protected clientId: string | null = null;
  protected listeners: Map<string, Set<RealtimeListener<never>>> = new Map();
  protected connectPromise: Promise<string> | null = null;

  /**
   * Membuka koneksi SSE ke server (jika belum terbuka)
   */
  protected async connect(): Promise<string> {
    if (this.clientId) return this.clientId;
    if (this.connectPromise) return this.connectPromise;

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

      es.onerror = (err) => {
        if (!this.clientId) {
          this.connectPromise = null;
          reject(err);
        }
      };
    });

    return this.connectPromise;
  }

  protected dispatch(action: 'create' | 'update' | 'delete', record: RecordModel, collection?: string): void {
    const event: RealtimeEvent<RecordModel> = { action, record };

    for (const [topic, set] of this.listeners.entries()) {
      const [topicCol, topicId] = topic.split('/');

      // Cocokkan wildcard: 'posts/*' cocok dengan semua post
      // Atau spesifik: 'posts/rec_123' cocok dengan id itu
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

  /**
   * Berlangganan event pada topik tertentu (misal 'posts/*' atau 'posts/id_123')
   */
  async subscribe<T = RecordModel>(
    topic: string,
    listener: RealtimeListener<T>
  ): Promise<() => Promise<void>> {
    // 1. Simpan listener
    const current = this.listeners.get(topic) ?? new Set();
    current.add(listener as RealtimeListener<never>);
    this.listeners.set(topic, current);

    // 2. Buka koneksi jika belum ada
    const clientId = await this.connect();

    // 3. Daftarkan subscriptions ke server
    await this.syncSubscriptions(clientId);

    // 4. Return fungsi unsubscribe
    return async () => {
      await this.unsubscribe(topic, listener as RealtimeListener<never>);
    };
  }

  /**
   * Berhenti berlangganan dari topik
   */
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

    if (this.listeners.size === 0 && this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
      this.clientId = null;
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
