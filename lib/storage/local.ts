/**
 * LocalStorage — mock/локальная ФС-реализация ObjectStorage (docs/05 §3.3).
 *
 * Для магазина без боевых S3-ключей: файлы кладутся в локальную папку
 * (по умолчанию `.data/uploads/`), публичный URL отдаётся через локальный
 * префикс (`/media/{key}`). Контракт идентичен S3Storage — код каталога не
 * знает, какой режим активен.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  GetResult,
  ObjectStorage,
  PutResult,
  StorageMode,
} from './types';

/** Папка локального хранилища по умолчанию (в .gitignore через `data/`). */
export const DEFAULT_LOCAL_DIR = '.data/uploads';
/** Публичный префикс по умолчанию. */
export const DEFAULT_PUBLIC_BASE = '/media';

export interface LocalStorageOptions {
  /** Корневая папка хранилища. */
  baseDir?: string;
  /** Публичный префикс URL. */
  publicBase?: string;
}

/**
 * Нормализует и проверяет ключ объекта (анти-path-traversal).
 * @throws если ключ выходит за пределы baseDir.
 */
function resolveSafe(baseDir: string, key: string): string {
  const root = path.resolve(baseDir);
  const target = path.resolve(root, key);
  const rel = path.relative(root, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Недопустимый ключ объекта (path traversal): «${key}».`);
  }
  return target;
}

export class LocalStorage implements ObjectStorage {
  readonly mode: StorageMode = 'local';

  private readonly baseDir: string;
  private readonly publicBase: string;

  constructor(opts: LocalStorageOptions = {}) {
    this.baseDir = path.resolve(opts.baseDir ?? DEFAULT_LOCAL_DIR);
    // Убираем хвостовой слеш для предсказуемой сборки URL.
    this.publicBase = (opts.publicBase ?? DEFAULT_PUBLIC_BASE).replace(
      /\/+$/,
      '',
    );
  }

  async put(
    key: string,
    body: Buffer,
    _contentType: string,
  ): Promise<PutResult> {
    const target = resolveSafe(this.baseDir, key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body);
    return { key, url: this.url(key), size: body.length };
  }

  async get(key: string): Promise<GetResult> {
    const target = resolveSafe(this.baseDir, key);
    const body = await fs.readFile(target);
    return { body, size: body.length, contentType: contentTypeFromKey(key) };
  }

  async delete(key: string): Promise<void> {
    const target = resolveSafe(this.baseDir, key);
    try {
      await fs.unlink(target);
    } catch (err) {
      // Отсутствие объекта — не ошибка (идемпотентное удаление).
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }

  url(key: string): string {
    // Гарантируем ведущий слеш у key для аккуратного URL.
    const normalized = key.replace(/^\/+/, '');
    return `${this.publicBase}/${normalized}`;
  }
}

/** Грубое определение Content-Type по расширению ключа (для mock-чтения). */
function contentTypeFromKey(key: string): string | undefined {
  const ext = path.extname(key).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.avif':
      return 'image/avif';
    default:
      return undefined;
  }
}
