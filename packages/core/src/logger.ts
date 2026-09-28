import { pino, stdSerializers, type DestinationStream, type Logger } from 'pino';

export type { Logger } from 'pino';

/**
 * Маскирование секретов в логах (раздел 10.9): токены, cookie сессии, подписи presigned URL,
 * коды OIDC. Применяется ко всем строковым аргументам логгера и к сообщениям ошибок.
 */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]'],
  [/(X-Amz-(?:Signature|Credential|Security-Token)=)[^&\s"'<>]+/gi, '$1[REDACTED]'],
  [/((?:__Host-)?stories_(?:sid|login)=)[^;\s"'<>]+/gi, '$1[REDACTED]'],
  [
    /([?&](?:code|state|nonce|token|access_token|id_token|refresh_token)=)[^&\s"'<>]+/gi,
    '$1[REDACTED]',
  ],
  [/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, '[REDACTED_JWT]'],
];

export function maskSecrets(value: string): string {
  let out = value;
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  return out;
}

/** Пути, которые pino вырезает из объектов логов целиком. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["set-cookie"]',
  '*.authorization',
  '*.cookie',
  '*.token',
  '*.accessToken',
  '*.idToken',
  '*.password',
  '*.secret',
  '*.csrfToken',
  '*.uploadUrl',
  'upload.url',
  'upload.headers',
];

interface SerializableRequest {
  id?: string;
  method?: string;
  url?: string;
  ip?: string;
  routeOptions?: { url?: string };
}

/** Ключи, значения которых вырезаются на любой глубине объекта. */
const SENSITIVE_KEY_RE =
  /^(authorization|cookie|set-cookie|x-csrf-token|token|access_?token|id_?token|refresh_?token|password|secret|csrf_?token|upload_?url|presigned_?url|client_?secret)$/i;

function maskDeep(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return maskSecrets(value);
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, depth + 1));
  // Экземпляры классов (запрос Fastify, Error) обрабатывают сериализаторы pino.
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      SENSITIVE_KEY_RE.test(k) ? '[REDACTED]' : maskDeep(v, depth + 1),
    ]),
  );
}

export interface LoggerOptions {
  name: string;
  level?: string;
  /** Для тестов: куда писать JSON-строки. */
  destination?: DestinationStream;
}

export function createLogger(options: LoggerOptions): Logger {
  return pino(
    {
      name: options.name,
      level: options.level ?? 'info',
      base: { service: options.name },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      serializers: {
        // Никаких заголовков и тел запросов в логах: только безопасные поля.
        req: (req: SerializableRequest) => ({
          id: req.id,
          method: req.method,
          url: req.url ? maskSecrets(req.url) : undefined,
          route: req.routeOptions?.url,
          ip: req.ip,
        }),
        res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
        err: (err: Error) => {
          const e = stdSerializers.err(err) as { message?: unknown; stack?: unknown } | undefined;
          if (!e || typeof e !== 'object') return e;
          return {
            ...e,
            message: typeof e.message === 'string' ? maskSecrets(e.message) : e.message,
            stack: typeof e.stack === 'string' ? maskSecrets(e.stack) : undefined,
          };
        },
      },
      hooks: {
        logMethod(args, method) {
          const masked = args.map((a: unknown) => maskDeep(a)) as Parameters<typeof method>;
          method.apply(this, masked);
        },
      },
    },
    options.destination,
  );
}
