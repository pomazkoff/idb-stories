/**
 * [ИНТЕГРАЦИЯ] SIEM ИДБ (открытый вопрос №10). События безопасности (раздел 10.9) дополнительно
 * пишутся в структурированный лог с category=security — это основной канал до интеграции.
 */
export const SECURITY_EVENT_TYPES = [
  'auth.login',
  'auth.logout',
  'auth.failed',
  'access.denied',
  'csrf.failed',
  'cta.rejected',
  'media.rejected',
  'rate_limit.exceeded',
  'roles.changed',
  'user.status_changed',
  'allowlist.changed',
  'kill_switch.changed',
  'group.published',
  'group.unpublished',
  'four_eyes.violation',
  'customer_token.invalid',
] as const;
export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];

export interface SecurityEvent {
  type: SecurityEventType;
  ts: string;
  actorId?: string | null;
  ip?: string | null;
  requestId?: string | null;
  details?: Record<string, unknown>;
}

export interface SiemAdapter {
  readonly kind: string;
  send(event: SecurityEvent): Promise<void>;
}

export class MockSiemAdapter implements SiemAdapter {
  readonly kind = 'mock';
  readonly events: SecurityEvent[] = [];

  send(event: SecurityEvent): Promise<void> {
    this.events.push(event);
    if (this.events.length > 1000) this.events.shift();
    return Promise.resolve();
  }
}
