import { describe, expect, it } from 'vitest';

import { buildBlockTranslations, localizeBlockTabs } from '@/lib/product-blocks/i18n';
import type { ProductBlockTab } from '@/lib/product-blocks';

describe('product-blocks/i18n — write-path buildBlockTranslations', () => {
  it('строит оверлей из whitelist-полей включённых языков', () => {
    const out = buildBlockTranslations(
      { en: { title: 'Title', blockquot: 'Q', body: '<p>b</p>' } },
      ['en', 'fr'],
    );
    expect(out.en).toEqual({ title: 'Title', blockquot: 'Q', body: '<p>b</p>' });
  });

  it('отбрасывает язык без содержимого (пустые строки)', () => {
    const out = buildBlockTranslations(
      { en: { title: '  ', body: '' }, fr: { title: 'Titre' } },
      ['en', 'fr'],
    );
    expect('en' in out).toBe(false);
    expect(out.fr).toEqual({ title: 'Titre' });
  });

  it('структурные табы попадают в оверлей', () => {
    const out = buildBlockTranslations(
      { en: { tabs: [{ name: 'Care', text: 'Cold' }] } },
      ['en'],
    );
    expect(out.en!.tabs).toEqual([{ name: 'Care', text: 'Cold' }]);
  });

  it('не-объект вход → пустой оверлей', () => {
    expect(buildBlockTranslations(null, ['en'])).toEqual({});
    expect(buildBlockTranslations('x', ['en'])).toEqual({});
  });
});

describe('product-blocks/i18n — read-path localizeBlockTabs (deep-merge)', () => {
  const base: ProductBlockTab[] = [
    { name: 'Уход', text: 'Стирка' },
    { name: 'Состав', text: 'Шёлк' },
  ];
  const tr = { en: { tabs: [{ name: 'Care', text: 'Wash' }] } };

  it('defaultLocale → базовые табы без изменений', () => {
    expect(localizeBlockTabs(base, tr, 'ru', 'ru')).toBe(base);
  });

  it('перевод первого таба применяется, второй — фолбэк на базу (deep-merge по индексу)', () => {
    const out = localizeBlockTabs(base, tr, 'en', 'ru');
    expect(out[0]).toEqual({ name: 'Care', text: 'Wash' });
    expect(out[1]).toEqual({ name: 'Состав', text: 'Шёлк' }); // не переведён → база
  });

  it('нет оверлея табов для языка → база', () => {
    const out = localizeBlockTabs(base, { en: { title: 'X' } }, 'en', 'ru');
    expect(out).toBe(base);
  });

  it('пустой перевод текста таба → фолбэк на базовый текст', () => {
    const out = localizeBlockTabs(base, { en: { tabs: [{ name: 'Care', text: '' }] } }, 'en', 'ru');
    expect(out[0]!.name).toBe('Care');
    expect(out[0]!.text).toBe('Стирка'); // пустой перевод не затирает базу
  });
});
