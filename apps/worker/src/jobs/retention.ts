import type { PrismaClient } from '@idb-stories/db';

/**
 * Сроки хранения (раздел 10.7): сырые события — 30 дней, агрегаты — 2 года.
 * Аудит (3 года) удаляется только процедурой DBA — таблица append-only (DECISIONS.md).
 * Оригиналы в quarantine удаляет lifecycle-правило бакета (7 дней).
 */
export async function runRetention(
  prisma: PrismaClient,
  opts: { rawEventsDays: number; statsDays: number },
  now: Date = new Date(),
): Promise<{ rawEvents: number; stats: number }> {
  const day = 24 * 3600_000;
  const raw = await prisma.storyEventRaw.deleteMany({
    where: { receivedAt: { lt: new Date(now.getTime() - opts.rawEventsDays * day) } },
  });
  const stats = await prisma.statDaily.deleteMany({
    where: { day: { lt: new Date(now.getTime() - opts.statsDays * day) } },
  });
  return { rawEvents: raw.count, stats: stats.count };
}
