import { ru } from '../i18n/ru.js';
import { formatDateTime } from '../lib/datetime.js';

/** Период показа: даты не разрываются посередине, перенос — только между началом и концом. */
export function Period({ start, end }: { start: string; end: string }) {
  return (
    <>
      <span className="nowrap">{formatDateTime(start)}</span>
      {ru.groups.periodSeparator}
      <span className="nowrap">{formatDateTime(end)}</span>
    </>
  );
}
