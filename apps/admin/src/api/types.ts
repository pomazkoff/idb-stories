/**
 * Типы DTO admin API. Источник правды — zod-схемы в @idb-stories/schema; здесь только выводим типы
 * там, где пакет экспортирует схему без одноимённого типа.
 */
import type {
  AdminGroup,
  AdminGroupSummary,
  AdminMediaAsset,
  AdminUserDto,
  AuditEntryDto,
  CatalogProductDto,
  GroupCreateInput,
  GroupDiff,
  GroupPreview,
  GroupStats,
  GroupUpdateInput,
  GroupVersion,
  Me,
  SegmentDto,
  SettingsDto,
  SlideInput,
  UploadUrlInput,
  UploadUrlResponse,
} from '@idb-stories/schema';

export type {
  AdminGroup,
  AdminGroupSummary,
  AdminMediaAsset,
  AdminUserDto,
  CatalogProductDto,
  GroupCreateInput,
  GroupDiff,
  GroupPreview,
  GroupStats,
  GroupUpdateInput,
  Me,
  SettingsDto,
  SlideInput,
  UploadUrlInput,
};

export type AdminSlide = AdminGroup['slides'][number];
export type GroupActions = AdminGroup['actions'];
export type AuditEntry = ReturnType<typeof AuditEntryDto.parse>;
export type Segment = ReturnType<typeof SegmentDto.parse>;
export type GroupVersionDto = ReturnType<typeof GroupVersion.parse>;
export type UploadTicket = ReturnType<typeof UploadUrlResponse.parse>;
export type CtaAllowlist = SettingsDto['ctaAllowlist'];

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface GroupListParams {
  status?: string | undefined;
  placement?: string | undefined;
  schedule?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  q?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface AuditParams {
  actorId?: string | undefined;
  action?: string | undefined;
  entityType?: string | undefined;
  entityId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}
