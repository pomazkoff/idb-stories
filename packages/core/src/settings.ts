import { SETTING_KEYS, DEFAULT_ALLOWLIST, type PrismaClient, type Prisma } from '@idb-stories/db';
import { validateAllowlist, type CtaAllowlist } from '@idb-stories/schema';
import type { Logger } from './logger.js';
import type { Redis, RedisKeys } from './redis.js';

/** TTL копии флага в Redis: даже если запись в Redis не удалась, БД перечитается < 60 с. */
const FEED_ENABLED_CACHE_SEC = 30;
const MEMO_MS = 5_000;

type Db = Pick<Prisma.TransactionClient, 'setting'>;

/**
 * Глобальные настройки (Setting): kill switch `feed_enabled` и allowlist CTA.
 * Источник правды — БД; флаг ленты дополнительно кешируется в Redis, т.к. читается на каждый /feed.
 */
export class SettingsService {
  private memo: { value: boolean; at: number } | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly redis: Redis,
    private readonly keys: RedisKeys,
    private readonly logger: Logger,
  ) {}

  async isFeedEnabled(): Promise<boolean> {
    try {
      const cached = await this.redis.get(this.keys.feedEnabled);
      if (cached === '1') return true;
      if (cached === '0') return false;
    } catch (err) {
      this.logger.warn({ err }, 'Redis недоступен при чтении feed_enabled, читаем БД');
    }
    if (this.memo && Date.now() - this.memo.at < MEMO_MS) return this.memo.value;
    const value = await readFeedEnabled(this.prisma);
    this.memo = { value, at: Date.now() };
    await this.cacheFeedEnabled(value).catch(() => undefined);
    return value;
  }

  async cacheFeedEnabled(value: boolean): Promise<void> {
    this.memo = { value, at: Date.now() };
    await this.redis.set(this.keys.feedEnabled, value ? '1' : '0', 'EX', FEED_ENABLED_CACHE_SEC);
  }

  getAllowlist(db: Db = this.prisma): Promise<CtaAllowlist> {
    return readAllowlist(db);
  }
}

export async function readFeedEnabled(db: Db): Promise<boolean> {
  const row = await db.setting.findUnique({ where: { key: SETTING_KEYS.feedEnabled } });
  return row?.value !== false;
}

export async function readAllowlist(db: Db): Promise<CtaAllowlist> {
  const row = await db.setting.findUnique({ where: { key: SETTING_KEYS.ctaAllowlist } });
  const value = row?.value as Partial<CtaAllowlist> | undefined;
  const parsed = validateAllowlist({
    deeplinkSchemes: Array.isArray(value?.deeplinkSchemes)
      ? value.deeplinkSchemes
      : DEFAULT_ALLOWLIST.deeplinkSchemes,
    urlDomains: Array.isArray(value?.urlDomains) ? value.urlDomains : DEFAULT_ALLOWLIST.urlDomains,
  });
  // Повреждённая настройка не должна расширять доступ: пустой allowlist запрещает все ссылки.
  return parsed.ok ? parsed.allowlist : { deeplinkSchemes: [], urlDomains: [] };
}
