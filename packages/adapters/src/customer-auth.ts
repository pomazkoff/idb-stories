import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';

/**
 * [ИНТЕГРАЦИЯ] Проверка токена покупателя ИДБ (раздел 10.2, угроза T12).
 * Формат токена и способ проверки — открытый вопрос №2 (JWT + JWKS или introspection).
 * Сервис токены не хранит и не логирует; наружу отдаётся только user_id для запроса сегментов.
 */
export interface CustomerAuthAdapter {
  readonly kind: string;
  /**
   * Возвращает user_id для валидного токена, null — для невалидного (подпись, срок, audience).
   * Бросает AdapterUnavailableError, если проверить нельзя (IdP недоступен).
   */
  verify(token: string): Promise<{ userId: string } | null>;
}

/** Таргетинг выключен: любой запрос считается анонимным. Безопасное значение для прода до интеграции. */
export class DisabledCustomerAuthAdapter implements CustomerAuthAdapter {
  readonly kind = 'disabled';
  verify(): Promise<{ userId: string } | null> {
    return Promise.resolve(null);
  }
}

export interface MockCustomerAuthOptions {
  /** Секрет HS256. Только для dev и тестов — mock запрещено включать в production. */
  secret: string;
  issuer: string;
  audience: string;
}

/**
 * Mock: JWT HS256 с проверкой подписи, exp, iss и aud — те же проверки, что понадобятся
 * реальному адаптеру на JWKS. Алгоритм зафиксирован (защита от alg=none и подмены алгоритма).
 */
export class MockCustomerAuthAdapter implements CustomerAuthAdapter {
  readonly kind = 'mock';
  private readonly key: Uint8Array;

  constructor(private readonly options: MockCustomerAuthOptions) {
    if (options.secret.length < 32)
      throw new Error('Секрет mock-токенов должен быть не короче 32 символов');
    this.key = new TextEncoder().encode(options.secret);
  }

  async verify(token: string): Promise<{ userId: string } | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ['HS256'],
        issuer: this.options.issuer,
        audience: this.options.audience,
        requiredClaims: ['sub', 'exp'],
        clockTolerance: 5,
      });
      return typeof payload.sub === 'string' && payload.sub.length > 0
        ? { userId: payload.sub }
        : null;
    } catch (err) {
      if (err instanceof joseErrors.JOSEError) return null;
      throw err;
    }
  }

  /** Выпуск тестового токена (dev-инструменты и тесты). */
  async issue(
    userId: string,
    opts: { expiresInSec?: number; audience?: string } = {},
  ): Promise<string> {
    return new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer(this.options.issuer)
      .setAudience(opts.audience ?? this.options.audience)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + (opts.expiresInSec ?? 3600))
      .sign(this.key);
  }
}
