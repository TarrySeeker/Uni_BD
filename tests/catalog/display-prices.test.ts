import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { listMigrations, MIGRATIONS_DIR } from '@/lib/db/migrate';
import {
  ProductCreateSchema,
  ProductUpdateSchema,
  displayPricesSchema,
} from '@/lib/catalog/schemas';

/**
 * ЭТАП 3 мультивалюты — РУЧНАЯ «круглая» цена в валюте отображения
 * (products.display_prices jsonb, миграция 0062).
 *
 * Зачем: сейчас цена в € считается делением рублёвой на курс, и покупатель видит
 * «4783,12 €» вместо «480 €». Для премиального бренда это неприемлемо. Карта
 * {"EUR":"480.00"} задаёт ТОЧНОЕ отображаемое число.
 *
 * 🔴 ГЛАВНЫЙ ИНВАРИАНТ, который сторожат эти тесты: оверрайд действует ТОЛЬКО НА
 * ПОКАЗ. base_price в рублях остаётся единственным источником истины для денег
 * (корзина, заказ, оплата). Пустая карта = прежнее поведение (пересчёт по курсу)
 * — мультитенантный анти-регресс: одновалютный магазин не меняется вовсе.
 */

function stripSqlComments(sqlText: string): string {
  return sqlText.replace(/--[^\n]*/g, '');
}

const FILE = '0062_products_display_prices.sql';

// =============================================================================
// Миграция 0062 — аддитивность и форма колонки.
// =============================================================================
describe('db/migrations — 0062 products_display_prices (юнит)', () => {
  it('миграция 0062 существует и продолжает сплошную нумерацию', async () => {
    const all = await listMigrations();
    const versions = all.map((m) => m.version);
    const expected = versions.map((_, i) => String(i + 1).padStart(4, '0'));
    expect(versions).toEqual(expected);
    expect(versions).toContain('0062');
    expect(all.find((m) => m.version === '0062')?.name).toBe('products_display_prices');
  });

  it('строго аддитивна: ADD COLUMN IF NOT EXISTS, без DROP/RENAME/ALTER TYPE', async () => {
    const sqlText = stripSqlComments(await readFile(join(MIGRATIONS_DIR, FILE), 'utf8'));
    const alters = sqlText.match(/ALTER TABLE[^;]+;/gi) ?? [];
    expect(alters.length).toBeGreaterThanOrEqual(1);
    for (const a of alters) expect(a).toMatch(/ADD COLUMN IF NOT EXISTS/i);
    expect(sqlText).not.toMatch(/DROP\s+(TABLE|COLUMN|CONSTRAINT|DEFAULT|INDEX)/i);
    expect(sqlText).not.toMatch(/RENAME/i);
    expect(sqlText).not.toMatch(/ALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE/i);
  });

  it('колонка display_prices — jsonb NOT NULL DEFAULT пустой объект', async () => {
    const sqlText = stripSqlComments(await readFile(join(MIGRATIONS_DIR, FILE), 'utf8'));
    expect(sqlText).toMatch(
      /products\s+ADD COLUMN IF NOT EXISTS display_prices\s+jsonb\s+NOT NULL\s+DEFAULT\s+'\{\}'::jsonb/i,
    );
  });
});

// =============================================================================
// Валидация карты цен.
// =============================================================================
describe('catalog/schemas — displayPricesSchema', () => {
  it('принимает валидную карту {EUR: "480.00"}', () => {
    const r = displayPricesSchema.safeParse({ EUR: '480.00' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual({ EUR: '480.00' });
  });

  it('пустая карта валидна (= считать по курсу, прежнее поведение)', () => {
    const r = displayPricesSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual({});
  });

  it('нормализует RU-запятую и регистр кода: {eur: "480,50"} → {EUR: "480.50"}', () => {
    const r = displayPricesSchema.safeParse({ eur: '480,50' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual({ EUR: '480.50' });
  });

  it('НЕИЗВЕСТНЫЕ коды валют отбрасываются (не из справочника lib/exchange/catalog)', () => {
    const r = displayPricesSchema.safeParse({ EUR: '480.00', XXX: '1.00', ZZZZ: '2.00' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual({ EUR: '480.00' });
  });

  it('пустая строка = «оверрайда нет» → ключ отбрасывается', () => {
    const r = displayPricesSchema.safeParse({ EUR: '', USD: '  ' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual({});
  });

  it('отвергает неположительные и мусорные суммы', () => {
    expect(displayPricesSchema.safeParse({ EUR: '0' }).success).toBe(false);
    expect(displayPricesSchema.safeParse({ EUR: '-5' }).success).toBe(false);
    expect(displayPricesSchema.safeParse({ EUR: 'abc' }).success).toBe(false);
    expect(displayPricesSchema.safeParse({ EUR: '1.234' }).success).toBe(false);
  });

  it('🔴 суммы — РУБЛИ/ЕВРО, не копейки: дробная часть максимум 2 знака', () => {
    expect(displayPricesSchema.safeParse({ EUR: '480.5' }).success).toBe(true);
    expect(displayPricesSchema.safeParse({ EUR: '480.50' }).success).toBe(true);
    expect(displayPricesSchema.safeParse({ EUR: '48050.001' }).success).toBe(false);
  });
});

describe('catalog/schemas — displayPrices в Create/Update', () => {
  it('Create: поле необязательно (анти-регресс существующих вызовов)', () => {
    const r = ProductCreateSchema.safeParse({ name: 'Платок' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.displayPrices).toBeUndefined();
  });

  it('Create принимает карту', () => {
    const r = ProductCreateSchema.safeParse({ name: 'Платок', displayPrices: { EUR: '480' } });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.displayPrices).toEqual({ EUR: '480' });
  });

  it('Update: «не передали» ≠ «передали пустую» (частичное обновление)', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const notSent = ProductUpdateSchema.safeParse({ id });
    expect(notSent.success).toBe(true);
    if (notSent.success) expect(notSent.data.displayPrices).toBeUndefined();

    const cleared = ProductUpdateSchema.safeParse({ id, displayPrices: {} });
    expect(cleared.success).toBe(true);
    if (cleared.success) expect(cleared.data.displayPrices).toEqual({});
  });
});
