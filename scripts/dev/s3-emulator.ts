/**
 * Минимальный S3-эмулятор ТОЛЬКО для локальной разработки без Docker (pnpm dev:local).
 * Не граница безопасности и не замена S3: в compose, CI и проде используется настоящее хранилище.
 *
 * Поддерживает то, что нужно сервису: CreateBucket, Put/Get/Head/Delete/CopyObject, политики
 * (анонимное чтение бакета), CORS, lifecycle (хранится, не применяется). Проверяет подписи SigV4 —
 * и заголовочные (SDK), и presigned URL (срок, подписанные content-type/content-length).
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile, copyFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

export interface S3EmulatorOptions {
  port: number;
  dataDir: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  log?: (msg: string) => void;
}

interface BucketConfig {
  publicRead: boolean;
  cors: { origins: string[]; methods: string[]; headers: string[] }[];
}

const xmlEscape = (s: string) => s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);
const sha256hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) =>
  createHmac('sha256', key).update(data).digest();

function s3Encode(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export async function startS3Emulator(opts: S3EmulatorOptions) {
  const region = opts.region ?? 'us-east-1';
  const log = opts.log ?? (() => {});
  const root = path.resolve(opts.dataDir);
  await mkdir(root, { recursive: true });

  const bucketDir = (b: string) => path.join(root, b);
  const objectPath = (b: string, key: string) => {
    const p = path.resolve(
      bucketDir(b),
      'objects',
      ...key.split('/').map((s) => encodeURIComponent(s)),
    );
    if (!p.startsWith(path.resolve(bucketDir(b), 'objects') + path.sep)) throw new Error('bad key');
    return p;
  };
  const readConfig = async (b: string): Promise<BucketConfig | null> => {
    try {
      return JSON.parse(
        await readFile(path.join(bucketDir(b), 'config.json'), 'utf8'),
      ) as BucketConfig;
    } catch {
      return null;
    }
  };
  const writeConfig = (b: string, c: BucketConfig) =>
    writeFile(path.join(bucketDir(b), 'config.json'), JSON.stringify(c));

  function sendError(res: ServerResponse, status: number, code: string, message = code) {
    res.writeHead(status, { 'content-type': 'application/xml' });
    res.end(
      `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${xmlEscape(message)}</Message></Error>`,
    );
  }

  /** Проверка подписи SigV4 (заголовок Authorization или presigned query). */
  /** 'ok', 'anonymous' или код ошибки S3 с пояснением. */
  function verify(req: IncomingMessage, url: URL): string {
    const query = url.searchParams;
    const presigned = query.has('X-Amz-Signature');
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos
    const auth = req.headers.authorization;
    if (!presigned && !auth) return 'anonymous';

    let credential: string, signedHeaders: string, signature: string, amzDate: string;
    let payloadHash: string;
    if (presigned) {
      credential = query.get('X-Amz-Credential') ?? '';
      signedHeaders = query.get('X-Amz-SignedHeaders') ?? '';
      signature = query.get('X-Amz-Signature') ?? '';
      amzDate = query.get('X-Amz-Date') ?? '';
      payloadHash = 'UNSIGNED-PAYLOAD';
      const expires = Number(query.get('X-Amz-Expires') ?? '0');
      const t = Date.parse(
        amzDate.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'),
      );
      if (!Number.isFinite(t) || Date.now() > t + expires * 1000)
        return 'AccessDenied: Request has expired';
    } else {
      const m = /Credential=([^,]+),\s*SignedHeaders=([^,]+),\s*Signature=([0-9a-f]+)/.exec(
        auth ?? '',
      );
      if (!m) return 'AccessDenied: bad authorization header';
      [, credential = '', signedHeaders = '', signature = ''] = m;
      amzDate = String(req.headers['x-amz-date'] ?? '');
      payloadHash = String(req.headers['x-amz-content-sha256'] ?? 'UNSIGNED-PAYLOAD');
    }
    const [accessKey, date, credRegion, service] = credential.split('/');
    if (accessKey !== opts.accessKeyId) return 'InvalidAccessKeyId';
    const canonicalQuery = [...query.entries()]
      .filter(([k]) => k !== 'X-Amz-Signature')
      .map(([k, v]) => [s3Encode(k), s3Encode(v)] as const)
      .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    const canonicalHeaders = signedHeaders
      .split(';')
      .map(
        (h) =>
          `${h}:${String(req.headers[h] ?? '')
            .trim()
            .replace(/\s+/g, ' ')}\n`,
      )
      .join('');
    const canonicalUri = url.pathname
      .split('/')
      .map((s) => s3Encode(decodeURIComponent(s)))
      .join('/');
    const canonicalRequest = [
      req.method,
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');
    const scope = `${date}/${credRegion}/${service}/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join(
      '\n',
    );
    const kDate = hmac(`AWS4${opts.secretAccessKey}`, date ?? '');
    const kSigning = hmac(hmac(hmac(kDate, credRegion ?? region), service ?? 's3'), 'aws4_request');
    const expected = hmac(kSigning, stringToSign).toString('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b) ? 'ok' : 'SignatureDoesNotMatch';
  }

  function corsHeaders(config: BucketConfig | null, origin: string | undefined, method: string) {
    if (!origin || !config) return null;
    const rule = config.cors.find((r) => r.origins.includes(origin) || r.origins.includes('*'));
    if (!rule || !rule.methods.includes(method)) return null;
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': rule.methods.join(', '),
      'access-control-allow-headers': rule.headers.join(', ') || 'content-type',
      'access-control-max-age': '600',
      vary: 'Origin',
    };
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log(`s3-emulator error: ${String(err)}`);
      if (!res.headersSent) sendError(res, 500, 'InternalError');
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const [, bucket = '', ...rest] = url.pathname.split('/');
    const key = rest.map((s) => decodeURIComponent(s)).join('/');
    const method = req.method ?? 'GET';
    if (!/^[a-z0-9.-]{3,63}$/.test(bucket)) return sendError(res, 400, 'InvalidBucketName');
    const config = await readConfig(bucket);

    if (method === 'OPTIONS') {
      const requested = String(req.headers['access-control-request-method'] ?? '');
      const cors = corsHeaders(config, req.headers.origin, requested);
      if (!cors) return sendError(res, 403, 'CORSResponse', 'CORS not allowed');
      res.writeHead(200, cors);
      return res.end();
    }

    const auth = verify(req, url);
    const cors: Record<string, string> = corsHeaders(config, req.headers.origin, method) ?? {};
    const anonymousRead =
      auth === 'anonymous' && (method === 'GET' || method === 'HEAD') && key && config?.publicRead;
    if (auth !== 'ok' && !anonymousRead) {
      log(`deny ${method} ${url.pathname}: ${auth}`);
      // nosemgrep: javascript.express.security.cors-misconfiguration.cors-misconfiguration
      res.setHeader('access-control-allow-origin', cors['access-control-allow-origin'] ?? '');
      return sendError(
        res,
        403,
        auth === 'anonymous' ? 'AccessDenied' : (auth.split(':')[0] ?? 'AccessDenied'),
        auth,
      );
    }

    if (!key) {
      if (method !== 'PUT') return sendError(res, 501, 'NotImplemented');
      if (url.searchParams.has('policy')) {
        const body = await readBody(req);
        const policy = JSON.parse(body.toString()) as {
          Statement?: { Effect?: string; Principal?: unknown; Action?: string[] }[];
        };
        const publicRead = (policy.Statement ?? []).some(
          (s) =>
            s.Effect === 'Allow' &&
            (s.Principal === '*' || JSON.stringify(s.Principal).includes('"*"')) &&
            (s.Action ?? []).includes('s3:GetObject'),
        );
        await writeConfig(bucket, { ...(config ?? { cors: [] }), publicRead });
        res.writeHead(204);
        return res.end();
      }
      if (url.searchParams.has('cors')) {
        const xml = (await readBody(req)).toString();
        const rules = [...xml.matchAll(/<CORSRule>([\s\S]*?)<\/CORSRule>/g)].map((m) => ({
          origins: [...m[1]!.matchAll(/<AllowedOrigin>(.*?)<\/AllowedOrigin>/g)].map((x) => x[1]!),
          methods: [...m[1]!.matchAll(/<AllowedMethod>(.*?)<\/AllowedMethod>/g)].map((x) => x[1]!),
          headers: [...m[1]!.matchAll(/<AllowedHeader>(.*?)<\/AllowedHeader>/g)].map((x) => x[1]!),
        }));
        await writeConfig(bucket, { ...(config ?? { publicRead: false }), cors: rules });
        res.writeHead(200);
        return res.end();
      }
      if (url.searchParams.has('lifecycle')) {
        await readBody(req);
        res.writeHead(200);
        return res.end();
      }
      if (config) return sendError(res, 409, 'BucketAlreadyOwnedByYou');
      await mkdir(path.join(bucketDir(bucket), 'objects'), { recursive: true });
      await writeConfig(bucket, { publicRead: false, cors: [] });
      res.writeHead(200, { location: `/${bucket}` });
      return res.end();
    }

    if (!config) return sendError(res, 404, 'NoSuchBucket');
    const file = objectPath(bucket, key);
    const metaFile = `${file}.meta.json`;

    if (method === 'PUT') {
      await mkdir(path.dirname(file), { recursive: true });
      const copySource = req.headers['x-amz-copy-source'];
      const meta = {
        contentType: String(req.headers['content-type'] ?? 'application/octet-stream'),
        cacheControl: req.headers['cache-control']
          ? String(req.headers['cache-control'])
          : undefined,
      };
      if (typeof copySource === 'string') {
        const [srcBucket = '', ...srcKey] = decodeURIComponent(copySource.replace(/^\//, '')).split(
          '/',
        );
        const src = objectPath(srcBucket, srcKey.join('/'));
        try {
          await copyFile(src, file);
        } catch {
          return sendError(res, 404, 'NoSuchKey');
        }
        await writeFile(metaFile, JSON.stringify(meta));
        res.writeHead(200, { 'content-type': 'application/xml' });
        return res.end(
          `<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><ETag>"${sha256hex(key).slice(0, 32)}"</ETag><LastModified>${new Date().toISOString()}</LastModified></CopyObjectResult>`,
        );
      }
      const tmp = `${file}.${process.pid}.tmp`;
      await pipeline(req, createWriteStream(tmp));
      await rename(tmp, file);
      await writeFile(metaFile, JSON.stringify(meta));
      res.writeHead(200, { etag: `"${sha256hex(key).slice(0, 32)}"`, ...cors });
      return res.end();
    }

    if (method === 'DELETE') {
      await rm(file, { force: true });
      await rm(metaFile, { force: true });
      res.writeHead(204);
      return res.end();
    }

    if (method === 'GET' || method === 'HEAD') {
      let size: number;
      try {
        size = (await stat(file)).size;
      } catch {
        return sendError(res, 404, 'NoSuchKey');
      }
      const meta = JSON.parse(await readFile(metaFile, 'utf8').catch(() => '{}')) as {
        contentType?: string;
        cacheControl?: string;
      };
      res.writeHead(200, {
        'content-type': meta.contentType ?? 'application/octet-stream',
        'content-length': String(size),
        etag: `"${sha256hex(key).slice(0, 32)}"`,
        'last-modified': new Date().toUTCString(),
        ...(meta.cacheControl ? { 'cache-control': meta.cacheControl } : {}),
        'accept-ranges': 'none',
        ...cors,
      });
      if (method === 'HEAD') return res.end();
      return void (await pipeline(createReadStream(file), res));
    }
    return sendError(res, 501, 'NotImplemented');
  }

  await new Promise<void>((resolve) => server.listen(opts.port, '127.0.0.1', resolve));
  log(`S3-эмулятор слушает http://localhost:${opts.port} (данные: ${root})`);
  return { close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}
