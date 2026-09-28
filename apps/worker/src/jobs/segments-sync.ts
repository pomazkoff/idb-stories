import type { SegmentsAdapter } from '@idb-stories/adapters';
import type { PrismaClient } from '@idb-stories/db';

/**
 * [ИНТЕГРАЦИЯ] Синхронизация справочника сегментов (открытый вопрос №5).
 * Сегменты не удаляются: на них могут ссылаться группы; устаревшие видны по synced_at.
 */
export async function syncSegments(
  prisma: PrismaClient,
  adapter: SegmentsAdapter,
  now = new Date(),
): Promise<number> {
  const segments = await adapter.listSegments();
  for (const s of segments) {
    await prisma.segment.upsert({
      where: { id: s.id },
      create: { id: s.id, name: s.name, syncedAt: now },
      update: { name: s.name, syncedAt: now },
    });
  }
  return segments.length;
}
