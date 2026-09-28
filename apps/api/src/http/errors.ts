import type { FastifyError, FastifyInstance, FastifyRequest } from 'fastify';
import type { z } from 'zod';

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown, code = 'validation_error') =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'Требуется вход') =>
  new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'Недостаточно прав', code = 'forbidden') =>
  new AppError(403, code, message);
export const notFound = (message = 'Не найдено') => new AppError(404, 'not_found', message);
export const conflict = (message: string, code = 'conflict', details?: unknown) =>
  new AppError(409, code, message, details);

export function zodDetails(error: z.ZodError) {
  return error.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code }));
}

/** Единый формат ошибок; наружу не уходят стеки и внутренние сообщения. */
export function installErrorHandler(
  app: FastifyInstance,
  hooks: { onForbidden?: (req: FastifyRequest, err: AppError) => void } = {},
): void {
  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    if (err instanceof AppError) {
      if (err.statusCode >= 500) req.log.error({ err }, 'app error');
      if (err.statusCode === 403) hooks.onForbidden?.(req, err);
      return reply.status(err.statusCode).send({
        error: {
          code: err.code,
          message: err.message,
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
        requestId: req.id,
      });
    }
    const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
    if (status === 413) {
      return reply.status(413).send({
        error: { code: 'payload_too_large', message: 'Слишком большой запрос' },
        requestId: req.id,
      });
    }
    if (status === 429) {
      return reply.status(429).send({
        error: { code: 'rate_limited', message: 'Слишком много запросов' },
        requestId: req.id,
      });
    }
    if (status >= 400 && status < 500) {
      return reply.status(status).send({
        error: {
          code:
            err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE'
              ? 'unsupported_media_type'
              : 'bad_request',
          message: 'Некорректный запрос',
        },
        requestId: req.id,
      });
    }
    req.log.error({ err }, 'unhandled error');
    return reply
      .status(500)
      .send({ error: { code: 'internal', message: 'Внутренняя ошибка' }, requestId: req.id });
  });

  app.setNotFoundHandler((req, reply) => {
    void reply
      .status(404)
      .send({ error: { code: 'not_found', message: 'Не найдено' }, requestId: req.id });
  });
}
