import { MockAnalyticsAdapter, type AnalyticsAdapter } from './analytics.js';
import { MockCatalogAdapter, type CatalogAdapter } from './catalog.js';
import { MockCdnPurgeAdapter, type CdnPurgeAdapter } from './cdn-purge.js';
import {
  DisabledCustomerAuthAdapter,
  MockCustomerAuthAdapter,
  type CustomerAuthAdapter,
} from './customer-auth.js';
import { MockSegmentsAdapter, type SegmentsAdapter } from './segments.js';
import { MockSiemAdapter, type SiemAdapter } from './siem.js';

export * from './analytics.js';
export * from './catalog.js';
export * from './cdn-purge.js';
export * from './customer-auth.js';
export * from './errors.js';
export * from './segments.js';
export * from './siem.js';
export * from './sso.js';
export * from './storage.js';

export type RuntimeEnv = 'development' | 'test' | 'production';

export interface AdaptersConfig {
  env: RuntimeEnv;
  customerAuth:
    | { provider: 'disabled' }
    | { provider: 'mock'; secret: string; issuer: string; audience: string };
  segments: { provider: 'mock' };
  catalog: { provider: 'mock' };
  analytics: { provider: 'mock' };
  cdnPurge: { provider: 'mock' };
  siem: { provider: 'mock' };
}

export interface Adapters {
  customerAuth: CustomerAuthAdapter;
  segments: SegmentsAdapter;
  catalog: CatalogAdapter;
  analytics: AnalyticsAdapter;
  cdnPurge: CdnPurgeAdapter;
  siem: SiemAdapter;
}

/**
 * Собирает адаптеры интеграций. Реальные реализации ИДБ подключаются здесь новым `provider`.
 * Mock проверки токенов покупателей в production запрещён: с известным dev-секретом можно
 * подделать токен и получить чужую персональную ленту (угроза T12).
 */
export function createAdapters(config: AdaptersConfig): Adapters {
  if (config.env === 'production' && config.customerAuth.provider === 'mock') {
    throw new Error('CUSTOMER_AUTH_PROVIDER=mock запрещён в production');
  }
  return {
    customerAuth:
      config.customerAuth.provider === 'mock'
        ? new MockCustomerAuthAdapter(config.customerAuth)
        : new DisabledCustomerAuthAdapter(),
    segments: new MockSegmentsAdapter(),
    catalog: new MockCatalogAdapter(),
    analytics: new MockAnalyticsAdapter(),
    cdnPurge: new MockCdnPurgeAdapter(),
    siem: new MockSiemAdapter(),
  };
}

/** Какие адаптеры работают на mock — для предупреждения при старте в production. */
export function mockAdapterNames(config: AdaptersConfig): string[] {
  const { env: _env, ...adapters } = config;
  return Object.entries(adapters)
    .filter(([, v]) => v.provider === 'mock')
    .map(([k]) => k);
}
