import { request } from './client.js';
import type {
  AdminGroup,
  AdminGroupSummary,
  AdminMediaAsset,
  AdminUserDto,
  AuditEntry,
  AuditParams,
  CatalogProductDto,
  CtaAllowlist,
  GroupCreateInput,
  GroupDiff,
  GroupListParams,
  GroupPreview,
  GroupStats,
  GroupUpdateInput,
  GroupVersionDto,
  Me,
  Page,
  Segment,
  SettingsDto,
  SlideInput,
  UploadTicket,
  UploadUrlInput,
} from './types.js';

const id = (value: string) => encodeURIComponent(value);

/** Эндпоинты admin API (контракты: packages/schema/src/contracts/admin.ts). */
export const api = {
  // Сессия
  me: (signal?: AbortSignal) => request<Me>('GET', '/auth/me', { signal }),
  logout: () => request<void>('POST', '/auth/logout', { noAuthRedirect: true }),

  // Группы
  listGroups: (params: GroupListParams, signal?: AbortSignal) =>
    request<Page<AdminGroupSummary>>('GET', '/groups', { query: { ...params }, signal }),
  getGroup: (groupId: string, signal?: AbortSignal) =>
    request<AdminGroup>('GET', `/groups/${id(groupId)}`, { signal }),
  createGroup: (body: GroupCreateInput) => request<AdminGroup>('POST', '/groups', { body }),
  updateGroup: (groupId: string, body: GroupUpdateInput) =>
    request<AdminGroup>('PATCH', `/groups/${id(groupId)}`, { body }),
  deleteGroup: (groupId: string) => request<void>('DELETE', `/groups/${id(groupId)}`),
  duplicateGroup: (groupId: string) => request<AdminGroup>('POST', `/groups/${id(groupId)}/duplicate`),

  // Слайды
  createSlide: (groupId: string, body: SlideInput) =>
    request<AdminGroup>('POST', `/groups/${id(groupId)}/slides`, { body }),
  updateSlide: (groupId: string, slideId: string, body: SlideInput) =>
    request<AdminGroup>('PUT', `/groups/${id(groupId)}/slides/${id(slideId)}`, { body }),
  deleteSlide: (groupId: string, slideId: string) =>
    request<AdminGroup>('DELETE', `/groups/${id(groupId)}/slides/${id(slideId)}`),
  reorderSlides: (groupId: string, revision: number, slideIds: string[]) =>
    request<AdminGroup>('PUT', `/groups/${id(groupId)}/slides/order`, { body: { revision, slideIds } }),

  // Согласование и публикация
  submit: (groupId: string, revision: number) =>
    request<AdminGroup>('POST', `/groups/${id(groupId)}/submit`, { body: { revision } }),
  approve: (groupId: string, revision: number) =>
    request<AdminGroup>('POST', `/groups/${id(groupId)}/approve`, { body: { revision } }),
  reject: (groupId: string, revision: number, comment: string) =>
    request<AdminGroup>('POST', `/groups/${id(groupId)}/reject`, { body: { revision, comment } }),
  publish: (groupId: string) => request<AdminGroup>('POST', `/groups/${id(groupId)}/publish`),
  unpublish: (groupId: string, reason: string | null) =>
    request<AdminGroup>('POST', `/groups/${id(groupId)}/unpublish`, { body: reason ? { reason } : {} }),
  diff: (groupId: string, signal?: AbortSignal) =>
    request<GroupDiff>('GET', `/groups/${id(groupId)}/diff`, { signal }),
  preview: (groupId: string, signal?: AbortSignal) =>
    request<GroupPreview>('GET', `/groups/${id(groupId)}/preview`, { signal }),
  versions: (groupId: string, signal?: AbortSignal) =>
    request<{ items: GroupVersionDto[] }>('GET', `/groups/${id(groupId)}/versions`, { signal }),

  // Медиа
  createUploadUrl: (body: UploadUrlInput) => request<UploadTicket>('POST', '/media/upload-url', { body }),
  completeUpload: (mediaId: string) => request<AdminMediaAsset>('POST', `/media/${id(mediaId)}/complete`),
  getMedia: (mediaId: string, signal?: AbortSignal) =>
    request<AdminMediaAsset>('GET', `/media/${id(mediaId)}`, { signal }),

  // Справочники
  segments: (signal?: AbortSignal) => request<{ items: Segment[] }>('GET', '/segments', { signal }),
  catalogProducts: (skus: string[], signal?: AbortSignal) =>
    request<{ items: CatalogProductDto[] }>('GET', '/catalog/products', { query: { skus: skus.join(',') }, signal }),

  // Статистика и аудит
  stats: (groupId: string, from: string, to: string, signal?: AbortSignal) =>
    request<GroupStats>('GET', `/stats/groups/${id(groupId)}`, { query: { from, to }, signal }),
  auditLog: (params: AuditParams, signal?: AbortSignal) =>
    request<Page<AuditEntry>>('GET', '/audit-log', { query: { ...params }, signal }),

  // Пользователи
  users: (signal?: AbortSignal) => request<{ items: AdminUserDto[] }>('GET', '/users', { signal }),
  setUserRoles: (userId: string, roles: string[]) =>
    request<AdminUserDto>('PUT', `/users/${id(userId)}/roles`, { body: { roles } }),
  setUserStatus: (userId: string, disabled: boolean) =>
    request<AdminUserDto>('PUT', `/users/${id(userId)}/status`, { body: { disabled } }),

  // Настройки
  settings: (signal?: AbortSignal) => request<SettingsDto>('GET', '/settings', { signal }),
  updateAllowlist: (allowlist: CtaAllowlist) =>
    request<SettingsDto>('PUT', '/settings/allowlist', { body: allowlist }),
  setFeedEnabled: (enabled: boolean, confirmation: string) =>
    request<SettingsDto>('PUT', '/settings/feed-enabled', { body: { enabled, confirmation } }),
};
