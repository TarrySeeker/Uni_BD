/**
 * Чистые функции цвето-свотчей товара (products.colors, миграция 0050).
 *
 * Единственный источник правды о форме payload'а: ими пользуются и форма админки
 * (собирает то, что отправляет), и Zod-схема (канонизирует hex на сервере), и
 * будущие импортёры. Без БД, без React — юнит-тестируемо.
 *
 * Легаси старой админки carre: у товара РОВНО два слота цвета — «Основной» и
 * «Дополнительный» (color_hex/master_color и color_hex_2/master_color_2), потому
 * MAX_PRODUCT_COLORS = 2. Порядок массива = порядок показа: [0] — основной.
 */

import type { ProductColor } from './types';

/** Максимум свотчей у товара (легаси: основной + дополнительный). */
export const MAX_PRODUCT_COLORS = 2;

/** Каноничная форма hex в хранилище/DTO: '#rrggbb' нижним регистром. */
const CANONICAL_HEX = /^#[0-9a-f]{6}$/;

/**
 * Приводит ввод цвета к '#rrggbb' нижним регистром.
 * Принимает '#abc', 'abc', '#AABBCC', 'AABBCC' (+ пробелы по краям).
 * Всё остальное ('red', '#ff', пустая строка, не-строка) → null.
 *
 * WHY: колорпикер браузера отдаёт '#RRGGBB', человек руками пишет как придётся,
 * а витрина сравнивает свотчи строкой — канонизируем на входе один раз.
 */
export function normalizeHex(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim().toLowerCase();
  const body = raw.startsWith('#') ? raw.slice(1) : raw;
  if (/^[0-9a-f]{3}$/.test(body)) {
    return `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`;
  }
  if (/^[0-9a-f]{6}$/.test(body)) {
    return `#${body}`;
  }
  return null;
}

/** true, если строка уже в каноничной форме '#rrggbb'. */
export function isCanonicalHex(v: unknown): v is string {
  return typeof v === 'string' && CANONICAL_HEX.test(v);
}

/**
 * Форма для биндинга в jsonb через sql.json (postgres.js требует структурный
 * JSONValue — интерфейс ProductColor под него не подходит без индексной сигнатуры).
 * Заодно гарантирует, что наружу уедут ТОЛЬКО hex/name.
 */
export function toJsonColors(
  colors: readonly ProductColor[],
): Array<{ hex: string; name: string }> {
  return colors.map((c) => ({ hex: c.hex, name: c.name }));
}

/**
 * Разбирает ХРАНИМОЕ значение products.colors (jsonb-массив ИЛИ JSON-строка —
 * исторический артефакт ETL) и нормализует его. Нужен там, где значение из БД
 * пишется обратно в БД (дублирование товара).
 */
export function parseStoredColors(v: unknown): ProductColor[] {
  if (typeof v === 'string') {
    try {
      return normalizeProductColors(JSON.parse(v));
    } catch {
      return [];
    }
  }
  return normalizeProductColors(v);
}

/**
 * Нормализует произвольный ввод в ProductColor[]:
 *  - не-массив → [];
 *  - записи без валидного hex отбрасываются (нечего красить — как asColors/ETL);
 *  - name: trim, не строка → '' (пустое имя допустимо, легаси его почти не заполнял);
 *  - обрезка до MAX_PRODUCT_COLORS, порядок сохраняется (основной → дополнительный).
 */
export function normalizeProductColors(input: unknown): ProductColor[] {
  if (!Array.isArray(input)) return [];
  const out: ProductColor[] = [];
  for (const item of input) {
    if (out.length >= MAX_PRODUCT_COLORS) break;
    if (!item || typeof item !== 'object') continue;
    const hex = normalizeHex((item as { hex?: unknown }).hex);
    if (!hex) continue;
    const rawName = (item as { name?: unknown }).name;
    out.push({ hex, name: typeof rawName === 'string' ? rawName.trim() : '' });
  }
  return out;
}
