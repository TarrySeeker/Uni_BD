/**
 * S3Storage — S3-совместимая реализация ObjectStorage (docs/05 §3.3).
 *
 * Работает с MinIO (локально), Timeweb и AWS. Для MinIO/совместимых обычно
 * нужен path-style доступ (`forcePathStyle: true`) — включается, когда задан
 * кастомный S3_ENDPOINT (не AWS). Креды/endpoint/region — из env (getEnv).
 * Публичный URL = S3_PUBLIC_URL + key.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import type {
  GetResult,
  ObjectStorage,
  PutResult,
  StorageMode,
} from './types';

export interface S3StorageConfig {
  endpoint?: string;
  region?: string;
  accessKey?: string;
  secretKey?: string;
  bucket: string;
  /** Публичный базовый URL (без хвостового слеша обязательно не нужно). */
  publicUrl?: string;
  /** Принудительный path-style (MinIO/совместимые). */
  forcePathStyle?: boolean;
}

/** Собирает поток/массив частей тела ответа S3 в Buffer. */
async function streamToBuffer(body: unknown): Promise<Buffer> {
  // aws-sdk v3 отдаёт SdkStream с удобным transformToByteArray в Node/браузере.
  const maybe = body as {
    transformToByteArray?: () => Promise<Uint8Array>;
  } | null;
  if (maybe?.transformToByteArray) {
    return Buffer.from(await maybe.transformToByteArray());
  }
  // Фолбэк: async-iterable поток.
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export class S3Storage implements ObjectStorage {
  readonly mode: StorageMode = 's3';

  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicUrl: string;

  constructor(config: S3StorageConfig) {
    this.bucket = config.bucket;
    this.publicUrl = (config.publicUrl ?? '').replace(/\/+$/, '');

    const hasCustomEndpoint = Boolean(config.endpoint);
    this.client = new S3Client({
      ...(config.region ? { region: config.region } : { region: 'us-east-1' }),
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      // По умолчанию path-style при кастомном endpoint (MinIO/Timeweb),
      // если явно не переопределено.
      forcePathStyle: config.forcePathStyle ?? hasCustomEndpoint,
      ...(config.accessKey && config.secretKey
        ? {
            credentials: {
              accessKeyId: config.accessKey,
              secretAccessKey: config.secretKey,
            },
          }
        : {}),
    });
  }

  async put(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<PutResult> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    return { key, url: this.url(key), size: body.length };
  }

  async get(key: string): Promise<GetResult> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const buffer = await streamToBuffer(res.Body);
    return {
      body: buffer,
      size: buffer.length,
      contentType: res.ContentType,
    };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  url(key: string): string {
    const normalized = key.replace(/^\/+/, '');
    return `${this.publicUrl}/${normalized}`;
  }
}
