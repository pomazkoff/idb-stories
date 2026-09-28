import { MediaResultJob, mediaRejectedTotal, type SecurityLog } from '@idb-stories/core';
import type { PrismaClient } from '@idb-stories/db';

/**
 * Результат медиа-воркера → MediaAsset. Отклонённые загрузки — событие безопасности
 * с причиной и sha256 (раздел 10.9); по метрике строится алерт «много отказов от одного пользователя».
 */
export async function applyMediaResult(
  prisma: PrismaClient,
  security: SecurityLog,
  raw: unknown,
  now: Date = new Date(),
): Promise<void> {
  const result = MediaResultJob.parse(raw);
  const asset = await prisma.mediaAsset.findUnique({ where: { id: result.assetId } });
  if (!asset || asset.status === 'ready' || asset.status === 'rejected') return;

  if (result.status === 'ready') {
    await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: {
        status: 'ready',
        detectedMime: result.detectedMime,
        sha256: result.sha256,
        size: result.size,
        width: result.width,
        height: result.height,
        durationMs: result.durationMs,
        storageKey: result.storageKey,
        variants: result.variants,
        processedAt: now,
        rejectReason: null,
      },
    });
    return;
  }

  await prisma.mediaAsset.update({
    where: { id: asset.id },
    data: {
      status: 'rejected',
      rejectReason: result.rejectReason,
      sha256: result.sha256,
      detectedMime: result.detectedMime,
      processedAt: now,
    },
  });
  mediaRejectedTotal.inc({ uploader: asset.uploadedById });
  security.emit('media.rejected', {
    actorId: asset.uploadedById,
    details: {
      assetId: asset.id,
      reason: result.rejectReason,
      sha256: result.sha256,
      declaredContentType: asset.declaredContentType,
      detectedMime: result.detectedMime,
    },
  });
}
