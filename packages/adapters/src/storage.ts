import { Readable } from 'node:stream';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * [ИНТЕГРАЦИЯ] S3-совместимое хранилище. Локально — S3-совместимый сервер из docker compose,
 * в проде — хранилище в РФ-контуре. Бакеты: quarantine (закрыт), media (обработанные черновики,
 * закрыт), public (origin CDN, туда медиа попадают только при публикации).
 */
export interface PresignedUpload {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface ObjectHead {
  size: number;
  contentType: string | undefined;
}

export interface ObjectStorage {
  readonly kind: string;
  presignPut(
    bucket: string,
    key: string,
    opts: { contentType: string; contentLength: number; expiresInSec: number },
  ): Promise<PresignedUpload>;
  presignGet(bucket: string, key: string, expiresInSec: number): Promise<string>;
  head(bucket: string, key: string): Promise<ObjectHead | null>;
  getStream(bucket: string, key: string): Promise<Readable>;
  put(
    bucket: string,
    key: string,
    body: Buffer,
    opts: { contentType: string; cacheControl?: string },
  ): Promise<void>;
  copy(
    src: { bucket: string; key: string },
    dst: { bucket: string; key: string },
    opts: { contentType: string; cacheControl?: string },
  ): Promise<void>;
  delete(bucket: string, key: string): Promise<void>;
}

export interface S3StorageOptions {
  /** Эндпоинт для запросов сервиса, например http://s3:9000 внутри compose. */
  endpoint: string;
  /** Эндпоинт в подписанных URL для браузера (например, http://localhost:9000). */
  publicEndpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export class S3ObjectStorage implements ObjectStorage {
  readonly kind = 's3';
  private readonly client: S3Client;
  private readonly signer: S3Client;

  constructor(options: S3StorageOptions) {
    const make = (endpoint: string) =>
      new S3Client({
        endpoint,
        region: options.region,
        forcePathStyle: options.forcePathStyle,
        credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      });
    this.client = make(options.endpoint);
    // Подпись вычисляется локально, поэтому клиент с публичным эндпоинтом никуда не ходит.
    this.signer = options.publicEndpoint ? make(options.publicEndpoint) : this.client;
  }

  async presignPut(
    bucket: string,
    key: string,
    opts: { contentType: string; contentLength: number; expiresInSec: number },
  ): Promise<PresignedUpload> {
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: opts.contentType,
      ContentLength: opts.contentLength,
    });
    // content-type и content-length входят в подпись: загрузить другой тип или размер нельзя.
    const url = await getSignedUrl(this.signer, command, {
      expiresIn: opts.expiresInSec,
      signableHeaders: new Set(['content-type', 'content-length']),
    });
    return {
      url,
      method: 'PUT',
      headers: { 'Content-Type': opts.contentType },
      expiresAt: new Date(Date.now() + opts.expiresInSec * 1000),
    };
  }

  presignGet(bucket: string, key: string, expiresInSec: number): Promise<string> {
    return getSignedUrl(this.signer, new GetObjectCommand({ Bucket: bucket, Key: key }), {
      expiresIn: expiresInSec,
    });
  }

  async head(bucket: string, key: string): Promise<ObjectHead | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { size: res.ContentLength ?? 0, contentType: res.ContentType };
    } catch (err) {
      if (err instanceof NotFound) return null;
      if (err instanceof S3ServiceException && err.$metadata.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async getStream(bucket: string, key: string): Promise<Readable> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!(res.Body instanceof Readable)) throw new Error('Неожиданный тип тела ответа S3');
    return res.Body;
  }

  async put(
    bucket: string,
    key: string,
    body: Buffer,
    opts: { contentType: string; cacheControl?: string },
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: opts.contentType,
        CacheControl: opts.cacheControl,
      }),
    );
  }

  async copy(
    src: { bucket: string; key: string },
    dst: { bucket: string; key: string },
    opts: { contentType: string; cacheControl?: string },
  ): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: dst.bucket,
        Key: dst.key,
        CopySource: `${src.bucket}/${encodeURIComponent(src.key).replace(/%2F/g, '/')}`,
        MetadataDirective: 'REPLACE',
        ContentType: opts.contentType,
        CacheControl: opts.cacheControl,
      }),
    );
  }

  async delete(bucket: string, key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
}

interface StoredObject {
  body: Buffer;
  contentType: string;
  cacheControl?: string | undefined;
}

/** In-memory хранилище для unit- и интеграционных тестов без S3. */
export class MemoryObjectStorage implements ObjectStorage {
  readonly kind = 'memory';
  readonly objects = new Map<string, StoredObject>();
  readonly presigned: {
    bucket: string;
    key: string;
    contentType: string;
    contentLength: number;
  }[] = [];

  constructor(private readonly baseUrl = 'http://storage.test') {}

  private id(bucket: string, key: string) {
    return `${bucket}/${key}`;
  }

  presignPut(
    bucket: string,
    key: string,
    opts: { contentType: string; contentLength: number; expiresInSec: number },
  ): Promise<PresignedUpload> {
    this.presigned.push({
      bucket,
      key,
      contentType: opts.contentType,
      contentLength: opts.contentLength,
    });
    return Promise.resolve({
      url: `${this.baseUrl}/${bucket}/${key}?X-Amz-Signature=test&X-Amz-Expires=${opts.expiresInSec}`,
      method: 'PUT',
      headers: { 'Content-Type': opts.contentType },
      expiresAt: new Date(Date.now() + opts.expiresInSec * 1000),
    });
  }

  presignGet(bucket: string, key: string, expiresInSec: number): Promise<string> {
    return Promise.resolve(
      `${this.baseUrl}/${bucket}/${key}?X-Amz-Signature=test&X-Amz-Expires=${expiresInSec}`,
    );
  }

  head(bucket: string, key: string): Promise<ObjectHead | null> {
    const o = this.objects.get(this.id(bucket, key));
    return Promise.resolve(o ? { size: o.body.length, contentType: o.contentType } : null);
  }

  getStream(bucket: string, key: string): Promise<Readable> {
    const o = this.objects.get(this.id(bucket, key));
    if (!o) return Promise.reject(new Error(`NoSuchKey: ${bucket}/${key}`));
    return Promise.resolve(Readable.from([o.body]));
  }

  put(
    bucket: string,
    key: string,
    body: Buffer,
    opts: { contentType: string; cacheControl?: string },
  ): Promise<void> {
    this.objects.set(this.id(bucket, key), {
      body: Buffer.from(body),
      contentType: opts.contentType,
      cacheControl: opts.cacheControl,
    });
    return Promise.resolve();
  }

  copy(
    src: { bucket: string; key: string },
    dst: { bucket: string; key: string },
    opts: { contentType: string; cacheControl?: string },
  ): Promise<void> {
    const o = this.objects.get(this.id(src.bucket, src.key));
    if (!o) return Promise.reject(new Error(`NoSuchKey: ${src.bucket}/${src.key}`));
    this.objects.set(this.id(dst.bucket, dst.key), {
      body: o.body,
      contentType: opts.contentType,
      cacheControl: opts.cacheControl,
    });
    return Promise.resolve();
  }

  delete(bucket: string, key: string): Promise<void> {
    this.objects.delete(this.id(bucket, key));
    return Promise.resolve();
  }
}
