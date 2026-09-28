import prometheus from '@prometheus-io/client';

/**
 * Метрики доменной логики. Приложения объединяют этот реестр со своим
 * (Registry.merge) и отдают на внутреннем порту /metrics.
 */
export const coreRegistry = new prometheus.Registry();

export const securityEventsTotal = new prometheus.Counter({
  name: 'stories_security_events_total',
  help: 'События безопасности по типам (раздел 10.9)',
  labelNames: ['type'] as const,
  registers: [coreRegistry],
});

export const feedCacheTotal = new prometheus.Counter({
  name: 'stories_feed_cache_total',
  help: 'Обращения к кешу ленты',
  labelNames: ['result'] as const,
  registers: [coreRegistry],
});

export const adapterErrorsTotal = new prometheus.Counter({
  name: 'stories_adapter_errors_total',
  help: 'Ошибки вызовов адаптеров интеграций',
  labelNames: ['adapter'] as const,
  registers: [coreRegistry],
});

export const publicationsTotal = new prometheus.Counter({
  name: 'stories_publications_total',
  help: 'Публикации и снятия с публикации',
  labelNames: ['action', 'trigger', 'business_hours'] as const,
  registers: [coreRegistry],
});

export const mediaRejectedTotal = new prometheus.Counter({
  name: 'stories_media_rejected_total',
  help: 'Отклонённые загрузки медиа',
  labelNames: ['uploader'] as const,
  registers: [coreRegistry],
});

export const eventsTotal = new prometheus.Counter({
  name: 'stories_events_total',
  help: 'События плееров',
  labelNames: ['result'] as const,
  registers: [coreRegistry],
});

export { prometheus };
