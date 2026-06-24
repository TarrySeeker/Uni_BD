import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalStorage } from '@/lib/storage/local';

describe('storage/local LocalStorage', () => {
  let baseDir: string;
  let storage: LocalStorage;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'admik-storage-'));
    storage = new LocalStorage({ baseDir, publicBase: '/media' });
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('mode === local', () => {
    expect(storage.mode).toBe('local');
  });

  it('put сохраняет файл и возвращает key + url', async () => {
    const body = Buffer.from('hello image bytes');
    const res = await storage.put('products/p1/a.png', body, 'image/png');
    expect(res.key).toBe('products/p1/a.png');
    expect(res.url).toBe('/media/products/p1/a.png');
    expect(res.size).toBe(body.length);

    const onDisk = await fs.readFile(path.join(baseDir, 'products/p1/a.png'));
    expect(onDisk.equals(body)).toBe(true);
  });

  it('get возвращает ранее записанные байты', async () => {
    const body = Buffer.from('roundtrip-payload');
    await storage.put('products/p2/b.webp', body, 'image/webp');
    const got = await storage.get('products/p2/b.webp');
    expect(got.body.equals(body)).toBe(true);
    expect(got.contentType).toBe('image/webp');
  });

  it('delete удаляет файл', async () => {
    await storage.put('products/p3/c.png', Buffer.from('x'), 'image/png');
    await storage.delete('products/p3/c.png');
    await expect(
      fs.access(path.join(baseDir, 'products/p3/c.png')),
    ).rejects.toThrow();
  });

  it('delete несуществующего ключа не бросает', async () => {
    await expect(storage.delete('nope/missing.png')).resolves.toBeUndefined();
  });

  it('url(key) собирает публичный путь', () => {
    expect(storage.url('products/p4/d.png')).toBe('/media/products/p4/d.png');
  });

  it('защищает от path traversal в ключе', async () => {
    await expect(
      storage.put('../../etc/passwd', Buffer.from('x'), 'text/plain'),
    ).rejects.toThrow();
  });
});
