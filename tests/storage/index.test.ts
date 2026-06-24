import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getStorage, resetStorage } from '@/lib/storage';
import { LocalStorage } from '@/lib/storage/local';
import { S3Storage } from '@/lib/storage/s3';

describe('storage/index getStorage()', () => {
  beforeEach(() => {
    resetStorage();
  });

  afterEach(() => {
    resetStorage();
    vi.restoreAllMocks();
  });

  it('без S3-env возвращает local-инстанс', () => {
    const storage = getStorage({ NODE_ENV: 'test' });
    expect(storage).toBeInstanceOf(LocalStorage);
    expect(storage.mode).toBe('local');
  });

  it('предупреждает (console.warn) один раз про mock/local-режим', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getStorage({ NODE_ENV: 'test' });
    getStorage({ NODE_ENV: 'test' });
    getStorage({ NODE_ENV: 'test' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/mock|local|S3 не настроен/i);
  });

  it('с заданными S3_ENDPOINT+S3_BUCKET возвращает S3-инстанс', () => {
    const storage = getStorage({
      NODE_ENV: 'test',
      S3_ENDPOINT: 'http://minio:9000',
      S3_BUCKET: 'admik-media',
      S3_ACCESS_KEY: 'key',
      S3_SECRET_KEY: 'secret',
      S3_PUBLIC_URL: 'http://localhost:9000/admik-media',
    });
    expect(storage).toBeInstanceOf(S3Storage);
    expect(storage.mode).toBe('s3');
  });

  it('при частичном S3-конфиге (только endpoint без bucket) откатывается в local', () => {
    const storage = getStorage({
      NODE_ENV: 'test',
      S3_ENDPOINT: 'http://minio:9000',
    });
    expect(storage.mode).toBe('local');
  });

  it('ленивый дефолтный инстанс кешируется до reset', () => {
    const a = getStorage({ NODE_ENV: 'test' });
    const b = getStorage({ NODE_ENV: 'test' });
    expect(a).toBe(b);
    resetStorage();
    const c = getStorage({ NODE_ENV: 'test' });
    expect(c).not.toBe(a);
  });
});
