/**
 * Проверка CTA и ссылок по allowlist (раздел 10.4, угроза T4).
 *
 * Модуль намеренно без зависимостей: тот же код выполняется на сервере (при сохранении,
 * согласовании, публикации) и в веб-плеере перед переходом. Нативные плееры реализуют
 * те же правила по docs/player-contract.md.
 */

export interface CtaAllowlist {
  /** Схемы диплинков приложения ИДБ, например `idb`. Нижний регистр, без `:`. */
  deeplinkSchemes: string[];
  /** Домены для CTA типа `url`. Нижний регистр, punycode. Разрешены и поддомены. */
  urlDomains: string[];
}

export type CtaType = 'deeplink' | 'product' | 'category' | 'url';

export type CtaRejectReason =
  | 'invalid_format'
  | 'invalid_characters'
  | 'forbidden_scheme'
  | 'scheme_not_allowed'
  | 'not_https'
  | 'userinfo'
  | 'ip_address'
  | 'port_not_allowed'
  | 'domain_not_allowed';

export type CtaCheckResult =
  { ok: true; normalized: string } | { ok: false; reason: CtaRejectReason };

/** Схемы, которые нельзя добавить в allowlist диплинков ни при каких настройках. */
export const HARD_DENIED_SCHEMES: readonly string[] = [
  'javascript',
  'vbscript',
  'data',
  'file',
  'filesystem',
  'blob',
  'about',
  'intent',
  'content',
  'jar',
  'view-source',
  'http',
  'https',
  'ftp',
  'ws',
  'wss',
  'mailto',
  'tel',
  'sms',
];

export const CTA_VALUE_MAX_LENGTH = 2048;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SCHEME_RE = /^[a-z][a-z0-9+.-]{0,31}$/;
// Пробелы, управляющие символы, обратный слэш и символы, которые разные парсеры URL
// (WHATWG, NSURL, android.net.Uri) трактуют по-разному.
// eslint-disable-next-line no-control-regex -- управляющие символы запрещены намеренно
const UNSAFE_CHARS_RE = /[\s\u0000-\u001F\u007F-\u009F\\<>"`{}|^\u202A-\u202E\u2066-\u2069\uFEFF]/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

function reject(reason: CtaRejectReason): CtaCheckResult {
  return { ok: false, reason };
}

function schemeOf(value: string): string | null {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value);
  return m?.[1] ? m[1].toLowerCase() : null;
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isIpHost(hostname: string): boolean {
  return hostname.startsWith('[') || IPV4_RE.test(hostname);
}

export function hostMatchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/** Проверяет значение CTA. Возвращает нормализованное значение, которое и нужно сохранять. */
export function checkCta(type: CtaType, rawValue: string, allowlist: CtaAllowlist): CtaCheckResult {
  const value = rawValue.trim();
  if (value.length === 0 || value.length > CTA_VALUE_MAX_LENGTH) return reject('invalid_format');
  if (UNSAFE_CHARS_RE.test(value)) return reject('invalid_characters');

  switch (type) {
    case 'product':
    case 'category':
      return ID_RE.test(value) ? { ok: true, normalized: value } : reject('invalid_format');
    case 'deeplink':
      return checkDeeplink(value, allowlist);
    case 'url':
      return checkHttpsUrl(value, allowlist);
    default:
      return reject('invalid_format');
  }
}

function checkDeeplink(value: string, allowlist: CtaAllowlist): CtaCheckResult {
  const scheme = schemeOf(value);
  if (!scheme) return reject('invalid_format');
  if (HARD_DENIED_SCHEMES.includes(scheme)) return reject('forbidden_scheme');
  if (!allowlist.deeplinkSchemes.includes(scheme)) return reject('scheme_not_allowed');
  const url = parseUrl(value);
  if (!url) return reject('invalid_format');
  if (url.username !== '' || url.password !== '') return reject('userinfo');
  return { ok: true, normalized: url.href };
}

function checkHttpsUrl(value: string, allowlist: CtaAllowlist): CtaCheckResult {
  const scheme = schemeOf(value);
  if (!scheme) return reject('invalid_format');
  if (scheme !== 'https') {
    return HARD_DENIED_SCHEMES.includes(scheme) && scheme !== 'http'
      ? reject('forbidden_scheme')
      : reject('not_https');
  }
  const url = parseUrl(value);
  if (!url || url.protocol !== 'https:') return reject('invalid_format');
  if (url.username !== '' || url.password !== '') return reject('userinfo');
  if (url.port !== '') return reject('port_not_allowed');
  // WHATWG URL уже привёл хост к нижнему регистру и punycode, а числовые формы IPv4 — к dotted.
  const host = url.hostname;
  if (isIpHost(host)) return reject('ip_address');
  if (host.endsWith('.')) return reject('domain_not_allowed');
  if (!allowlist.urlDomains.some((d) => hostMatchesDomain(host, d))) {
    return reject('domain_not_allowed');
  }
  return { ok: true, normalized: url.href };
}

/** Добавляет параметр атрибуции story_ref=<group_id>:<slide_id> (раздел 8). */
export function withStoryRef(value: string, groupId: string, slideId: string): string {
  const url = new URL(value);
  url.searchParams.set('story_ref', `${groupId}:${slideId}`);
  return url.href;
}

/** Медиа загружаются только с разрешённых origin (CDN сервиса, в админке — хост подписанных URL). */
export function isAllowedMediaUrl(value: string, allowedOrigins: readonly string[]): boolean {
  const url = parseUrl(value);
  if (!url) return false;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.username !== '' || url.password !== '') return false;
  return allowedOrigins.includes(url.origin);
}

// ---------------------------------------------------------------------------
// Валидация самого allowlist (при сохранении администратором)
// ---------------------------------------------------------------------------

export type AllowlistValidation =
  { ok: true; allowlist: CtaAllowlist } | { ok: false; errors: string[] };

export function normalizeDomain(input: string): string | null {
  const raw = input.trim().toLowerCase();
  if (raw.length === 0 || raw.length > 253 || /[/:@\s\\*]/.test(raw)) return null;
  const url = parseUrl(`https://${raw}/`);
  if (!url || url.hostname !== url.host) return null;
  const host = url.hostname;
  if (isIpHost(host) || host.endsWith('.')) return null;
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL_RE.test(l))) return null;
  return host;
}

export function validateAllowlist(input: CtaAllowlist): AllowlistValidation {
  const errors: string[] = [];
  const schemes = new Set<string>();
  for (const s of input.deeplinkSchemes) {
    const scheme = s.trim().toLowerCase().replace(/:$/, '');
    if (!SCHEME_RE.test(scheme)) errors.push(`Некорректная схема: ${s}`);
    else if (HARD_DENIED_SCHEMES.includes(scheme)) errors.push(`Схема запрещена: ${scheme}`);
    else schemes.add(scheme);
  }
  const domains = new Set<string>();
  for (const d of input.urlDomains) {
    const domain = normalizeDomain(d);
    if (!domain) errors.push(`Некорректный домен: ${d}`);
    else domains.add(domain);
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    allowlist: { deeplinkSchemes: [...schemes].sort(), urlDomains: [...domains].sort() },
  };
}

export const CTA_REJECT_MESSAGES: Record<CtaRejectReason, string> = {
  invalid_format: 'Некорректное значение',
  invalid_characters: 'Ссылка содержит недопустимые символы',
  forbidden_scheme: 'Схема ссылки запрещена',
  scheme_not_allowed: 'Схема диплинка не входит в allowlist',
  not_https: 'Разрешены только ссылки https',
  userinfo: 'Ссылка не может содержать логин или пароль',
  ip_address: 'IP-адреса запрещены, нужен домен',
  port_not_allowed: 'Порт в ссылке запрещён',
  domain_not_allowed: 'Домен не входит в allowlist',
};
