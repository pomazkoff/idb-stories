/**
 * Инициализация S3-хранилища для локального окружения и стендов (в проде бакеты и права
 * настраивает инфраструктура ИДБ — [ИНТЕГРАЦИЯ], политики-образцы в ops/s3/).
 *
 * - quarantine: закрыт, CORS только для PUT из админки, lifecycle 7 дней;
 * - media: закрыт (черновые медиа — только по подписанным URL);
 * - public: анонимное чтение (эмуляция CDN-origin), сюда медиа попадают только при публикации.
 * В конце проверяет, что закрытые бакеты действительно не читаются анонимно.
 */
import {
  CreateBucketCommand,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';

const env = (name: string, fallback?: string) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`${name} не задан`);
  return v;
};

const endpoint = env('S3_ENDPOINT');
const client = new S3Client({
  endpoint,
  region: env('S3_REGION', 'us-east-1'),
  forcePathStyle: true,
  credentials: {
    accessKeyId: env('S3_ACCESS_KEY_ID'),
    secretAccessKey: env('S3_SECRET_ACCESS_KEY'),
  },
});
const buckets = {
  quarantine: env('S3_BUCKET_QUARANTINE', 'stories-quarantine'),
  media: env('S3_BUCKET_MEDIA', 'stories-media'),
  public: env('S3_BUCKET_PUBLIC', 'stories-public'),
};
const adminOrigin = env('ADMIN_ORIGIN');

async function optional(what: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    console.log(`✓ ${what}`);
  } catch (err) {
    console.warn(
      `! ${what}: ${err instanceof Error ? err.message : String(err)} — настройте вручную`,
    );
  }
}

for (const bucket of Object.values(buckets)) {
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    console.log(`✓ bucket ${bucket} создан`);
  } catch (err) {
    if (err instanceof S3ServiceException && /BucketAlready(OwnedByYou|Exists)/.test(err.name)) {
      console.log(`✓ bucket ${bucket} уже есть`);
    } else throw err;
  }
}

await optional(`CORS ${buckets.quarantine}: PUT только с ${adminOrigin}`, () =>
  client.send(
    new PutBucketCorsCommand({
      Bucket: buckets.quarantine,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: [adminOrigin],
            AllowedMethods: ['PUT'],
            AllowedHeaders: ['content-type'],
            MaxAgeSeconds: 600,
          },
        ],
      },
    }),
  ),
);
await optional(`lifecycle ${buckets.quarantine}: удаление оригиналов через 7 дней`, () =>
  client.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: buckets.quarantine,
      LifecycleConfiguration: {
        Rules: [
          {
            ID: 'expire-originals',
            Status: 'Enabled',
            Filter: { Prefix: '' },
            Expiration: { Days: 7 },
          },
        ],
      },
    }),
  ),
);
await client.send(
  new PutBucketPolicyCommand({
    Bucket: buckets.public,
    Policy: JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: '*',
          Action: ['s3:GetObject'],
          Resource: [`arn:aws:s3:::${buckets.public}/*`],
        },
      ],
    }),
  }),
);
console.log(`✓ ${buckets.public}: анонимное чтение объектов (origin CDN)`);

// Проверка: закрытые бакеты не читаются без подписи (угроза T5).
for (const bucket of [buckets.quarantine, buckets.media]) {
  const key = `healthcheck/private-${Date.now()}`;
  await client.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: 'x', ContentType: 'text/plain' }),
  );
  const res = await fetch(`${endpoint.replace(/\/+$/, '')}/${bucket}/${key}`);
  if (res.ok) throw new Error(`Bucket ${bucket} читается анонимно — это недопустимо`);
  console.log(`✓ ${bucket} закрыт для анонимного чтения (HTTP ${res.status})`);
}
