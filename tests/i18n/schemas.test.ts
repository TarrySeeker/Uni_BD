import { describe, it, expect } from 'vitest';

import { translationsInputSchema, mergeTranslations } from '@/lib/i18n/schemas';
import type { TranslationsMap } from '@/lib/i18n/types';

/**
 * i18n schemas (ADR-i18n, docs/24 §1): whitelist отсекает лишние поля и языки;
 * mergeTranslations пишет только переданный язык. Чисто, без БД.
 */

const WHITELIST = ['name', 'description'] as const;
const LOCALES = ['en', 'fr'] as const;

describe('translationsInputSchema — whitelist полей и языков', () => {
  const schema = translationsInputSchema(WHITELIST, LOCALES);

  it('пропускает whitelisted-поля включённых языков', () => {
    const parsed = schema.parse({
      en: { name: 'Scarf', description: 'Soft' },
      fr: { name: 'Foulard' },
    });
    expect(parsed).toEqual({
      en: { name: 'Scarf', description: 'Soft' },
      fr: { name: 'Foulard' },
    });
  });

  it('отсекает поля вне whitelist', () => {
    const parsed = schema.parse({
      en: { name: 'Scarf', sku: 'HACK', price: 100 },
    });
    expect(parsed.en).toEqual({ name: 'Scarf' });
    expect(parsed.en).not.toHaveProperty('sku');
    expect(parsed.en).not.toHaveProperty('price');
  });

  it('отсекает языки вне набора', () => {
    const parsed = schema.parse({
      en: { name: 'Scarf' },
      de: { name: 'Schal' },
      ru: { name: 'Платок' },
    });
    expect(parsed).toHaveProperty('en');
    expect(parsed).not.toHaveProperty('de');
    expect(parsed).not.toHaveProperty('ru'); // ru не в наборе overlay-языков
  });

  it('пустой ввод → пустой объект (валиден)', () => {
    expect(schema.parse({})).toEqual({});
  });

  it('нестроковое значение поля → ошибка валидации', () => {
    const res = schema.safeParse({ en: { name: 123 } });
    expect(res.success).toBe(false);
  });

  it('превышение лимита длины → ошибка', () => {
    const short = translationsInputSchema(WHITELIST, LOCALES, { maxLength: 5 });
    expect(short.safeParse({ en: { name: 'ok' } }).success).toBe(true);
    expect(short.safeParse({ en: { name: 'too-long-value' } }).success).toBe(false);
  });
});

describe('mergeTranslations — пишет только переданный язык', () => {
  it('добавляет новый язык, не трогая существующие', () => {
    const existing: TranslationsMap = { en: { name: 'Scarf' } };
    const next = mergeTranslations(existing, 'fr', { name: 'Foulard' });
    expect(next.en).toEqual({ name: 'Scarf' }); // не тронут
    expect(next.fr).toEqual({ name: 'Foulard' });
  });

  it('обновляет поля своего языка, сохраняя прочие поля того же языка', () => {
    const existing: TranslationsMap = { en: { name: 'Scarf', description: 'Old' } };
    const next = mergeTranslations(existing, 'en', { description: 'New' });
    expect(next.en).toEqual({ name: 'Scarf', description: 'New' });
  });

  it('не мутирует исходный объект', () => {
    const existing: TranslationsMap = { en: { name: 'Scarf' } };
    const next = mergeTranslations(existing, 'fr', { name: 'Foulard' });
    expect(existing).toEqual({ en: { name: 'Scarf' } });
    expect(next).not.toBe(existing);
  });

  it('работает с пустым/отсутствующим existing', () => {
    expect(mergeTranslations(null, 'en', { name: 'Scarf' })).toEqual({ en: { name: 'Scarf' } });
    expect(mergeTranslations(undefined, 'en', { name: 'Scarf' })).toEqual({ en: { name: 'Scarf' } });
    expect(mergeTranslations({}, 'en', { name: 'Scarf' })).toEqual({ en: { name: 'Scarf' } });
  });

  it('другие языки остаются нетронутыми при повторных правках', () => {
    let acc = mergeTranslations({}, 'en', { name: 'Scarf' });
    acc = mergeTranslations(acc, 'fr', { name: 'Foulard' });
    acc = mergeTranslations(acc, 'en', { name: 'Silk scarf' });
    expect(acc.fr).toEqual({ name: 'Foulard' });
    expect(acc.en).toEqual({ name: 'Silk scarf' });
  });
});
