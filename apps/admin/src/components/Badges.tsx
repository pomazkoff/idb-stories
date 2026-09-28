import type { GroupStatus, MediaStatus, ScheduleState } from '@idb-stories/schema';
import { ru } from '../i18n/ru.js';

export function StatusBadge({ status }: { status: GroupStatus }) {
  return <span className={`badge badge--status-${status}`}>{ru.labels.groupStatus[status]}</span>;
}

/** Бейджи «идёт сейчас», «запланировано», «истекло» (раздел 6.2). */
export function ScheduleBadge({ schedule }: { schedule: ScheduleState }) {
  if (schedule === 'not_published') return null;
  return <span className={`badge badge--schedule-${schedule}`}>{ru.labels.schedule[schedule]}</span>;
}

export function MediaStatusBadge({ status }: { status: MediaStatus }) {
  return <span className={`badge badge--media-${status}`}>{ru.labels.mediaStatus[status]}</span>;
}
