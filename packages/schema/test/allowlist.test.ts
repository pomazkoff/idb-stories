import { describe, expect, it } from 'vitest';
import {
  checkCta,
  isAllowedMediaUrl,
  normalizeDomain,
  validateAllowlist,
  withStoryRef,
  type CtaAllowlist,
} from '../src/allowlist.js';

const allowlist: CtaAllowlist = { deeplinkSchemes: ['idb'], urlDomains: ['iledebeaute.ru'] };

const rejected = (type: Parameters<typeof checkCta>[0], value: string) => {
  const res = checkCta(type, value, allowlist);
  return res.ok ? null : res.reason;
};

describe('checkCta — раздел 10.11: отклоняются опасные CTA', () => {
  it.each([
    ['javascript:', 'url', 'javascript:alert(1)', 'forbidden_scheme'],
    ['JavaScript в разном регистре', 'url', 'JaVaScRiPt:alert(1)', 'forbidden_scheme'],
    ['data:', 'url', 'data:text/html,<script>alert(1)</script>', 'invalid_characters'],
    ['data: без спецсимволов', 'url', 'data:text/html;base64,PHNjcmlwdD4=', 'forbidden_scheme'],
    ['file:', 'url', 'file:///etc/passwd', 'forbidden_scheme'],
    ['intent:', 'deeplink', 'intent://scan/#Intent;scheme=zxing;end', 'forbidden_scheme'],
    ['javascript: как диплинк', 'deeplink', 'javascript:alert(1)', 'forbidden_scheme'],
    ['http вместо https', 'url', 'http://iledebeaute.ru/', 'not_https'],
    ['чужой домен', 'url', 'https://evil.com/', 'domain_not_allowed'],
    ['домен-суффикс без точки', 'url', 'https://evililedebeaute.ru/', 'domain_not_allowed'],
    [
      'домен ИДБ как поддомен чужого',
      'url',
      'https://iledebeaute.ru.evil.com/',
      'domain_not_allowed',
    ],
    ['userinfo', 'url', 'https://iledebeaute.ru@evil.com/', 'userinfo'],
    ['userinfo с паролем', 'url', 'https://user:pass@iledebeaute.ru/', 'userinfo'],
    ['IPv4', 'url', 'https://127.0.0.1/', 'ip_address'],
    ['IPv4 в hex', 'url', 'https://0x7f.0.0.1/', 'ip_address'],
    ['IPv4 десятичным числом', 'url', 'https://2130706433/', 'ip_address'],
    ['IPv6', 'url', 'https://[::1]/', 'ip_address'],
    [
      'punycode-двойник (кириллическая «е»)',
      'url',
      'https://ilеdebeaute.ru/',
      'domain_not_allowed',
    ],
    [
      'punycode-двойник в явном виде',
      'url',
      'https://xn--ildebeaute-lsi.ru/',
      'domain_not_allowed',
    ],
    [
      'обратный слэш (расхождение парсеров)',
      'url',
      'https://evil.com\\@iledebeaute.ru/',
      'invalid_characters',
    ],
    ['пробел в ссылке', 'url', 'https://iledebeaute.ru/ a', 'invalid_characters'],
    ['перевод строки', 'url', 'https://iledebeaute.ru/\nx', 'invalid_characters'],
    ['нестандартный порт', 'url', 'https://iledebeaute.ru:8443/', 'port_not_allowed'],
    ['завершающая точка в хосте', 'url', 'https://iledebeaute.ru./', 'domain_not_allowed'],
    ['схема диплинка не из allowlist', 'deeplink', 'other://x', 'scheme_not_allowed'],
    ['userinfo в диплинке', 'deeplink', 'idb://user@catalog/1', 'userinfo'],
    ['SKU с HTML', 'product', '<img src=x>', 'invalid_characters'],
    ['категория с пробелом', 'category', 'cat 1', 'invalid_characters'],
    ['пустое значение', 'url', '   ', 'invalid_format'],
  ] as const)('%s', (_name, type, value, reason) => {
    expect(rejected(type, value)).toBe(reason);
  });

  it('bidi-override в ссылке', () => {
    expect(rejected('url', 'https://iledebeaute.ru/\u202Eevil')).toBe('invalid_characters');
  });

  it('слишком длинное значение', () => {
    expect(rejected('url', `https://iledebeaute.ru/${'a'.repeat(3000)}`)).toBe('invalid_format');
  });
});

describe('checkCta — допустимые значения нормализуются', () => {
  it('домен и поддомен', () => {
    expect(checkCta('url', 'https://iledebeaute.ru/catalog', allowlist)).toEqual({
      ok: true,
      normalized: 'https://iledebeaute.ru/catalog',
    });
    expect(checkCta('url', 'HTTPS://WWW.IleDeBeaute.RU/x?a=1', allowlist)).toEqual({
      ok: true,
      normalized: 'https://www.iledebeaute.ru/x?a=1',
    });
  });

  it('порт 443 по умолчанию допустим', () => {
    expect(checkCta('url', 'https://iledebeaute.ru:443/', allowlist).ok).toBe(true);
  });

  it('диплинк приложения', () => {
    expect(checkCta('deeplink', 'idb://catalog/123?utm=1', allowlist)).toEqual({
      ok: true,
      normalized: 'idb://catalog/123?utm=1',
    });
    expect(checkCta('deeplink', 'IDB://product/1', allowlist).ok).toBe(true);
  });

  it('SKU и категория', () => {
    expect(checkCta('product', 'SKU001', allowlist)).toEqual({ ok: true, normalized: 'SKU001' });
    expect(checkCta('category', 'cat_123', allowlist)).toEqual({ ok: true, normalized: 'cat_123' });
  });

  it('пустой allowlist запрещает всё', () => {
    const empty = { deeplinkSchemes: [], urlDomains: [] };
    expect(checkCta('url', 'https://iledebeaute.ru/', empty).ok).toBe(false);
    expect(checkCta('deeplink', 'idb://x', empty).ok).toBe(false);
  });
});

describe('withStoryRef', () => {
  it('добавляет параметр атрибуции к диплинку и url', () => {
    expect(withStoryRef('idb://catalog/1?a=1', 'g1', 's1')).toBe(
      'idb://catalog/1?a=1&story_ref=g1%3As1',
    );
    expect(withStoryRef('https://iledebeaute.ru/x', 'g', 's')).toBe(
      'https://iledebeaute.ru/x?story_ref=g%3As',
    );
  });

  it('перезаписывает подложенный story_ref', () => {
    expect(withStoryRef('idb://x?story_ref=evil', 'g', 's')).toBe('idb://x?story_ref=g%3As');
  });
});

describe('isAllowedMediaUrl', () => {
  const origins = ['https://cdn.stories.example'];
  it('разрешает только точный origin CDN', () => {
    expect(isAllowedMediaUrl('https://cdn.stories.example/a/1.webp', origins)).toBe(true);
    expect(isAllowedMediaUrl('https://cdn.stories.example.evil.com/a.webp', origins)).toBe(false);
    expect(isAllowedMediaUrl('http://cdn.stories.example/a.webp', origins)).toBe(false);
    expect(isAllowedMediaUrl('https://user@cdn.stories.example/a.webp', origins)).toBe(false);
    expect(isAllowedMediaUrl('javascript:alert(1)', origins)).toBe(false);
    expect(isAllowedMediaUrl('not a url', origins)).toBe(false);
  });
});

describe('validateAllowlist', () => {
  it('нормализует и сортирует', () => {
    expect(
      validateAllowlist({
        deeplinkSchemes: ['IDB:', 'idb'],
        urlDomains: ['WWW.IleDeBeaute.ru', 'iledebeaute.ru'],
      }),
    ).toEqual({
      ok: true,
      allowlist: { deeplinkSchemes: ['idb'], urlDomains: ['iledebeaute.ru', 'www.iledebeaute.ru'] },
    });
  });

  it('не даёт добавить опасные схемы и некорректные домены', () => {
    const res = validateAllowlist({
      deeplinkSchemes: ['javascript', 'https', 'data', 'intent', '1bad'],
      urlDomains: [
        'ru',
        '127.0.0.1',
        '*.evil.com',
        'evil.com/path',
        'user@evil.com',
        'evil.com:443',
      ],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toHaveLength(11);
  });

  it('домены в punycode', () => {
    expect(normalizeDomain('пример.рф')).toBe('xn--e1afmkfd.xn--p1ai');
  });
});
