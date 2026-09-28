/**
 * [ИНТЕГРАЦИЯ] Сброс кеша CDN (раздел 5.1, 10.8). Цель — применить снятие с публикации
 * и kill switch быстрее 60 секунд. Даже без purge ответы ленты живут в CDN не дольше ttl_sec ≤ 60.
 */
export interface CdnPurgeRequest {
  /** Пути относительно хоста публичного API, например `/v1/feed`. */
  paths: string[];
  reason: string;
}

export interface CdnPurgeAdapter {
  readonly kind: string;
  purge(request: CdnPurgeRequest): Promise<void>;
}

export class MockCdnPurgeAdapter implements CdnPurgeAdapter {
  readonly kind = 'mock';
  readonly calls: CdnPurgeRequest[] = [];

  purge(request: CdnPurgeRequest): Promise<void> {
    this.calls.push(request);
    if (this.calls.length > 1000) this.calls.shift();
    return Promise.resolve();
  }
}
