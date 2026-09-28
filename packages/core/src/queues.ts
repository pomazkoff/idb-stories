import { z } from 'zod';
import { MediaKind, MediaPurpose, UploadContentType, type StoryEvent } from '@idb-stories/schema';
import { MediaVariants } from './media.js';

/** Имена очередей BullMQ. Медиа-воркеру доступны только media-process и media-results. */
export const QUEUES = {
  mediaProcess: 'media-process',
  mediaResults: 'media-results',
  eventsIngest: 'events-ingest',
  analyticsForward: 'analytics-forward',
  scheduler: 'scheduler',
  maintenance: 'maintenance',
} as const;

export const MediaProcessJob = z.object({
  assetId: z.uuid(),
  kind: MediaKind,
  purpose: MediaPurpose,
  originalKey: z.string(),
  declaredContentType: UploadContentType,
  declaredSize: z.int().positive(),
});
export type MediaProcessJob = z.infer<typeof MediaProcessJob>;

export const MediaResultJob = z.discriminatedUnion('status', [
  z.object({
    assetId: z.uuid(),
    status: z.literal('ready'),
    detectedMime: z.string(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    size: z.int().nonnegative(),
    width: z.int().positive(),
    height: z.int().positive(),
    durationMs: z.int().positive().nullable(),
    storageKey: z.string().regex(/^[0-9a-f]{32}$/),
    variants: MediaVariants,
  }),
  z.object({
    assetId: z.uuid(),
    status: z.literal('rejected'),
    rejectReason: z.string().max(500),
    /** Для события безопасности (раздел 10.9): причина и sha256 отклонённого файла. */
    sha256: z.string().nullable(),
    detectedMime: z.string().nullable(),
  }),
]);
export type MediaResultJob = z.infer<typeof MediaResultJob>;

export interface EventsIngestJob {
  receivedAt: string;
  events: StoryEvent[];
}

export interface AnalyticsForwardJob {
  events: StoryEvent[];
}

export type MaintenanceJob = { task: 'retention' } | { task: 'segments-sync' };
