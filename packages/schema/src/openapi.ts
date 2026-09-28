import { z } from 'zod';
import type { RouteContract } from './contracts/types.js';

type Json = Record<string, unknown>;

interface OpenApiOptions {
  title: string;
  description: string;
  version: string;
  servers: { url: string; description: string }[];
  securitySchemes: Json;
  /** Схема безопасности по типу auth контракта. */
  securityFor: (contract: RouteContract) => Json[] | undefined;
}

/**
 * Генерирует OpenAPI 3.1 из контрактов. JSON Schema 2020-12 из zod 4 совместима с OAS 3.1.
 * Именованные схемы (`.meta({ id })`) выносятся в components.schemas.
 */
export function buildOpenApi(contracts: readonly RouteContract[], options: OpenApiOptions): Json {
  const components: Record<string, Json> = {};

  const convert = (schema: z.ZodType, io: 'input' | 'output'): Json => {
    const raw = z.toJSONSchema(schema, {
      io,
      target: 'draft-2020-12',
      unrepresentable: 'any',
    }) as Json;
    const defs = (raw.$defs ?? {}) as Record<string, Json>;
    delete raw.$defs;
    delete raw.$schema;
    const rename = new Map(Object.keys(defs).map((id) => [id, id]));
    const fix = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(fix);
      if (node && typeof node === 'object') {
        const out: Json = {};
        for (const [k, v] of Object.entries(node as Json)) {
          if (k === '$ref' && typeof v === 'string' && v.startsWith('#/$defs/')) {
            const id = v.slice('#/$defs/'.length);
            out[k] = `#/components/schemas/${rename.get(id) ?? id}`;
          } else if (k === 'id' && typeof v === 'string') {
            // meta id — служебное поле zod, в OpenAPI не нужно
          } else {
            out[k] = fix(v);
          }
        }
        return out;
      }
      return node;
    };
    // Схема с тем же именем, но другим содержимым (обычно input-вариант) получает суффикс.
    // Переименование меняет ссылки в зависимых схемах, поэтому повторяем до стабилизации.
    for (let changed = true; changed;) {
      changed = false;
      for (const [id, def] of Object.entries(defs)) {
        if (rename.get(id) !== id) continue;
        const existing = components[id];
        if (existing && !same(existing, fix(def))) {
          rename.set(id, `${id}${io === 'input' ? 'Input' : 'Output'}`);
          changed = true;
        }
      }
    }
    for (const [id, def] of Object.entries(defs)) {
      components[rename.get(id) ?? id] = fix(def) as Json;
    }
    return fix(raw) as Json;
  };

  const parameters = (schema: z.ZodType | undefined, location: 'path' | 'query' | 'header') => {
    if (!schema) return [];
    const js = convert(schema, 'input');
    const props = (js.properties ?? {}) as Record<string, Json>;
    const required = new Set((js.required ?? []) as string[]);
    return Object.entries(props).map(([name, s]) => ({
      name: location === 'header' ? headerName(name) : name,
      in: location,
      required: location === 'path' ? true : required.has(name),
      schema: s,
      ...(typeof s.description === 'string' ? { description: s.description } : {}),
    }));
  };

  // Сначала ответы (output), затем входные данные (input): одинаковые именованные схемы
  // получают общее имя, а отличающиеся входные варианты — суффикс Input. Порядок детерминирован.
  const responsesById = new Map<string, Json>();
  for (const c of contracts) {
    const responses: Json = {};
    for (const [status, spec] of Object.entries(c.responses)) {
      responses[status] = spec.schema
        ? {
            description: spec.description,
            content: { 'application/json': { schema: convert(spec.schema, 'output') } },
          }
        : { description: spec.description };
    }
    responsesById.set(c.id, responses);
  }

  const paths: Record<string, Record<string, Json>> = {};
  for (const c of contracts) {
    const oasPath = c.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    const op: Json = {
      operationId: c.id,
      summary: c.summary,
      tags: [...c.tags],
    };
    const params = [
      ...parameters(c.params, 'path'),
      ...parameters(c.query, 'query'),
      ...parameters(c.headers, 'header').filter((p) => p.name.toLowerCase() !== 'authorization'),
    ];
    if (params.length > 0) op.parameters = params;
    const body = c.bodyDoc ?? c.body;
    if (body) {
      op.requestBody = {
        required: true,
        content: { 'application/json': { schema: convert(body, 'input') } },
      };
    }
    op.responses = responsesById.get(c.id);
    const security = options.securityFor(c);
    if (security) op.security = security;
    (paths[oasPath] ??= {})[c.method.toLowerCase()] = op;
  }

  return {
    openapi: '3.1.0',
    info: { title: options.title, version: options.version, description: options.description },
    servers: options.servers,
    paths: sortKeys(paths),
    components: { schemas: sortKeys(components), securitySchemes: options.securitySchemes },
  };
}

function headerName(name: string): string {
  return name
    .split('-')
    .map((p) => (p.length <= 2 ? p.toUpperCase() : p[0]!.toUpperCase() + p.slice(1)))
    .join('-');
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sortKeys<T>(obj: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}
