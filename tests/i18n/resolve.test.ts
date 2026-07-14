import { describe, it, expect } from 'vitest';

import {
  isNonEmptyValue,
  withFallback,
  localizeField,
  localizeRow,
  localizeStructured,
} from '@/lib/i18n/resolve';
import type { TranslationsMap } from '@/lib/i18n/types';

/**
 * i18n resolve (ADR-i18n, docs/24 §1): цепочка фолбэка запрошенный→default(ru)→null,
 * deep-merge структурного контента, withFallback. Чисто, без БД.
 */

const translations: TranslationsMap = {
  en: { name: 'Silk scarf', description: '<p>Soft</p>' },
  fr: { name: 'Foulard' },
};

describe('localizeField — цепочка запрошенный → default(ru) → null', () => {
  it('возвращает перевод, когда он есть', () => {
    expect(localizeField('Платок', translations, 'en', 'name')).toBe('Silk scarf');
    expect(localizeField('Платок', translations, 'fr', 'name')).toBe('Foulard');
  });

  it('для defaultLocale возвращает базовое значение (оверлей не смотрится)', () => {
    expect(localizeField('Платок', translations, 'ru', 'name')).toBe('Платок');
  });

  it('перевод поля отсутствует → фолбэк на базу (ru)', () => {
    // fr не содержит description → берём базу.
    expect(localizeField('Описание', translations, 'fr', 'description')).toBe('Описание');
  });

  it('язык вовсе отсутствует в оверлее → база', () => {
    expect(localizeField('Платок', translations, 'de', 'name')).toBe('Платок');
  });

  it('пустой перевод не побеждает базу', () => {
    const t: TranslationsMap = { en: { name: '   ' } };
    expect(localizeField('Платок', t, 'en', 'name')).toBe('Платок');
  });

  it('база null и перевода нет → null', () => {
    expect(localizeField(null, translations, 'en', 'seoTitle')).toBeNull();
    expect(localizeField(undefined, null, 'en', 'name')).toBeNull();
  });

  it('уважает нестандартный defaultLocale', () => {
    const t: TranslationsMap = { ru: { name: 'Платок' } };
    // defaultLocale=en → для 'en' возвращаем базу, для 'ru' смотрим оверлей.
    expect(localizeField('Scarf', t, 'en', 'name', 'en')).toBe('Scarf');
    expect(localizeField('Scarf', t, 'ru', 'name', 'en')).toBe('Платок');
  });
});

describe('withFallback', () => {
  it('непустой перевод побеждает', () => {
    expect(withFallback('en', 'ru')).toBe('en');
  });
  it('пустые/пробельные/nullish → база', () => {
    expect(withFallback('', 'ru')).toBe('ru');
    expect(withFallback('  ', 'ru')).toBe('ru');
    expect(withFallback(null, 'ru')).toBe('ru');
    expect(withFallback(undefined, 'ru')).toBe('ru');
  });
});

describe('isNonEmptyValue', () => {
  it.each([
    ['строка', 'x', true],
    ['пустая строка', '', false],
    ['пробелы', '  ', false],
    ['null', null, false],
    ['undefined', undefined, false],
    ['число 0', 0, true],
    ['объект', {}, true],
  ])('%s → %s', (_l, v, expected) => {
    expect(isNonEmptyValue(v)).toBe(expected);
  });
});

describe('localizeRow', () => {
  const base = { id: '1', name: 'Платок', description: 'Описание', slug: 'platok' };

  it('переводит только whitelisted-поля, остальное как в базе', () => {
    const row = localizeRow(base, translations, 'en', ['name', 'description']);
    expect(row.name).toBe('Silk scarf');
    expect(row.description).toBe('<p>Soft</p>');
    expect(row.slug).toBe('platok'); // не в whitelist — база
    expect(row.id).toBe('1');
  });

  it('для defaultLocale возвращает копию базы без изменений', () => {
    const row = localizeRow(base, translations, 'ru', ['name', 'description']);
    expect(row).toEqual(base);
    expect(row).not.toBe(base); // новый объект
  });

  it('отсутствующий перевод поля → база', () => {
    const row = localizeRow(base, translations, 'fr', ['name', 'description']);
    expect(row.name).toBe('Foulard');
    expect(row.description).toBe('Описание'); // fr не переводит description
  });
});

describe('localizeStructured — deep-merge CMS-контента', () => {
  const base = {
    type: 'hero',
    section_key: 'main',
    order: 1,
    title: 'Заголовок',
    items: [{ label: 'Один' }, { label: 'Два' }],
  };

  it('для defaultLocale возвращает базу как есть', () => {
    const t: TranslationsMap = { en: { title: 'Title' } };
    expect(localizeStructured(base, t, 'ru')).toBe(base);
  });

  it('структурные ключи из базы сохраняются, тексты подменяются', () => {
    const t: TranslationsMap = { en: { title: 'Title' } };
    const merged = localizeStructured(base, t, 'en') as typeof base;
    expect(merged.title).toBe('Title');
    expect(merged.type).toBe('hero');
    expect(merged.section_key).toBe('main');
    expect(merged.order).toBe(1);
  });

  it('массивы мержатся по индексу — неизменённые элементы из базы', () => {
    const t: TranslationsMap = { en: { items: [{ label: 'One' }] } };
    const merged = localizeStructured(base, t, 'en') as typeof base;
    expect(merged.items[0]!.label).toBe('One');
    expect(merged.items[1]!.label).toBe('Два'); // не тронут
  });

  it('язык отсутствует в оверлее → база', () => {
    expect(localizeStructured(base, translations, 'de')).toBe(base);
    expect(localizeStructured(base, null, 'en')).toBe(base);
  });
});
