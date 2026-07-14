import { describe, it, expect } from 'vitest';

import {
  resolveTranslationsUpdate,
  translationsBlockSchema,
  PRODUCT_TR_FIELDS,
} from '@/lib/i18n';
import {
  ProductUpdateSchema,
  BrandUpdateSchema,
  CategoryUpdateSchema,
} from '@/lib/catalog/schemas';
import { CmsPageUpdateSchema } from '@/lib/cms/schemas';
import type { LocaleConfig, TranslationsMap } from '@/lib/i18n';

/**
 * Write-path переводов (ADR-i18n, docs/24 §1, инкремент 2b): admin-форма шлёт блок
 * translations → resolveTranslationsUpdate фильтрует whitelist × включённые языки,
 * мержит только переданный язык, база (ru) в оверлей не пишется. Чисто, без БД.
 */

const CONFIG: LocaleConfig = { defaultLocale: 'ru', locales: ['ru', 'en', 'fr'] };

describe('resolveTranslationsUpdate — персист перевода', () => {
  it('en-перевод персистится в оверлей и читается', () => {
    const res = resolveTranslationsUpdate(
      PRODUCT_TR_FIELDS,
      { en: { name: 'Silk scarf', description: 'Soft' } },
      null,
      CONFIG,
    );
    expect(res.provided).toBe(true);
    expect(res.value.en).toEqual({ name: 'Silk scarf', description: 'Soft' });
  });

  it('whitelist отсекает не-whitelist поле (price/sku) — в оверлей не попадает', () => {
    const res = resolveTranslationsUpdate(
      PRODUCT_TR_FIELDS,
      { en: { name: 'Scarf', price: '999', sku: 'HACK' } },
      null,
      CONFIG,
    );
    expect(res.value.en).toEqual({ name: 'Scarf' });
    expect(res.value.en).not.toHaveProperty('price');
    expect(res.value.en).not.toHaveProperty('sku');
  });

  it('не-включённый язык (de) отклонён — оверлея нет', () => {
    const res = resolveTranslationsUpdate(
      PRODUCT_TR_FIELDS,
      { de: { name: 'Schal' } },
      null,
      CONFIG,
    );
    expect(res.provided).toBe(false);
    expect(res.value).not.toHaveProperty('de');
  });

  it('дефолтный язык (ru) НЕ пишется в оверлей — база = обычные колонки', () => {
    const res = resolveTranslationsUpdate(
      PRODUCT_TR_FIELDS,
      { ru: { name: 'Платок' }, en: { name: 'Scarf' } },
      null,
      CONFIG,
    );
    expect(res.value).not.toHaveProperty('ru');
    expect(res.value.en).toEqual({ name: 'Scarf' });
    expect(res.provided).toBe(true);
  });

  it('mergeTranslations не затирает перевод другого языка', () => {
    const existing: TranslationsMap = { fr: { name: 'Foulard' } };
    const res = resolveTranslationsUpdate(
      PRODUCT_TR_FIELDS,
      { en: { name: 'Scarf' } },
      existing,
      CONFIG,
    );
    expect(res.value.fr).toEqual({ name: 'Foulard' }); // не тронут
    expect(res.value.en).toEqual({ name: 'Scarf' });
    // Исходный объект не мутирован.
    expect(existing).toEqual({ fr: { name: 'Foulard' } });
  });

  it('обновление одного поля сохраняет прочие поля того же языка', () => {
    const existing: TranslationsMap = { en: { name: 'Scarf', description: 'Old' } };
    const res = resolveTranslationsUpdate(
      PRODUCT_TR_FIELDS,
      { en: { description: 'New' } },
      existing,
      CONFIG,
    );
    expect(res.value.en).toEqual({ name: 'Scarf', description: 'New' });
  });

  it('нет блока translations → provided=false, существующий оверлей сохранён', () => {
    const existing: TranslationsMap = { en: { name: 'Scarf' } };
    const res = resolveTranslationsUpdate(PRODUCT_TR_FIELDS, undefined, existing, CONFIG);
    expect(res.provided).toBe(false);
    expect(res.value).toEqual({ en: { name: 'Scarf' } });
  });

  it('пустой/только-непрошедший-фильтр вход → provided=false (колонку не трогаем)', () => {
    const resEmpty = resolveTranslationsUpdate(PRODUCT_TR_FIELDS, {}, null, CONFIG);
    expect(resEmpty.provided).toBe(false);
    const resFiltered = resolveTranslationsUpdate(
      PRODUCT_TR_FIELDS,
      { en: { price: '10' } }, // единственное поле — не-whitelist
      null,
      CONFIG,
    );
    expect(resFiltered.provided).toBe(false);
  });
});

describe('translationsBlockSchema — грубая форма входа Server Action', () => {
  it('принимает { [locale]: { [field]: string } }', () => {
    const r = translationsBlockSchema.safeParse({ en: { name: 'Scarf' } });
    expect(r.success).toBe(true);
  });

  it('отсутствие блока валидно (переводы не трогаем)', () => {
    expect(translationsBlockSchema.safeParse(undefined).success).toBe(true);
  });

  it('нестроковое значение поля → ошибка', () => {
    expect(translationsBlockSchema.safeParse({ en: { name: 123 } }).success).toBe(false);
  });
});

describe('Update-схемы сущностей принимают блок translations', () => {
  const id = '123e4567-e89b-42d3-a456-426614174000';
  const tr = { en: { name: 'Scarf' } };

  it('ProductUpdateSchema', () => {
    const r = ProductUpdateSchema.safeParse({ id, name: 'Платок', translations: tr });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.translations).toEqual(tr);
  });

  it('BrandUpdateSchema', () => {
    const r = BrandUpdateSchema.safeParse({ id, translations: tr });
    expect(r.success).toBe(true);
  });

  it('CategoryUpdateSchema', () => {
    const r = CategoryUpdateSchema.safeParse({ id, translations: tr });
    expect(r.success).toBe(true);
  });

  it('CmsPageUpdateSchema (whitelist title/seo/og)', () => {
    const r = CmsPageUpdateSchema.safeParse({
      id,
      translations: { en: { title: 'About' } },
    });
    expect(r.success).toBe(true);
  });

  it('Update без translations по-прежнему валиден (обратная совместимость)', () => {
    expect(ProductUpdateSchema.safeParse({ id, name: 'Платок' }).success).toBe(true);
  });
});
