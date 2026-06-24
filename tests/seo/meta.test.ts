import { describe, it, expect } from 'vitest';

import { buildSeoMeta, buildJsonLd, type SeoCtx } from '@/lib/seo/meta';

/**
 * Тесты пакета 5.S-1 (docs/11 §5.3.6) — чистый билдер buildSeoMeta.
 *
 * Билдер НЕ читает process.env/БД/storage внутри: домен/шаблон/настройки/
 * publicUrl передаются параметром seoCtx. Тестируется без БД.
 */

/** Базовый seoCtx с инъецированным publicUrl (имитирует storage.publicUrl). */
function makeCtx(over: Partial<SeoCtx> = {}): SeoCtx {
  return {
    siteUrl: 'https://shop.example',
    titleTemplate: '%s — Магазин',
    siteName: 'Магазин',
    defaultDescription: 'Лучший магазин',
    defaultOgImageKey: null,
    publicUrl: (key: string) => `https://cdn.example/${key}`,
    pathPrefix: 'product',
    ...over,
  };
}

describe('seo/meta — buildSeoMeta (title через title_template)', () => {
  it('подставляет seoTitle в title_template (%s)', () => {
    const meta = buildSeoMeta(
      { slug: 'p1', name: 'Имя товара', seoTitle: 'SEO заголовок' },
      makeCtx(),
    );
    expect(meta.title).toBe('SEO заголовок — Магазин');
  });

  it('пустой seoTitle → fallback на name (прогнан через шаблон)', () => {
    const meta = buildSeoMeta({ slug: 'p1', name: 'Имя товара', seoTitle: null }, makeCtx());
    expect(meta.title).toBe('Имя товара — Магазин');
  });

  it("голый '%s' (без суффикса) → без суффикса", () => {
    const meta = buildSeoMeta(
      { slug: 'p1', name: 'Имя', seoTitle: 'T' },
      makeCtx({ titleTemplate: '%s' }),
    );
    expect(meta.title).toBe('T');
  });

  it('подставляет во ВСЕ вхождения %s (m7), а не только в первое', () => {
    const meta = buildSeoMeta(
      { slug: 'p1', name: 'X', seoTitle: 'Кат' },
      makeCtx({ titleTemplate: '%s | %s — Магазин' }),
    );
    expect(meta.title).toBe('Кат | Кат — Магазин');
  });

  it('несколько %s с $-паттерном в base → буквально, во всех позициях (m7 + баг A волны 5)', () => {
    const meta = buildSeoMeta(
      { slug: 'p1', name: 'X', seoTitle: 'A$&B' },
      makeCtx({ titleTemplate: '%s/%s' }),
    );
    expect(meta.title).toBe('A$&B/A$&B');
  });

  // --- Защита от $-паттернов замены (баг A волны 5). ---------------------------
  // Контент-контролируемый текст (seoTitle/name) идёт АРГУМЕНТОМ-заменой в
  // String.prototype.replace. Со строковым аргументом доллар-последовательности
  // ($$, $&, $`, $') трактуются как спец-паттерны и портят публичный title.
  // Function-replacer (() => base) не подвержен раскрытию $-паттернов: текст
  // подставляется буквально.
  it("seoTitle с '$$' → в title остаётся '$$' буквально (а не '$')", () => {
    const meta = buildSeoMeta(
      { slug: 'p1', name: 'X', seoTitle: 'Цена $$ за товар' },
      makeCtx(),
    );
    expect(meta.title).toBe('Цена $$ за товар — Магазин');
  });

  it("seoTitle с '$&' → буквально '$&' (а не подстановка всего матча '%s')", () => {
    const meta = buildSeoMeta(
      { slug: 'p1', name: 'X', seoTitle: 'A $& B' },
      makeCtx(),
    );
    expect(meta.title).toBe('A $& B — Магазин');
  });

  it("seoTitle с '$`' и \"$'\" → буквально (а не префикс/суффикс матча)", () => {
    const meta = buildSeoMeta(
      { slug: 'p1', name: 'X', seoTitle: "пред $` пост $' край" },
      makeCtx(),
    );
    expect(meta.title).toBe("пред $` пост $' край — Магазин");
  });

  it("fallback name с '$&' тоже не раскрывается (контент-контролируемый name)", () => {
    const meta = buildSeoMeta(
      { slug: 'p1', name: 'Товар $& скидка', seoTitle: null },
      makeCtx(),
    );
    expect(meta.title).toBe('Товар $& скидка — Магазин');
  });

  it("'$1' (нумерованная группа) остаётся буквально", () => {
    const meta = buildSeoMeta(
      { slug: 'p1', name: 'X', seoTitle: 'Артикул $1' },
      makeCtx(),
    );
    expect(meta.title).toBe('Артикул $1 — Магазин');
  });
});

describe('seo/meta — canonical', () => {
  it('пустой canonicalUrl → автоген ${site_url}/<pathPrefix>/<slug>', () => {
    const meta = buildSeoMeta({ slug: 'sneakers', name: 'X', canonicalUrl: null }, makeCtx());
    expect(meta.canonical).toBe('https://shop.example/product/sneakers');
  });

  it('абсолютный https canonicalUrl принимается как есть', () => {
    const meta = buildSeoMeta(
      { slug: 'x', name: 'X', canonicalUrl: 'https://other.example/p/x' },
      makeCtx(),
    );
    expect(meta.canonical).toBe('https://other.example/p/x');
  });

  it('относительный путь с ведущим / достраивается до ${site_url}<path>', () => {
    const meta = buildSeoMeta(
      { slug: 'x', name: 'X', canonicalUrl: '/custom/path' },
      makeCtx(),
    );
    expect(meta.canonical).toBe('https://shop.example/custom/path');
  });

  it('без siteUrl и без canonicalUrl → canonical = null (нет хардкода домена)', () => {
    const meta = buildSeoMeta(
      { slug: 'x', name: 'X', canonicalUrl: null },
      makeCtx({ siteUrl: null }),
    );
    expect(meta.canonical).toBeNull();
  });
});

describe('seo/meta — ogImageUrl', () => {
  it('og_image_key → URL через инъецированный publicUrl', () => {
    const meta = buildSeoMeta(
      { slug: 'x', name: 'X', ogImageKey: 'products/1/img.webp' },
      makeCtx(),
    );
    expect(meta.ogImageUrl).toBe('https://cdn.example/products/1/img.webp');
  });

  it('нет og_image_key → fallback на defaultOgImageKey (через publicUrl)', () => {
    const meta = buildSeoMeta(
      { slug: 'x', name: 'X', ogImageKey: null },
      makeCtx({ defaultOgImageKey: 'defaults/og.webp' }),
    );
    expect(meta.ogImageUrl).toBe('https://cdn.example/defaults/og.webp');
  });

  it('оба пусты → ogImageUrl = null', () => {
    const meta = buildSeoMeta(
      { slug: 'x', name: 'X', ogImageKey: null },
      makeCtx({ defaultOgImageKey: null }),
    );
    expect(meta.ogImageUrl).toBeNull();
  });

  it('не хардкодит CDN-домен (URL целиком из инъецированного publicUrl)', () => {
    const meta = buildSeoMeta(
      { slug: 'x', name: 'X', ogImageKey: 'k.webp' },
      makeCtx({ publicUrl: (k) => `https://my-bucket.s3/${k}` }),
    );
    expect(meta.ogImageUrl).toBe('https://my-bucket.s3/k.webp');
  });
});

describe('seo/meta — og/description/noindex', () => {
  it('ogTitle/ogDescription берутся из полей, иначе из title/description', () => {
    const meta = buildSeoMeta(
      {
        slug: 'x',
        name: 'Имя',
        seoTitle: 'T',
        seoDescription: 'D',
        ogTitle: 'OG-T',
        ogDescription: 'OG-D',
      },
      makeCtx(),
    );
    expect(meta.ogTitle).toBe('OG-T');
    expect(meta.ogDescription).toBe('OG-D');
  });

  it('description: seoDescription, иначе defaultDescription', () => {
    const a = buildSeoMeta({ slug: 'x', name: 'X', seoDescription: 'Своё' }, makeCtx());
    expect(a.description).toBe('Своё');
    const b = buildSeoMeta({ slug: 'x', name: 'X', seoDescription: null }, makeCtx());
    expect(b.description).toBe('Лучший магазин');
  });

  it('noindex прокидывается как есть (по умолчанию false)', () => {
    expect(buildSeoMeta({ slug: 'x', name: 'X', noindex: true }, makeCtx()).noindex).toBe(true);
    expect(buildSeoMeta({ slug: 'x', name: 'X' }, makeCtx()).noindex).toBe(false);
  });
});

describe('seo/meta — buildJsonLd (опц.)', () => {
  it('Product JSON-LD содержит name и url', () => {
    const ld = buildJsonLd(
      { slug: 'x', name: 'Имя', canonicalUrl: null },
      makeCtx(),
      { type: 'Product' },
    );
    expect(ld['@type']).toBe('Product');
    expect(ld.name).toBe('Имя');
    expect(ld.url).toBe('https://shop.example/product/x');
  });
});
