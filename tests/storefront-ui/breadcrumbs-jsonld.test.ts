import { describe, expect, it } from 'vitest';

import { buildBreadcrumbJsonLd } from '../../storefront/lib/breadcrumbs';

/**
 * Микроразметка хлебных крошек (schema.org BreadcrumbList, JSON-LD).
 *
 * SEO-выигрыш: Google рисует «Главная › О нас» вместо голого URL в выдаче. Условие
 * — позиции ссылаются на АБСОЛЮТНЫЕ URL. База берётся из настроек магазина
 * (seo.siteUrl, тот же absoluteUrlBase, что и у hreflang) — без неё разметку НЕ
 * выпускаем вовсе: относительные @id ломают валидацию и вредят сильнее, чем
 * отсутствие разметки. Никакого хардкода домена (мультитенантность).
 *
 * 🔴 canonical/hreflang эта разметка не трогает — она отдельный <script>, а не
 * поле Metadata (их только что чинили в этой сессии).
 */

describe('buildBreadcrumbJsonLd', () => {
  const base = 'https://shop.example';

  it('строит BreadcrumbList: «Главная» первым, текущая страница последней', () => {
    const ld = buildBreadcrumbJsonLd(
      [{ label: 'О нас' }],
      { locale: 'ru', homeLabel: 'Главная', base },
    );

    expect(ld).toEqual({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        {
          '@type': 'ListItem',
          position: 1,
          name: 'Главная',
          item: 'https://shop.example/',
        },
        { '@type': 'ListItem', position: 2, name: 'О нас' },
      ],
    });
  });

  it('промежуточная крошка со ссылкой получает абсолютный item, последняя — нет', () => {
    const ld = buildBreadcrumbJsonLd(
      [{ label: 'Каталог', href: '/catalog' }, { label: 'Твилли' }],
      { locale: 'ru', homeLabel: 'Главная', base },
    );

    const items = ld!.itemListElement;
    expect(items).toHaveLength(3);
    expect(items[1]).toEqual({
      '@type': 'ListItem',
      position: 2,
      name: 'Каталог',
      item: 'https://shop.example/catalog',
    });
    // Последняя — текущая страница: по рекомендации Google без `item`.
    expect(items[2]).toEqual({ '@type': 'ListItem', position: 3, name: 'Твилли' });
  });

  it('локаль попадает в URL позиций (en → /en/...), как и у hreflang', () => {
    const ld = buildBreadcrumbJsonLd(
      [{ label: 'Delivery', href: '/delivery' }, { label: 'Zones' }],
      { locale: 'en', homeLabel: 'Home', base },
    );

    expect(ld!.itemListElement[0]!.item).toBe('https://shop.example/en');
    expect(ld!.itemListElement[1]!.item).toBe('https://shop.example/en/delivery');
  });

  it('база не задана в настройках → null (лучше без разметки, чем с относительной)', () => {
    expect(
      buildBreadcrumbJsonLd([{ label: 'О нас' }], {
        locale: 'ru',
        homeLabel: 'Главная',
        base: null,
      }),
    ).toBeNull();
  });

  it('пустой список крошек → null (на главной разметка не нужна)', () => {
    expect(
      buildBreadcrumbJsonLd([], { locale: 'ru', homeLabel: 'Главная', base }),
    ).toBeNull();
  });

  it('сериализуется в валидный JSON без «</script>»-инъекции из данных магазина', () => {
    const ld = buildBreadcrumbJsonLd(
      [{ label: '</script><img src=x onerror=alert(1)>' }],
      { locale: 'ru', homeLabel: 'Главная', base },
    );
    const json = JSON.stringify(ld);
    // Проверяем, что данные попали как есть — экранирование делает рендер
    // (JSON.stringify + замена '<' → '<' в компоненте).
    expect(json).toContain('script');
    expect(() => JSON.parse(json)).not.toThrow();
  });
});
