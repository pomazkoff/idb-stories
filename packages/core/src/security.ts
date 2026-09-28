import type { SecurityEventType, SiemAdapter } from '@idb-stories/adapters';
import type { Logger } from './logger.js';
import { securityEventsTotal } from './metrics.js';

export interface SecurityEventData {
  actorId?: string | null;
  ip?: string | null;
  requestId?: string | null;
  details?: Record<string, unknown>;
}

/**
 * События безопасности (раздел 10.9): отдельная категория логов (category=security)
 * и отправка в SIEM через адаптер. Сбой SIEM не ломает основной запрос.
 */
export class SecurityLog {
  constructor(
    private readonly logger: Logger,
    private readonly siem: SiemAdapter,
  ) {}

  emit(type: SecurityEventType, data: SecurityEventData = {}): void {
    const event = { type, ts: new Date().toISOString(), ...data };
    securityEventsTotal.inc({ type });
    this.logger.warn({ category: 'security', securityEvent: event }, `security: ${type}`);
    this.siem.send(event).catch((err: unknown) => {
      this.logger.error({ err, category: 'security' }, 'SIEM недоступен');
    });
  }
}
