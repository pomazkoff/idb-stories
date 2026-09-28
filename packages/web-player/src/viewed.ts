/**
 * Состояние «просмотрено» хранится локально: ключ на `group_id + version` (раздел 8).
 * Новая версия группы — новый ключ, то есть группа снова непросмотрена.
 * Любой доступ к Storage завёрнут в try/catch: в приватном режиме, в iframe с запретом
 * cookies или при переполнении квоты он бросает исключения.
 */
export const VIEWED_KEY_PREFIX = 'idbs:viewed:';

export function viewedKey(groupId: string, version: number): string {
  return `${VIEWED_KEY_PREFIX}${groupId}:${version}`;
}

function defaultStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export class ViewedStore {
  private readonly storage: Storage | null;
  private readonly memory = new Set<string>();

  constructor(storage: Storage | null | undefined) {
    this.storage = storage === undefined ? defaultStorage() : storage;
  }

  isViewed(groupId: string, version: number): boolean {
    const key = viewedKey(groupId, version);
    if (this.memory.has(key)) return true;
    try {
      return this.storage?.getItem(key) === '1';
    } catch {
      return false;
    }
  }

  markViewed(groupId: string, version: number): void {
    const key = viewedKey(groupId, version);
    this.memory.add(key);
    try {
      this.storage?.setItem(key, '1');
    } catch {
      // квота или запрет — остаётся состояние в памяти
    }
  }
}
