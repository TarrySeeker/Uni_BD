import { describe, expect, it } from 'vitest';

import { slugify, isValidSlug, uniquifySlug, slugifyOrFallback } from '@/lib/catalog/slug';

// ЮНИТ: генерация slug — чистая, всегда зелёная (без БД).
describe('slugify — транслитерация и нормализация', () => {
  it('кириллица → латиница', () => {
    expect(slugify('Красное платье')).toBe('krasnoe-plate');
    expect(slugify('Тёплый шарф')).toBe('teplyy-sharf');
    expect(slugify('Щётка')).toBe('schetka');
  });

  it('пробелы (в т.ч. множественные) → одиночные дефисы, обрезка краёв', () => {
    expect(slugify('  Hello   World!! ')).toBe('hello-world');
    expect(slugify('a   b')).toBe('a-b');
  });

  it('нижний регистр и цифры сохраняются', () => {
    expect(slugify('iPhone 15 Pro')).toBe('iphone-15-pro');
    expect(slugify('ABC')).toBe('abc');
  });

  it('спецсимволы схлопываются в дефис, без двойных дефисов', () => {
    expect(slugify('foo___bar...baz')).toBe('foo-bar-baz');
    expect(slugify('!!!---!!!')).toBe('');
    expect(slugify('a/b\\c')).toBe('a-b-c');
  });

  it('мягкий/твёрдый знак выпадают', () => {
    expect(slugify('подъезд')).toBe('podezd');
  });
});

describe('isValidSlug', () => {
  it('принимает корректные slug', () => {
    expect(isValidSlug('foo-bar')).toBe(true);
    expect(isValidSlug('abc123')).toBe(true);
    expect(isValidSlug('a')).toBe(true);
  });

  it('отклоняет некорректные', () => {
    expect(isValidSlug('')).toBe(false);
    expect(isValidSlug('-foo')).toBe(false);
    expect(isValidSlug('foo-')).toBe(false);
    expect(isValidSlug('foo--bar')).toBe(false);
    expect(isValidSlug('Foo')).toBe(false);
    expect(isValidSlug('foo bar')).toBe(false);
    expect(isValidSlug('платье')).toBe(false);
  });

  it('выход slugify всегда валиден (если непуст)', () => {
    for (const s of ['Красное платье', 'iPhone 15', 'a  b  c']) {
      const out = slugify(s);
      expect(isValidSlug(out)).toBe(true);
    }
  });
});

describe('slugifyOrFallback — непустой slug даже для иероглифов/эмодзи', () => {
  it('обычное имя транслитерируется как slugify', () => {
    expect(slugifyOrFallback('Красное платье')).toBe('krasnoe-plate');
    expect(slugifyOrFallback('iPhone 15 Pro')).toBe('iphone-15-pro');
  });

  it('имя без латиницы/кириллицы/цифр (эмодзи) → непустой фолбэк-slug', () => {
    const out = slugifyOrFallback('🎉🎉🎉');
    expect(out).not.toBe('');
    expect(isValidSlug(out)).toBe(true);
    expect(out.startsWith('product-')).toBe(true);
  });

  it('иероглифы → непустой фолбэк-slug', () => {
    const out = slugifyOrFallback('日本語');
    expect(out).not.toBe('');
    expect(isValidSlug(out)).toBe(true);
  });

  it('фолбэк использует переданный hint (sku), если slugify(hint) непуст', () => {
    const out = slugifyOrFallback('🎉', 'ABC-123');
    expect(out).toBe('abc-123');
    expect(isValidSlug(out)).toBe(true);
  });

  it('пустая строка / только пробелы → непустой фолбэк-slug', () => {
    expect(isValidSlug(slugifyOrFallback(''))).toBe(true);
    expect(isValidSlug(slugifyOrFallback('   '))).toBe(true);
  });

  it('фолбэк детерминирован при заданном суффиксе (для ретрая)', () => {
    expect(slugifyOrFallback('🎉', '', 'abcd')).toBe('product-abcd');
  });
});

describe('uniquifySlug — кандидаты для ретрая', () => {
  it('attempt 0 → исходный', () => {
    expect(uniquifySlug('foo', 0)).toBe('foo');
  });
  it('attempt N → суффикс -(N+1)', () => {
    expect(uniquifySlug('foo', 1)).toBe('foo-2');
    expect(uniquifySlug('foo', 2)).toBe('foo-3');
  });
});
