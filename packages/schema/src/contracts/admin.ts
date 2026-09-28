import {
  AdminGroup,
  AdminMediaAsset,
  AdminUserDto,
  AdminUserList,
  AuditList,
  AuditQuery,
  CallbackQuery,
  CatalogProducts,
  CatalogQuery,
  CtaAllowlistDto,
  ErrorResponse,
  FeedEnabledInput,
  GroupDiff,
  GroupList,
  GroupListQuery,
  GroupPreview,
  GroupSlideParams,
  GroupStats,
  GroupVersions,
  IdParams,
  LoginQuery,
  Me,
  RejectInput,
  ReorderSlidesInput,
  RevisionInput,
  SegmentList,
  SettingsDto,
  StatsQuery,
  UnpublishInput,
  UploadUrlInput,
  UploadUrlResponse,
  UserRolesInput,
  UserStatusInput,
} from '../admin.js';
import { GroupCreateInput, GroupUpdateInput, SlideInput } from '../content.js';
import { defineContract } from './types.js';

const P = '/admin/v1';
const err = (description: string) => ({ description, schema: ErrorResponse });
const common = {
  401: err('Нет сессии'),
  403: err('Недостаточно прав или неверный CSRF-токен'),
} as const;
const withGroup = { ...common, 404: err('Группа не найдена') } as const;
const mutation = {
  ...withGroup,
  400: err('Ошибка валидации'),
  409: err('Конфликт версии или состояния'),
} as const;

// --- Аутентификация --------------------------------------------------------

export const authLogin = defineContract({
  id: 'authLogin',
  method: 'GET',
  path: `${P}/auth/login`,
  summary: 'Редирект на корпоративный SSO',
  tags: ['auth'],
  auth: 'anonymous',
  query: LoginQuery,
  responses: { 302: { description: 'Редирект на IdP' } },
});

export const authCallback = defineContract({
  id: 'authCallback',
  method: 'GET',
  path: `${P}/auth/callback`,
  summary: 'Возврат из SSO, создание сессии',
  tags: ['auth'],
  auth: 'anonymous',
  query: CallbackQuery,
  responses: { 302: { description: 'Редирект в админку' }, 401: err('Вход не выполнен') },
});

export const authLogout = defineContract({
  id: 'authLogout',
  method: 'POST',
  path: `${P}/auth/logout`,
  summary: 'Выход',
  tags: ['auth'],
  auth: 'session',
  responses: { 204: { description: 'Сессия удалена' }, ...common },
});

export const authMe = defineContract({
  id: 'authMe',
  method: 'GET',
  path: `${P}/auth/me`,
  summary: 'Текущий пользователь, права и CSRF-токен',
  tags: ['auth'],
  auth: 'session',
  responses: { 200: { description: 'OK', schema: Me }, 401: err('Нет сессии') },
});

// --- Группы ----------------------------------------------------------------

export const listGroups = defineContract({
  id: 'listGroups',
  method: 'GET',
  path: `${P}/groups`,
  summary: 'Список групп с фильтрами',
  tags: ['groups'],
  auth: 'session',
  permission: 'groups:read',
  query: GroupListQuery,
  responses: { 200: { description: 'OK', schema: GroupList }, ...common },
});

export const createGroup = defineContract({
  id: 'createGroup',
  method: 'POST',
  path: `${P}/groups`,
  summary: 'Создать черновик группы',
  tags: ['groups'],
  auth: 'session',
  permission: 'groups:write',
  body: GroupCreateInput,
  responses: {
    201: { description: 'Создано', schema: AdminGroup },
    ...common,
    400: err('Ошибка валидации'),
  },
});

export const getGroup = defineContract({
  id: 'getGroup',
  method: 'GET',
  path: `${P}/groups/:id`,
  summary: 'Группа со слайдами',
  tags: ['groups'],
  auth: 'session',
  permission: 'groups:read',
  params: IdParams,
  responses: { 200: { description: 'OK', schema: AdminGroup }, ...withGroup },
});

export const updateGroup = defineContract({
  id: 'updateGroup',
  method: 'PATCH',
  path: `${P}/groups/:id`,
  summary: 'Изменить метаданные и таргетинг (сбрасывает статус в draft)',
  tags: ['groups'],
  auth: 'session',
  permission: 'groups:write',
  params: IdParams,
  body: GroupUpdateInput,
  responses: { 200: { description: 'OK', schema: AdminGroup }, ...mutation },
});

export const deleteGroup = defineContract({
  id: 'deleteGroup',
  method: 'DELETE',
  path: `${P}/groups/:id`,
  summary: 'Удалить черновик, который ни разу не согласовывался',
  tags: ['groups'],
  auth: 'session',
  permission: 'groups:write',
  params: IdParams,
  responses: { 204: { description: 'Удалено' }, ...mutation },
});

export const duplicateGroup = defineContract({
  id: 'duplicateGroup',
  method: 'POST',
  path: `${P}/groups/:id/duplicate`,
  summary: 'Дублировать группу в новый черновик',
  tags: ['groups'],
  auth: 'session',
  permission: 'groups:write',
  params: IdParams,
  responses: { 201: { description: 'Создано', schema: AdminGroup }, ...withGroup },
});

export const createSlide = defineContract({
  id: 'createSlide',
  method: 'POST',
  path: `${P}/groups/:id/slides`,
  summary: 'Добавить слайд в конец',
  tags: ['slides'],
  auth: 'session',
  permission: 'groups:write',
  params: IdParams,
  body: SlideInput,
  responses: { 201: { description: 'Создано', schema: AdminGroup }, ...mutation },
});

export const reorderSlides = defineContract({
  id: 'reorderSlides',
  method: 'PUT',
  path: `${P}/groups/:id/slides/order`,
  summary: 'Изменить порядок слайдов',
  tags: ['slides'],
  auth: 'session',
  permission: 'groups:write',
  params: IdParams,
  body: ReorderSlidesInput,
  responses: { 200: { description: 'OK', schema: AdminGroup }, ...mutation },
});

export const updateSlide = defineContract({
  id: 'updateSlide',
  method: 'PUT',
  path: `${P}/groups/:id/slides/:slideId`,
  summary: 'Заменить слайд',
  tags: ['slides'],
  auth: 'session',
  permission: 'groups:write',
  params: GroupSlideParams,
  body: SlideInput,
  responses: { 200: { description: 'OK', schema: AdminGroup }, ...mutation },
});

export const deleteSlide = defineContract({
  id: 'deleteSlide',
  method: 'DELETE',
  path: `${P}/groups/:id/slides/:slideId`,
  summary: 'Удалить слайд',
  tags: ['slides'],
  auth: 'session',
  permission: 'groups:write',
  params: GroupSlideParams,
  responses: { 200: { description: 'OK', schema: AdminGroup }, ...mutation },
});

// --- Согласование и публикация ---------------------------------------------

export const submitGroup = defineContract({
  id: 'submitGroup',
  method: 'POST',
  path: `${P}/groups/:id/submit`,
  summary: 'Отправить на согласование',
  tags: ['workflow'],
  auth: 'session',
  permission: 'groups:submit',
  params: IdParams,
  body: RevisionInput,
  responses: { 200: { description: 'OK', schema: AdminGroup }, ...mutation },
});

export const approveGroup = defineContract({
  id: 'approveGroup',
  method: 'POST',
  path: `${P}/groups/:id/approve`,
  summary: 'Согласовать (правило четырёх глаз). Создаёт неизменяемый снимок.',
  tags: ['workflow'],
  auth: 'session',
  permission: 'groups:review',
  params: IdParams,
  body: RevisionInput,
  responses: { 200: { description: 'OK', schema: AdminGroup }, ...mutation },
});

export const rejectGroup = defineContract({
  id: 'rejectGroup',
  method: 'POST',
  path: `${P}/groups/:id/reject`,
  summary: 'Отклонить с комментарием',
  tags: ['workflow'],
  auth: 'session',
  permission: 'groups:review',
  params: IdParams,
  body: RejectInput,
  responses: { 200: { description: 'OK', schema: AdminGroup }, ...mutation },
});

export const publishGroup = defineContract({
  id: 'publishGroup',
  method: 'POST',
  path: `${P}/groups/:id/publish`,
  summary: 'Опубликовать согласованную версию сейчас',
  tags: ['workflow'],
  auth: 'session',
  permission: 'groups:publish',
  params: IdParams,
  responses: { 200: { description: 'OK', schema: AdminGroup }, ...mutation },
});

export const unpublishGroup = defineContract({
  id: 'unpublishGroup',
  method: 'POST',
  path: `${P}/groups/:id/unpublish`,
  summary: 'Снять с публикации (применяется < 60 секунд)',
  tags: ['workflow'],
  auth: 'session',
  permission: 'groups:unpublish',
  params: IdParams,
  body: UnpublishInput,
  responses: { 200: { description: 'OK', schema: AdminGroup }, ...mutation },
});

export const getGroupDiff = defineContract({
  id: 'getGroupDiff',
  method: 'GET',
  path: `${P}/groups/:id/diff`,
  summary: 'Отличия рабочей копии от последней опубликованной версии',
  tags: ['workflow'],
  auth: 'session',
  permission: 'groups:read',
  params: IdParams,
  responses: { 200: { description: 'OK', schema: GroupDiff }, ...withGroup },
});

export const getGroupPreview = defineContract({
  id: 'getGroupPreview',
  method: 'GET',
  path: `${P}/groups/:id/preview`,
  summary: 'Превью рабочей копии в формате ленты',
  tags: ['workflow'],
  auth: 'session',
  permission: 'groups:read',
  params: IdParams,
  responses: { 200: { description: 'OK', schema: GroupPreview }, ...withGroup },
});

export const listGroupVersions = defineContract({
  id: 'listGroupVersions',
  method: 'GET',
  path: `${P}/groups/:id/versions`,
  summary: 'Согласованные версии (снимки) группы',
  tags: ['workflow'],
  auth: 'session',
  permission: 'groups:read',
  params: IdParams,
  responses: { 200: { description: 'OK', schema: GroupVersions }, ...withGroup },
});

// --- Медиа -----------------------------------------------------------------

export const createUploadUrl = defineContract({
  id: 'createUploadUrl',
  method: 'POST',
  path: `${P}/media/upload-url`,
  summary: 'Presigned PUT в quarantine bucket (TTL 10 минут, фиксированные тип и размер)',
  tags: ['media'],
  auth: 'session',
  permission: 'media:write',
  body: UploadUrlInput,
  responses: {
    201: { description: 'Создано', schema: UploadUrlResponse },
    ...common,
    400: err('Ошибка валидации'),
  },
});

export const completeUpload = defineContract({
  id: 'completeUpload',
  method: 'POST',
  path: `${P}/media/:id/complete`,
  summary: 'Загрузка завершена — поставить в очередь обработки',
  tags: ['media'],
  auth: 'session',
  permission: 'media:write',
  params: IdParams,
  responses: {
    202: { description: 'Принято в обработку', schema: AdminMediaAsset },
    ...common,
    404: err('Не найдено'),
    409: err('Файл не загружен или уже обработан'),
  },
});

export const getMedia = defineContract({
  id: 'getMedia',
  method: 'GET',
  path: `${P}/media/:id`,
  summary: 'Статус обработки и подписанные превью',
  tags: ['media'],
  auth: 'session',
  permission: 'media:read',
  params: IdParams,
  responses: {
    200: { description: 'OK', schema: AdminMediaAsset },
    ...common,
    404: err('Не найдено'),
  },
});

// --- Справочники -----------------------------------------------------------

export const listSegments = defineContract({
  id: 'listSegments',
  method: 'GET',
  path: `${P}/segments`,
  summary: 'Справочник сегментов (имена видны только в админке)',
  tags: ['reference'],
  auth: 'session',
  permission: 'segments:read',
  responses: { 200: { description: 'OK', schema: SegmentList }, ...common },
});

export const getCatalogProducts = defineContract({
  id: 'getCatalogProducts',
  method: 'GET',
  path: `${P}/catalog/products`,
  summary: 'Товары по SKU для превью (из каталога ИДБ)',
  tags: ['reference'],
  auth: 'session',
  permission: 'catalog:read',
  query: CatalogQuery,
  responses: { 200: { description: 'OK', schema: CatalogProducts }, ...common },
});

// --- Статистика, аудит -----------------------------------------------------

export const getGroupStats = defineContract({
  id: 'getGroupStats',
  method: 'GET',
  path: `${P}/stats/groups/:id`,
  summary: 'Статистика группы за период',
  tags: ['stats'],
  auth: 'session',
  permission: 'stats:read',
  params: IdParams,
  query: StatsQuery,
  responses: {
    200: { description: 'OK', schema: GroupStats },
    ...withGroup,
    400: err('Ошибка валидации'),
  },
});

export const listAuditLog = defineContract({
  id: 'listAuditLog',
  method: 'GET',
  path: `${P}/audit-log`,
  summary: 'Журнал аудита с фильтрами',
  tags: ['audit'],
  auth: 'session',
  permission: 'audit:read',
  query: AuditQuery,
  responses: { 200: { description: 'OK', schema: AuditList }, ...common },
});

// --- Пользователи ----------------------------------------------------------

export const listUsers = defineContract({
  id: 'listUsers',
  method: 'GET',
  path: `${P}/users`,
  summary: 'Пользователи и роли',
  tags: ['users'],
  auth: 'session',
  permission: 'users:read',
  responses: { 200: { description: 'OK', schema: AdminUserList }, ...common },
});

export const setUserRoles = defineContract({
  id: 'setUserRoles',
  method: 'PUT',
  path: `${P}/users/:id/roles`,
  summary: 'Назначить роли (нельзя менять себе и снимать последнего администратора)',
  tags: ['users'],
  auth: 'session',
  permission: 'users:write',
  params: IdParams,
  body: UserRolesInput,
  responses: {
    200: { description: 'OK', schema: AdminUserDto },
    ...common,
    404: err('Не найдено'),
    409: err('Недопустимое изменение'),
  },
});

export const setUserStatus = defineContract({
  id: 'setUserStatus',
  method: 'PUT',
  path: `${P}/users/:id/status`,
  summary: 'Заблокировать или разблокировать пользователя',
  tags: ['users'],
  auth: 'session',
  permission: 'users:write',
  params: IdParams,
  body: UserStatusInput,
  responses: {
    200: { description: 'OK', schema: AdminUserDto },
    ...common,
    404: err('Не найдено'),
    409: err('Недопустимое изменение'),
  },
});

// --- Настройки -------------------------------------------------------------

export const getSettings = defineContract({
  id: 'getSettings',
  method: 'GET',
  path: `${P}/settings`,
  summary: 'Глобальные настройки: kill switch и allowlist',
  tags: ['settings'],
  auth: 'session',
  permission: 'settings:read',
  responses: { 200: { description: 'OK', schema: SettingsDto }, ...common },
});

export const updateAllowlist = defineContract({
  id: 'updateAllowlist',
  method: 'PUT',
  path: `${P}/settings/allowlist`,
  summary: 'Изменить allowlist схем диплинков и доменов',
  tags: ['settings'],
  auth: 'session',
  permission: 'settings:write',
  body: CtaAllowlistDto,
  responses: {
    200: { description: 'OK', schema: SettingsDto },
    ...common,
    400: err('Ошибка валидации'),
  },
});

export const setFeedEnabled = defineContract({
  id: 'setFeedEnabled',
  method: 'PUT',
  path: `${P}/settings/feed-enabled`,
  summary: 'Kill switch всей ленты (подтверждение повторным вводом слова)',
  tags: ['settings'],
  auth: 'session',
  permission: 'settings:write',
  body: FeedEnabledInput,
  responses: {
    200: { description: 'OK', schema: SettingsDto },
    ...common,
    400: err('Ошибка валидации'),
  },
});

export const adminContracts = [
  authLogin,
  authCallback,
  authLogout,
  authMe,
  listGroups,
  createGroup,
  getGroup,
  updateGroup,
  deleteGroup,
  duplicateGroup,
  createSlide,
  reorderSlides,
  updateSlide,
  deleteSlide,
  submitGroup,
  approveGroup,
  rejectGroup,
  publishGroup,
  unpublishGroup,
  getGroupDiff,
  getGroupPreview,
  listGroupVersions,
  createUploadUrl,
  completeUpload,
  getMedia,
  listSegments,
  getCatalogProducts,
  getGroupStats,
  listAuditLog,
  listUsers,
  setUserRoles,
  setUserStatus,
  getSettings,
  updateAllowlist,
  setFeedEnabled,
] as const;
