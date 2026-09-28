import type { CtaType, GroupDiff, Placement, Platform, SlideType } from '@idb-stories/schema';
import { ru } from '../i18n/ru.js';
import { formatDateTime } from './datetime.js';

/**
 * Человекочитаемый diff рабочей копии с опубликованной версией (экран согласования, раздел 6.2).
 * Пути сервера: `title`, `slides[<id>]`, `slides[<id>].elements` и т. п.; вместо id — номер слайда.
 */

export interface DiffRow {
  key: string;
  label: string;
  before: string;
  after: string;
  kind: 'changed' | 'added' | 'removed';
}

export interface DiffContext {
  /** Слайды рабочей копии в текущем порядке. */
  slideIds: readonly string[];
  segmentNames: ReadonlyMap<string, string>;
}

const SLIDE_PATH_RE = /^slides\[([^\]]+)\](?:\.(\w+))?$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

function formatValue(field: string, value: unknown, ctx: DiffContext): string {
  if (value === null || value === undefined) {
    if (field === 'coverAssetId' || field === 'mediaAssetId') return ru.diff.noFile;
    if (field === 'cta') return ru.diff.noCta;
    return ru.common.dash;
  }
  switch (field) {
    case 'placement':
      return ru.labels.placement[value as Placement] ?? str(value);
    case 'startAt':
    case 'endAt':
      return formatDateTime(str(value));
    case 'platforms':
      return Array.isArray(value)
        ? value.map((p) => ru.labels.platform[p as Platform] ?? str(p)).join(', ') || ru.common.dash
        : str(value);
    case 'minAppVersion': {
      if (!isRecord(value)) return str(value);
      return ru.diff.versions(str(value.ios) || ru.diff.anyVersion, str(value.android) || ru.diff.anyVersion);
    }
    case 'segmentIds':
      return Array.isArray(value) && value.length > 0
        ? value.map((id) => ctx.segmentNames.get(str(id)) ?? str(id)).join(', ')
        : ru.diff.allSegments;
    case 'type':
      return ru.labels.slideType[value as SlideType] ?? str(value);
    case 'durationMs':
      return typeof value === 'number' ? ru.slides.seconds(value / 1000) : str(value);
    case 'position':
      return typeof value === 'number' ? ru.diff.position(value + 1) : str(value);
    case 'elements':
      return formatElements(value);
    case 'cta':
      return formatCta(value);
    case 'productSkus':
      return Array.isArray(value) ? value.map(str).join(', ') || ru.common.dash : str(value);
    default:
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : JSON.stringify(value);
  }
}

function formatElements(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return ru.diff.noTexts;
  return value
    .map((e) => {
      if (!isRecord(e)) return '';
      const style = ru.labels.textStyle[e.style as 'title' | 'body' | 'caption'] ?? str(e.style);
      const position = ru.labels.textPosition[e.position as 'top' | 'center' | 'bottom'] ?? str(e.position);
      return ru.diff.text(str(e.text), style, position);
    })
    .filter(Boolean)
    .join('; ');
}

function formatCta(value: unknown): string {
  if (!isRecord(value)) return ru.diff.noCta;
  return ru.diff.cta(str(value.label), str(value.value), ru.labels.ctaType[value.type as CtaType] ?? str(value.type));
}

function summarizeSlide(value: unknown): string {
  if (!isRecord(value)) return ru.common.dash;
  const details: string[] = [];
  if (value.type !== 'video' && typeof value.durationMs === 'number') details.push(ru.slides.seconds(value.durationMs / 1000));
  if (Array.isArray(value.elements) && value.elements.length > 0) details.push(formatElements(value.elements));
  if (value.cta) details.push(formatCta(value.cta));
  if (Array.isArray(value.productSkus) && value.productSkus.length > 0) details.push(value.productSkus.map(str).join(', '));
  return ru.diff.slideSummary(ru.labels.slideType[value.type as SlideType] ?? str(value.type), details.join(' · '));
}

function mediaChange(before: unknown, after: unknown): [string, string] {
  if (before && after) return [ru.diff.oldFile, ru.diff.newFile];
  return [before ? ru.diff.oldFile : ru.diff.noFile, after ? ru.diff.newFile : ru.diff.noFile];
}

export function describeDiff(diff: GroupDiff, ctx: DiffContext): DiffRow[] {
  return diff.changes.map((change, index): DiffRow => {
    const key = `${change.path}#${index}`;
    const m = SLIDE_PATH_RE.exec(change.path);
    if (!m) {
      const field = change.path;
      const label = ru.diff.fields[field] ?? field;
      const [before, after] =
        field === 'coverAssetId'
          ? mediaChange(change.before, change.after)
          : [formatValue(field, change.before, ctx), formatValue(field, change.after, ctx)];
      return { key, label, before, after, kind: 'changed' };
    }
    const slideId = m[1] ?? '';
    const field = m[2];
    const current = ctx.slideIds.indexOf(slideId);
    const beforePosition = isRecord(change.before) && typeof change.before.position === 'number' ? change.before.position : -1;
    const number = current >= 0 ? current + 1 : beforePosition + 1;

    if (!field) {
      if (change.before === null) {
        return { key, label: ru.diff.slideAdded(number), before: ru.common.dash, after: summarizeSlide(change.after), kind: 'added' };
      }
      return {
        key,
        label: number > 0 ? ru.diff.slideRemoved(number) : ru.diff.removedSlide,
        before: summarizeSlide(change.before),
        after: ru.common.dash,
        kind: 'removed',
      };
    }
    const fieldLabel = ru.diff.slideFields[field] ?? field;
    const [before, after] =
      field === 'mediaAssetId'
        ? mediaChange(change.before, change.after)
        : [formatValue(field, change.before, ctx), formatValue(field, change.after, ctx)];
    return { key, label: ru.diff.slideField(number, fieldLabel), before, after, kind: 'changed' };
  });
}
