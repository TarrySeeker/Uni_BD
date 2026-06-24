/**
 * Абстракция хранилища медиа (ObjectStorage).
 *
 * Единый контракт с двумя реализациями:
 *  - S3Storage   — S3-совместимое (MinIO / Timeweb / AWS), боевой режим.
 *  - LocalStorage — mock/локальная ФС для магазина без боевых S3-ключей.
 *
 * Код каталога (lib/catalog/media.actions.ts) работает только с этим
 * интерфейсом и не знает, какой режим активен (docs/05 §3.3).
 */

/** Режим работы хранилища (для диагностики и логов). */
export type StorageMode = 's3' | 'local';

/** Результат успешной загрузки объекта. */
export interface PutResult {
  /** Ключ объекта в хранилище (например 'products/{id}/{uuid}.webp'). */
  key: string;
  /** Публичный URL объекта (S3_PUBLIC_URL + key либо /media/{key} в mock). */
  url: string;
  /** Размер записанного объекта в байтах. */
  size: number;
}

/** Результат чтения объекта. */
export interface GetResult {
  /** Содержимое объекта. */
  body: Buffer;
  /** MIME-тип (если известен/сохранён). */
  contentType?: string;
  /** Размер в байтах. */
  size: number;
}

/**
 * Единый интерфейс хранилища объектов.
 *
 * Ключ объекта генерируется сервером (анти-path-traversal, docs/05 §3.2):
 * имя пользовательского файла в ключ не попадает.
 */
export interface ObjectStorage {
  /** Текущий режим реализации. */
  readonly mode: StorageMode;

  /**
   * Записывает объект.
   * @param key         ключ объекта (относительный путь внутри bucket/папки)
   * @param body        содержимое
   * @param contentType реальный MIME (после magic-bytes валидации)
   */
  put(key: string, body: Buffer, contentType: string): Promise<PutResult>;

  /** Читает объект по ключу. */
  get(key: string): Promise<GetResult>;

  /** Удаляет объект по ключу. Отсутствие объекта — не ошибка. */
  delete(key: string): Promise<void>;

  /** Возвращает публичный URL объекта по ключу (без сетевых вызовов). */
  url(key: string): string;
}
