import type { StoryEvent } from '@idb-stories/schema';

export const EVENTS_BATCH_MAX = 50;
export const EVENTS_FLUSH_MS = 5000;
// Лимит тела запроса на сервере — 64 КБ; keepalive-запросы в браузерах ограничены тем же объёмом.
const KEEPALIVE_MAX_BYTES = 60 * 1024;
const QUEUE_MAX = 500;

/**
 * Очередь событий: батчи до 50 штук (раздел 5.2), отправка раз в ~5 с, при заполнении батча
 * и при уходе со страницы (pagehide / скрытие вкладки) через navigator.sendBeacon.
 * Повторных попыток нет: потеря части аналитики допустима, флуд — нет (T8).
 */
export class EventTransport {
  private queue: StoryEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly onPageHide = () => this.flush(true);
  private readonly onVisibility = () => {
    if (document.visibilityState === 'hidden') this.flush(true);
  };

  constructor(private readonly endpoint: string) {
    window.addEventListener('pagehide', this.onPageHide);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  push(event: StoryEvent): void {
    this.queue.push(event);
    if (this.queue.length > QUEUE_MAX) this.queue.splice(0, this.queue.length - QUEUE_MAX);
    if (this.queue.length >= EVENTS_BATCH_MAX) this.flush(false);
    else this.timer ??= setTimeout(() => this.flush(false), EVENTS_FLUSH_MS);
  }

  flush(unloading: boolean): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.queue.length > 0) {
      this.send(this.queue.splice(0, EVENTS_BATCH_MAX), unloading);
    }
  }

  destroy(): void {
    this.flush(true);
    window.removeEventListener('pagehide', this.onPageHide);
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  private send(events: StoryEvent[], unloading: boolean): void {
    const body = JSON.stringify({ events });
    if (
      unloading &&
      typeof navigator !== 'undefined' &&
      typeof navigator.sendBeacon === 'function'
    ) {
      // text/plain — CORS-safelisted тип: beacon уходит без preflight на API другого origin.
      try {
        if (
          navigator.sendBeacon(
            this.endpoint,
            new Blob([body], { type: 'text/plain;charset=UTF-8' }),
          )
        ) {
          return;
        }
      } catch {
        // упадём в fetch ниже
      }
    }
    if (typeof fetch !== 'function') return;
    try {
      fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        credentials: 'omit',
        keepalive: body.length <= KEEPALIVE_MAX_BYTES,
      }).catch(() => undefined);
    } catch {
      // сеть недоступна — событие теряется
    }
  }
}
