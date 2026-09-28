import type { StoryEvent } from '@idb-stories/schema';

/**
 * [ИНТЕГРАЦИЯ] Аналитика ИДБ (открытый вопрос №4). Вызывается из очереди с ретраями,
 * поэтому реализация должна быть идемпотентной по event_id.
 */
export interface AnalyticsAdapter {
  readonly kind: string;
  sendEvents(events: StoryEvent[]): Promise<void>;
}

export class MockAnalyticsAdapter implements AnalyticsAdapter {
  readonly kind = 'mock';
  readonly sent: StoryEvent[] = [];
  /** Для тестов ретраев: сколько следующих вызовов должно упасть. */
  failNext = 0;

  sendEvents(events: StoryEvent[]): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      return Promise.reject(new Error('mock analytics unavailable'));
    }
    this.sent.push(...events);
    // Буфер нужен только тестам; в долгоживущем dev-процессе не растёт бесконечно.
    if (this.sent.length > 10_000) this.sent.splice(0, this.sent.length - 10_000);
    return Promise.resolve();
  }
}
