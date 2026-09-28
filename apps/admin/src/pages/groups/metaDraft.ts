import {
  GroupCreateInput,
  GroupUpdateInput,
  PLATFORMS,
  type Placement,
  type Platform,
} from '@idb-stories/schema';
import type { AdminGroup } from '../../api/types.js';
import { ru } from '../../i18n/ru.js';
import { defaultSchedule, isoToLocalInput, localInputToIso } from '../../lib/datetime.js';
import { validate, type FieldErrors } from '../../lib/validation.js';

/** Состояние формы параметров группы (строки — как в полях ввода). */
export interface MetaDraft {
  title: string;
  placement: Placement;
  priority: string;
  /** datetime-local в часовом поясе браузера */
  start: string;
  end: string;
  platforms: Platform[];
  minIos: string;
  minAndroid: string;
  segmentIds: string[];
  coverAssetId: string | null;
}

export function newGroupDraft(now?: Date): MetaDraft {
  const { start, end } = defaultSchedule(now);
  return {
    title: '',
    placement: 'home',
    priority: '0',
    start,
    end,
    platforms: [...PLATFORMS],
    minIos: '',
    minAndroid: '',
    segmentIds: [],
    coverAssetId: null,
  };
}

export function draftFromGroup(g: AdminGroup): MetaDraft {
  return {
    title: g.title,
    placement: g.placement,
    priority: String(g.priority),
    start: isoToLocalInput(g.startAt),
    end: isoToLocalInput(g.endAt),
    platforms: PLATFORMS.filter((p) => g.platforms.includes(p)),
    minIos: g.minAppVersion.ios ?? '',
    minAndroid: g.minAppVersion.android ?? '',
    segmentIds: [...g.segmentIds].sort(),
    coverAssetId: g.coverAssetId,
  };
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

type DraftKey = keyof MetaDraft;

function changedKeys(draft: MetaDraft, base: MetaDraft): DraftKey[] {
  return (Object.keys(draft) as DraftKey[]).filter((key) => {
    const a = draft[key];
    const b = base[key];
    if (Array.isArray(a) && Array.isArray(b)) return !sameSet(a, b);
    if (typeof a === 'string' && typeof b === 'string' && key !== 'title') return a.trim() !== b.trim();
    return a !== b;
  });
}

export function isDirty(draft: MetaDraft, base: MetaDraft): boolean {
  return changedKeys(draft, base).length > 0;
}

interface PayloadFields {
  title?: string;
  placement?: Placement;
  priority?: number;
  startAt?: string;
  endAt?: string;
  platforms?: Platform[];
  minAppVersion?: { ios: string | null; android: string | null };
  segmentIds?: string[];
  coverAssetId?: string | null;
}

/** Поля формы → поля API; проверка дат, которую схема не может сделать для строк datetime-local. */
function buildFields(draft: MetaDraft, keys: readonly DraftKey[]): { fields: PayloadFields; errors: FieldErrors } {
  const fields: PayloadFields = {};
  const errors: FieldErrors = {};
  const want = new Set(keys);
  if (want.has('title')) fields.title = draft.title;
  if (want.has('placement')) fields.placement = draft.placement;
  if (want.has('priority')) {
    const trimmed = draft.priority.trim();
    const n = trimmed === '' ? Number.NaN : Number(trimmed);
    if (!Number.isInteger(n) || n < -1000 || n > 1000) errors.priority = ru.validation.priorityRange;
    else fields.priority = n;
  }
  const startIso = localInputToIso(draft.start);
  const endIso = localInputToIso(draft.end);
  if (want.has('start')) {
    if (startIso) fields.startAt = startIso;
    else errors.startAt = ru.validation.dateRequired;
  }
  if (want.has('end')) {
    if (endIso) fields.endAt = endIso;
    else errors.endAt = ru.validation.dateRequired;
  }
  if ((want.has('start') || want.has('end')) && startIso && endIso && Date.parse(endIso) <= Date.parse(startIso)) {
    errors.endAt = ru.validation.endAfterStart;
  }
  if (want.has('platforms')) fields.platforms = PLATFORMS.filter((p) => draft.platforms.includes(p));
  if (want.has('minIos') || want.has('minAndroid')) {
    fields.minAppVersion = { ios: draft.minIos.trim() || null, android: draft.minAndroid.trim() || null };
  }
  if (want.has('segmentIds')) fields.segmentIds = [...draft.segmentIds];
  if (want.has('coverAssetId')) fields.coverAssetId = draft.coverAssetId;
  return { fields, errors };
}

function friendlier(errors: FieldErrors): FieldErrors {
  const out = { ...errors };
  if (out.platforms) out.platforms = ru.validation.platformsRequired;
  if (out.priority) out.priority = ru.validation.priorityRange;
  return out;
}

export type Built<T> = { ok: true; body: T } | { ok: false; errors: FieldErrors };

export function buildCreate(draft: MetaDraft): Built<GroupCreateInput> {
  const { fields, errors } = buildFields(draft, Object.keys(draft) as DraftKey[]);
  const res = validate(GroupCreateInput, fields);
  const all = { ...(res.ok ? {} : friendlier(res.errors)), ...errors };
  if (!res.ok || Object.keys(errors).length > 0) return { ok: false, errors: all };
  return { ok: true, body: res.data };
}

/** PATCH только изменённых полей + текущая ревизия (оптимистическая блокировка). */
export function buildUpdate(draft: MetaDraft, base: MetaDraft, revision: number): Built<GroupUpdateInput> {
  const { fields, errors } = buildFields(draft, changedKeys(draft, base));
  const res = validate(GroupUpdateInput, { ...fields, revision });
  const all = { ...(res.ok ? {} : friendlier(res.errors)), ...errors };
  if (!res.ok || Object.keys(errors).length > 0) return { ok: false, errors: all };
  return { ok: true, body: res.data };
}
