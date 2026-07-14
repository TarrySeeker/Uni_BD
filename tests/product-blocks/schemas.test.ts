import { describe, expect, it } from 'vitest';

import {
  UpsertProductBlockSchema,
  ReorderProductBlocksSchema,
  ProductBlockTypeSchema,
  blockTranslationsSchema,
  MAX_TABS,
} from '@/lib/product-blocks/schemas';

const UUID = '11111111-1111-4111-8111-111111111111';

describe('product-blocks/schemas — Zod вход', () => {
  it('ProductBlockTypeSchema принимает только известные типы', () => {
    for (const t of ['text', 'quote', 'tabs', 'image']) {
      expect(ProductBlockTypeSchema.safeParse(t).success).toBe(true);
    }
    expect(ProductBlockTypeSchema.safeParse('banner').success).toBe(false);
  });

  it('UpsertProductBlockSchema: минимальный валидный вход (create)', () => {
    const r = UpsertProductBlockSchema.safeParse({ productId: UUID, type: 'text' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.tabs).toEqual([]); // default
  });

  it('UpsertProductBlockSchema: tabs ограничены MAX_TABS', () => {
    const tooMany = Array.from({ length: MAX_TABS + 1 }, () => ({ name: 'n', text: 't' }));
    const r = UpsertProductBlockSchema.safeParse({ productId: UUID, type: 'tabs', tabs: tooMany });
    expect(r.success).toBe(false);
  });

  it('UpsertProductBlockSchema: невалидный productId → fail', () => {
    expect(UpsertProductBlockSchema.safeParse({ productId: 'x', type: 'text' }).success).toBe(false);
  });

  it('UpsertProductBlockSchema: id/authorDesignerId допускают null', () => {
    const r = UpsertProductBlockSchema.safeParse({
      productId: UUID,
      type: 'quote',
      authorDesignerId: null,
      blockquot: 'Цитата',
    });
    expect(r.success).toBe(true);
  });

  it('blockTranslationsSchema: чужие языки и не-whitelist поля отсекаются (strip)', () => {
    const schema = blockTranslationsSchema(['en', 'fr']);
    const r = schema.safeParse({
      en: { title: 'T', body: '<p>b</p>', junk: 'x' },
      fr: { blockquot: 'Citation' },
      ru: { title: 'ru-not-overlay' }, // не в списке overlay-языков
      de: { title: 'de' },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.en).toEqual({ title: 'T', body: '<p>b</p>' }); // junk отсечён
      expect(r.data.fr).toEqual({ blockquot: 'Citation' });
      expect('ru' in r.data).toBe(false);
      expect('de' in r.data).toBe(false);
    }
  });

  it('blockTranslationsSchema: структурные табы в оверлее валидны', () => {
    const schema = blockTranslationsSchema(['en']);
    const r = schema.safeParse({ en: { tabs: [{ name: 'Care', text: 'Wash cold' }] } });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.en!.tabs).toEqual([{ name: 'Care', text: 'Wash cold' }]);
  });

  it('ReorderProductBlocksSchema: массив uuid', () => {
    expect(ReorderProductBlocksSchema.safeParse({ productId: UUID, order: [UUID] }).success).toBe(true);
    expect(ReorderProductBlocksSchema.safeParse({ productId: UUID, order: ['nope'] }).success).toBe(false);
  });
});
