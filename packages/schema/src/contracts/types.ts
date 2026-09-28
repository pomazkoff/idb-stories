import type { z } from 'zod';
import type { Permission } from '../permissions.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ResponseSpec {
  description: string;
  schema?: z.ZodType;
}

/**
 * Описание эндпоинта. Из этих описаний API регистрирует маршруты (валидация входа,
 * проверка прав), а скрипт генерирует OpenAPI 3.1 — поэтому они не расходятся.
 */
export interface RouteContract {
  /** operationId */
  id: string;
  method: HttpMethod;
  /** Полный путь в стиле Fastify: `/admin/v1/groups/:id`. */
  path: string;
  summary: string;
  tags: readonly string[];
  /**
   * public — публичный API; anonymous — admin-эндпоинты до входа (login/callback);
   * session — нужна сессия админки (и CSRF-токен для изменяющих запросов).
   */
  auth: 'public' | 'anonymous' | 'session';
  /** Для auth=session: право из матрицы. Без права — доступно любому вошедшему пользователю. */
  permission?: Permission;
  params?: z.ZodObject;
  query?: z.ZodType;
  headers?: z.ZodObject;
  body?: z.ZodType;
  /** Схема тела для документации, если рантайм-валидация устроена иначе (например, /v1/events). */
  bodyDoc?: z.ZodType;
  bodyLimit?: number;
  responses: Readonly<Record<number, ResponseSpec>>;
}

export function defineContract<const C extends RouteContract>(contract: C): C {
  return contract;
}

type InferOr<T, F> = T extends z.ZodType ? z.infer<T> : F;
export type ParamsOf<C extends RouteContract> = InferOr<C['params'], Record<string, never>>;
export type QueryOf<C extends RouteContract> = InferOr<C['query'], Record<string, never>>;
export type BodyOf<C extends RouteContract> = InferOr<C['body'], undefined>;
export type HeadersOf<C extends RouteContract> = InferOr<C['headers'], Record<string, never>>;
