import { randomUUID } from 'node:crypto';
import {
  QUEUES,
  quarantineKey,
  writeAudit,
  type AuditContext,
  type MediaProcessJob,
} from '@idb-stories/core';
import type { AdminMediaAsset, UploadUrlInput } from '@idb-stories/schema';
import type { AppDeps } from '../context.js';
import { conflict, forbidden, notFound } from '../http/errors.js';
import type { Actor } from '../http/routes.js';
import { toMediaDto } from './mappers.js';
import { DRAFT_MEDIA_URL_TTL_SEC } from './workflow.js';

/** Presigned PUT живёт 10 минут (раздел 6.1). */
export const UPLOAD_URL_TTL_SEC = 10 * 60;

/**
 * Загрузка медиа (раздел 7): файл идёт прямо в закрытый quarantine bucket по presigned PUT
 * с зафиксированными типом и размером; API содержимое не читает — это делает изолированный воркер.
 */
export class MediaService {
  constructor(private readonly deps: AppDeps) {}

  private sign = (key: string) =>
    this.deps.storage.presignGet(this.deps.config.s3.buckets.media, key, DRAFT_MEDIA_URL_TTL_SEC);

  async createUpload(input: UploadUrlInput, actor: Actor, audit: AuditContext) {
    const id = randomUUID();
    const key = quarantineKey(id);
    const upload = await this.deps.storage.presignPut(this.deps.config.s3.buckets.quarantine, key, {
      contentType: input.contentType,
      contentLength: input.size,
      expiresInSec: UPLOAD_URL_TTL_SEC,
    });
    const asset = await this.deps.prisma.$transaction(async (tx) => {
      const a = await tx.mediaAsset.create({
        data: {
          id,
          kind: input.kind,
          purpose: input.purpose,
          declaredContentType: input.contentType,
          declaredSize: input.size,
          originalKey: key,
          uploadedById: actor.id,
        },
      });
      await writeAudit(tx, audit, {
        action: 'media.upload_requested',
        entityType: 'media',
        entityId: id,
        diff: {
          kind: input.kind,
          purpose: input.purpose,
          contentType: input.contentType,
          size: input.size,
        },
      });
      return a;
    });
    return {
      asset: await toMediaDto(asset, this.sign),
      upload: {
        url: upload.url,
        method: upload.method,
        headers: upload.headers,
        expiresAt: upload.expiresAt.toISOString(),
      },
    };
  }

  async complete(id: string, actor: Actor, audit: AuditContext): Promise<AdminMediaAsset> {
    const asset = await this.deps.prisma.mediaAsset.findUnique({ where: { id } });
    if (!asset) throw notFound('Файл не найден');
    if (asset.uploadedById !== actor.id)
      throw forbidden('Завершить загрузку может только тот, кто её начал');
    if (asset.status !== 'uploaded') return toMediaDto(asset, this.sign);
    const head = await this.deps.storage.head(
      this.deps.config.s3.buckets.quarantine,
      asset.originalKey,
    );
    if (!head) throw conflict('Файл ещё не загружен', 'not_uploaded');

    const job: MediaProcessJob = {
      assetId: asset.id,
      kind: asset.kind,
      purpose: asset.purpose,
      originalKey: asset.originalKey,
      declaredContentType: asset.declaredContentType as MediaProcessJob['declaredContentType'],
      declaredSize: asset.declaredSize,
    };
    const updated = await this.deps.prisma.$transaction(async (tx) => {
      const res = await tx.mediaAsset.updateMany({
        where: { id, status: 'uploaded' },
        data: { status: 'processing', processingStartedAt: this.deps.now() },
      });
      if (res.count === 1) {
        await writeAudit(tx, audit, {
          action: 'media.upload_completed',
          entityType: 'media',
          entityId: id,
          diff: { size: head.size },
        });
      }
      return tx.mediaAsset.findUniqueOrThrow({ where: { id } });
    });
    // jobId = assetId: повторный complete не создаст вторую задачу.
    await this.deps.queues.mediaProcess.add(QUEUES.mediaProcess, job, { jobId: asset.id });
    return toMediaDto(updated, this.sign);
  }

  async get(id: string): Promise<AdminMediaAsset> {
    const asset = await this.deps.prisma.mediaAsset.findUnique({ where: { id } });
    if (!asset) throw notFound('Файл не найден');
    return toMediaDto(asset, this.sign);
  }
}
