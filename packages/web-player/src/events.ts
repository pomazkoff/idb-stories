import type { StoryEvent } from '@idb-stories/schema';
import type { Placement } from './types.js';

export type EventName = StoryEvent['event'];
export type EventOf<N extends EventName> = Extract<StoryEvent, { event: N }>;
type CommonKeys =
  'event' | 'event_id' | 'ts' | 'session_id' | 'platform' | 'app_version' | 'placement';
export type EventFields<N extends EventName> = Omit<EventOf<N>, CommonKeys>;

const HEX = '0123456789abcdef';

/** UUID v4. crypto.randomUUID есть только в secure context — иначе собираем из getRandomValues. */
export function uuidV4(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  // nosemgrep: ajinabraham.njsscan.crypto.crypto_node.node_insecure_random_generator
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  let out = '';
  for (let i = 0; i < 16; i++) {
    const b = bytes[i] ?? 0;
    out += (HEX[b >> 4] ?? '0') + (HEX[b & 15] ?? '0');
    if (i === 3 || i === 5 || i === 7 || i === 9) out += '-';
  }
  return out;
}

let pageSessionId: string | null = null;

function isoNow(now: () => number): string {
  const t = now();
  return new Date(Number.isFinite(t) ? t : Date.now()).toISOString();
}

/** Сессия по умолчанию — случайный идентификатор на загрузку страницы. */
export function defaultSessionId(): string {
  pageSessionId ??= uuidV4();
  return pageSessionId;
}

export interface EmitterConfig {
  placement: Placement;
  sessionId: string;
  appVersion: string;
  now: () => number;
  sinks: ((event: StoryEvent) => void)[];
}

export type Emit = <N extends EventName>(name: N, fields: EventFields<N>) => void;

/**
 * Собирает событие с общими полями раздела 9. Идентификатор пользователя сюда не попадает
 * никогда: у плеера его просто нет.
 */
export function createEmitter(config: EmitterConfig): Emit {
  const sessionId = config.sessionId.slice(0, 128) || defaultSessionId();
  const appVersion = config.appVersion.slice(0, 32);
  return (name, fields) => {
    const event = {
      event_id: uuidV4(),
      event: name,
      ts: isoNow(config.now),
      session_id: sessionId,
      platform: 'web',
      app_version: appVersion,
      placement: config.placement,
      ...fields,
    } as unknown as StoryEvent;
    for (const sink of config.sinks) {
      try {
        sink(event);
      } catch (err) {
        // Ошибка в обработчике хоста не должна ломать плеер.
        console.error('[idb-stories] onEvent failed', err);
      }
    }
  };
}
