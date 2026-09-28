import { SETTING_KEYS } from '@idb-stories/db';
import {
  invalidateFeed,
  readAllowlist,
  readFeedEnabled,
  writeAudit,
  type AuditContext,
} from '@idb-stories/core';
import { validateAllowlist, type CtaAllowlist, type SettingsDto } from '@idb-stories/schema';
import type { AppDeps } from '../context.js';
import { badRequest } from '../http/errors.js';
import type { Actor } from '../http/routes.js';

export class SettingsAdminService {
  constructor(private readonly deps: AppDeps) {}

  async get(): Promise<SettingsDto> {
    const [feedEnabled, ctaAllowlist] = await Promise.all([
      readFeedEnabled(this.deps.prisma),
      readAllowlist(this.deps.prisma),
    ]);
    return { feedEnabled, ctaAllowlist };
  }

  async updateAllowlist(
    input: CtaAllowlist,
    actor: Actor,
    audit: AuditContext,
  ): Promise<SettingsDto> {
    const checked = validateAllowlist(input);
    if (!checked.ok)
      throw badRequest(
        'Allowlist содержит ошибки',
        { errors: checked.errors },
        'invalid_allowlist',
      );
    await this.deps.prisma.$transaction(async (tx) => {
      const before = await readAllowlist(tx);
      await tx.setting.upsert({
        where: { key: SETTING_KEYS.ctaAllowlist },
        create: {
          key: SETTING_KEYS.ctaAllowlist,
          value: { ...checked.allowlist },
          updatedById: actor.id,
        },
        update: { value: { ...checked.allowlist }, updatedById: actor.id },
      });
      await writeAudit(tx, audit, {
        action: 'settings.allowlist_changed',
        entityType: 'setting',
        entityId: SETTING_KEYS.ctaAllowlist,
        diff: { before, after: checked.allowlist },
      });
    });
    this.deps.security.emit('allowlist.changed', {
      actorId: actor.id,
      ip: audit.ip ?? null,
      requestId: audit.requestId ?? null,
      details: { allowlist: checked.allowlist },
    });
    return this.get();
  }

  /** Kill switch (раздел 10.8): флаг в БД, копия в Redis, новое поколение кеша и purge CDN. */
  async setFeedEnabled(enabled: boolean, actor: Actor, audit: AuditContext): Promise<SettingsDto> {
    await this.deps.prisma.$transaction(async (tx) => {
      const before = await readFeedEnabled(tx);
      await tx.setting.upsert({
        where: { key: SETTING_KEYS.feedEnabled },
        create: { key: SETTING_KEYS.feedEnabled, value: enabled, updatedById: actor.id },
        update: { value: enabled, updatedById: actor.id },
      });
      await writeAudit(tx, audit, {
        action: 'settings.feed_enabled_changed',
        entityType: 'setting',
        entityId: SETTING_KEYS.feedEnabled,
        diff: { before, after: enabled },
      });
    });
    await this.deps.settings.cacheFeedEnabled(enabled).catch((err: unknown) => {
      this.deps.logger.error(
        { err },
        'Не удалось записать feed_enabled в Redis — применится по TTL',
      );
    });
    await invalidateFeed(this.deps.publishing, enabled ? 'kill switch off' : 'kill switch on');
    this.deps.security.emit('kill_switch.changed', {
      actorId: actor.id,
      ip: audit.ip ?? null,
      requestId: audit.requestId ?? null,
      details: { feedEnabled: enabled },
    });
    return this.get();
  }
}
