import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@testkit/db.js';

/**
 * Защиты уровня БД (раздел 10.9): журнал аудита append-only, согласованные снимки неизменяемы.
 * Проверяется и для роли приложения (права отозваны), и для владельца схемы (триггеры).
 */
describe('защиты уровня БД', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db.drop();
  });

  it('роль приложения может писать в аудит, но не может менять и удалять записи', async () => {
    const entry = await db.app.auditLog.create({
      data: { action: 'test.action', entityType: 'test', entityId: '1' },
    });
    await expect(
      db.app.auditLog.update({ where: { id: entry.id }, data: { action: 'tampered' } }),
    ).rejects.toThrow(/permission denied/i);
    await expect(db.app.auditLog.delete({ where: { id: entry.id } })).rejects.toThrow(
      /permission denied/i,
    );
    await expect(db.app.$executeRawUnsafe('TRUNCATE audit_log')).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('даже владелец схемы не может изменить или удалить аудит (триггер)', async () => {
    const entry = await db.owner.auditLog.create({ data: { action: 'x', entityType: 'test' } });
    await expect(
      db.owner.auditLog.update({ where: { id: entry.id }, data: { action: 'tampered' } }),
    ).rejects.toThrow(/append-only/);
    await expect(db.owner.auditLog.delete({ where: { id: entry.id } })).rejects.toThrow(
      /append-only/,
    );
    await expect(db.owner.$executeRawUnsafe('TRUNCATE audit_log')).rejects.toThrow(/append-only/);
  });

  it('содержимое согласованного снимка неизменяемо, состояние движется только вперёд', async () => {
    const user = await db.owner.adminUser.create({
      data: { subject: 's1', email: 'a@b', name: 'A' },
    });
    const group = await db.owner.storyGroup.create({
      data: {
        title: 'Тест',
        placement: 'home',
        startAt: new Date('2026-01-01T00:00:00Z'),
        endAt: new Date('2027-01-01T00:00:00Z'),
        platforms: ['web'],
        lastEditedById: user.id,
        createdById: user.id,
        updatedById: user.id,
      },
    });
    const snap = await db.app.publishedSnapshot.create({
      data: {
        groupId: group.id,
        version: 1,
        payload: { title: 'Тест' },
        source: {},
        placement: 'home',
        priority: 0,
        startAt: group.startAt,
        endAt: group.endAt,
        platforms: ['web'],
        sourceRevision: 1,
        approvedById: user.id,
        approvedAt: new Date(),
      },
    });

    await expect(
      db.app.publishedSnapshot.update({
        where: { id: snap.id },
        data: { payload: { title: 'Фишинг' } },
      }),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.owner.publishedSnapshot.update({
        where: { id: snap.id },
        data: { endAt: new Date('2030-01-01') },
      }),
    ).rejects.toThrow(/immutable/);
    await expect(db.app.publishedSnapshot.delete({ where: { id: snap.id } })).rejects.toThrow(
      /permission denied/i,
    );
    await expect(db.owner.publishedSnapshot.delete({ where: { id: snap.id } })).rejects.toThrow(
      /cannot be deleted/,
    );

    await db.app.publishedSnapshot.update({
      where: { id: snap.id },
      data: { state: 'published', publishedAt: new Date() },
    });
    await expect(
      db.app.publishedSnapshot.update({ where: { id: snap.id }, data: { state: 'approved' } }),
    ).rejects.toThrow(/invalid snapshot state transition/);
    await db.app.publishedSnapshot.update({
      where: { id: snap.id },
      data: { state: 'archived', archivedAt: new Date() },
    });
    await expect(
      db.app.publishedSnapshot.update({ where: { id: snap.id }, data: { state: 'published' } }),
    ).rejects.toThrow(/invalid snapshot state transition/);
  });

  it('у группы не может быть двух опубликованных снимков одновременно', async () => {
    const user = await db.owner.adminUser.create({
      data: { subject: 's2', email: 'b@b', name: 'B' },
    });
    const group = await db.owner.storyGroup.create({
      data: {
        title: 'Два снимка',
        placement: 'home',
        startAt: new Date('2026-01-01T00:00:00Z'),
        endAt: new Date('2027-01-01T00:00:00Z'),
        platforms: ['web'],
        lastEditedById: user.id,
        createdById: user.id,
        updatedById: user.id,
      },
    });
    const base = {
      groupId: group.id,
      payload: {},
      source: {},
      placement: 'home' as const,
      priority: 0,
      startAt: group.startAt,
      endAt: group.endAt,
      platforms: ['web' as const],
      sourceRevision: 1,
      approvedById: user.id,
      approvedAt: new Date(),
      state: 'published' as const,
    };
    await db.app.publishedSnapshot.create({ data: { ...base, version: 1 } });
    await expect(
      db.app.publishedSnapshot.create({ data: { ...base, version: 2 } }),
    ).rejects.toThrow(/Unique constraint/);
  });

  it('роль приложения не видит таблицу миграций', async () => {
    await expect(db.app.$queryRawUnsafe('SELECT * FROM _prisma_migrations')).rejects.toThrow(
      /permission denied/i,
    );
  });
});
