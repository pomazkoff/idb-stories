import { useEffect, useState } from 'react';

/** Значение, которое меняется не чаще, чем раз в `ms` (например, ревизия группы для превью). */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** Короткое уведомление об успехе: исчезает само через `ms`, чтобы не копились устаревшие сообщения. */
export function useNotice(ms = 8000): [string | null, (message: string | null) => void] {
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(null), ms);
    return () => window.clearTimeout(timer);
  }, [notice, ms]);
  return [notice, setNotice];
}
