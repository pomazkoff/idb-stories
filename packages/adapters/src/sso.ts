import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * [ИНТЕГРАЦИЯ] Корпоративный SSO сотрудников (раздел 10.2, открытый вопрос №3: OIDC или SAML,
 * группы для маппинга ролей). Локальных паролей в сервисе нет. MFA — на стороне IdP.
 */
export interface SsoIdentity {
  subject: string;
  email: string;
  name: string;
  groups: string[];
}

/** Параметры, которые сервер хранит между редиректом на IdP и возвратом (state, nonce, PKCE). */
export interface SsoLoginState {
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface SsoAdapter {
  readonly kind: string;
  createAuthRequest(redirectUri: string): Promise<{ url: string } & SsoLoginState>;
  handleCallback(
    params: URLSearchParams,
    expected: SsoLoginState,
    redirectUri: string,
  ): Promise<SsoIdentity>;
}

export class SsoError extends Error {
  constructor(readonly reason: string) {
    super(`SSO: ${reason}`);
    this.name = 'SsoError';
  }
}

export interface MockSsoUser extends SsoIdentity {
  /** Подсказка в mock-IdP, какие роли выдаёт seed. */
  hint: string;
}

export const MOCK_SSO_USERS: readonly MockSsoUser[] = [
  {
    subject: 'mock-editor',
    email: 'editor@idb.local',
    name: 'Ева Редактор',
    groups: [],
    hint: 'editor',
  },
  {
    subject: 'mock-editor-2',
    email: 'editor2@idb.local',
    name: 'Егор Редактор',
    groups: [],
    hint: 'editor',
  },
  {
    subject: 'mock-publisher',
    email: 'publisher@idb.local',
    name: 'Павел Публикатор',
    groups: [],
    hint: 'publisher',
  },
  {
    subject: 'mock-editor-publisher',
    email: 'lead@idb.local',
    name: 'Лена Ведущая',
    groups: [],
    hint: 'editor + publisher',
  },
  {
    subject: 'mock-analyst',
    email: 'analyst@idb.local',
    name: 'Анна Аналитик',
    groups: [],
    hint: 'analyst',
  },
  {
    subject: 'mock-admin',
    email: 'admin@idb.local',
    name: 'Алексей Админ',
    groups: [],
    hint: 'admin',
  },
  {
    subject: 'mock-newcomer',
    email: 'new@idb.local',
    name: 'Новый Сотрудник',
    groups: [],
    hint: 'без ролей',
  },
];

const b64url = (buf: Buffer) => buf.toString('base64url');
export const randomToken = (bytes = 32) => b64url(randomBytes(bytes));

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Mock-IdP только для разработки. Страница выбора пользователя отдаётся самим admin API
 * (apps/api, маршрут /admin/v1/dev/mock-idp), и этот маршрут не регистрируется в production:
 * конфиг API падает при старте, если SSO_PROVIDER=mock и NODE_ENV=production.
 */
export class MockSsoAdapter implements SsoAdapter {
  readonly kind = 'mock';
  private readonly key: Buffer;

  constructor(
    private readonly options: {
      authorizeUrl: string;
      secret?: string;
      users?: readonly MockSsoUser[];
      codeTtlSec?: number;
    },
  ) {
    this.key = options.secret ? Buffer.from(options.secret) : randomBytes(32);
  }

  get users(): readonly MockSsoUser[] {
    return this.options.users ?? MOCK_SSO_USERS;
  }

  createAuthRequest(redirectUri: string): Promise<{ url: string } & SsoLoginState> {
    const state = randomToken();
    const nonce = randomToken();
    const url = new URL(this.options.authorizeUrl);
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('redirect_uri', redirectUri);
    return Promise.resolve({ url: url.href, state, nonce, codeVerifier: randomToken() });
  }

  /** Вызывается страницей mock-IdP после выбора пользователя. */
  issueCode(subject: string, nonce: string): string {
    if (!this.users.some((u) => u.subject === subject)) throw new SsoError('unknown_user');
    const exp = Math.floor(Date.now() / 1000) + (this.options.codeTtlSec ?? 60);
    const payload = b64url(Buffer.from(JSON.stringify({ sub: subject, nonce, exp })));
    return `${payload}.${this.sign(payload)}`;
  }

  handleCallback(
    params: URLSearchParams,
    expected: SsoLoginState,
    _redirectUri?: string,
  ): Promise<SsoIdentity> {
    const state = params.get('state') ?? '';
    const code = params.get('code') ?? '';
    if (!safeEqual(state, expected.state)) return Promise.reject(new SsoError('state_mismatch'));
    const [payload, sig] = code.split('.');
    if (!payload || !sig || !safeEqual(sig, this.sign(payload))) {
      return Promise.reject(new SsoError('invalid_code'));
    }
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      sub: string;
      nonce: string;
      exp: number;
    };
    if (data.exp < Math.floor(Date.now() / 1000))
      return Promise.reject(new SsoError('code_expired'));
    if (!safeEqual(data.nonce, expected.nonce))
      return Promise.reject(new SsoError('nonce_mismatch'));
    const user = this.users.find((u) => u.subject === data.sub);
    if (!user) return Promise.reject(new SsoError('unknown_user'));
    return Promise.resolve({
      subject: user.subject,
      email: user.email,
      name: user.name,
      groups: [...user.groups],
    });
  }

  private sign(payload: string): string {
    return b64url(createHmac('sha256', this.key).update(payload).digest());
  }
}
