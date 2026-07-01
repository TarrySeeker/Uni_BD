import { describe, expect, it } from 'vitest';

import { slugify, isValidSlug } from '@/lib/cms/slug';

/**
 * БАГ (logic-bug, находка 7 аудита wptqu03l9): создание CMS-страницы с русским
 * заголовком падало. Клиентский previewSlug() в PageForm оставлял кириллицу
 * (regex /[^a-z0-9а-яё\s-]/gi НЕ вырезал а-яё), поэтому в поле slug подставлялся
 * кириллический ЧПУ («о-компании»), и форма отправляла этот непустой кириллический
 * slug на сервер. Серверная slugSchema (/^[a-z0-9]+(?:-[a-z0-9]+)*$/) отклоняла
 * его Zod-ом ДО handler — владелец получал ошибку у поля «ЧПУ», которое не трогал.
 *
 * ФИКС: клиентское превью slug ПЕРЕИСПОЛЬЗУЕТ серверный slugify (lib/cms/slug →
 * lib/catalog/slug), транслитерирующий кириллицу → латиницу. Превью теперь
 * тождественно тому, что примет сервер: владелец вводит русский заголовок →
 * видит корректный латинский slug → создание проходит.
 *
 * Этот тест фиксирует контракт превью на уровне чистой логики (slugify), которую
 * теперь зовёт PageForm. Каждый результат обязан проходить isValidSlug (то, что
 * принимает серверная схема), и быть латиницей — никакой кириллицы в превью.
 */

const NO_CYRILLIC = /[а-яёА-ЯЁ]/;

describe('cms/page-form — превью slug совпадает с серверным slugify', () => {
  it('русский заголовок → латинский slug (рус→лат транслитерация)', () => {
    expect(slugify('О компании')).toBe('o-kompanii');
    expect(slugify('Доставка и оплата')).toBe('dostavka-i-oplata');
    expect(slugify('Возврат товара')).toBe('vozvrat-tovara');
  });

  it('превью НИКОГДА не содержит кириллицу (сервер отверг бы её)', () => {
    for (const title of ['О компании', 'Часто задаваемые вопросы', 'Уход за изделием']) {
      const preview = slugify(title);
      expect(NO_CYRILLIC.test(preview)).toBe(false);
    }
  });

  it('непустое латинское превью проходит серверный isValidSlug', () => {
    for (const title of ['О компании', 'Доставка и оплата', 'Hello World', 'iPhone 15 Pro']) {
      const preview = slugify(title);
      expect(preview.length).toBeGreaterThan(0);
      expect(isValidSlug(preview)).toBe(true);
    }
  });

  it('смешанный рус/лат заголовок даёт валидный латинский slug', () => {
    expect(slugify('Бренд Apple — новинки')).toBe('brend-apple-novinki');
  });

  it('пустой/нелатинский результат остаётся пустым (сервер применит фолбэк)', () => {
    // slugify('🎉')/slugify('') === '' — превью пустое; форма отправит slug:undefined,
    // и сервер сгенерирует ЧПУ через slugifyOrFallback('…','','','page').
    expect(slugify('🎉')).toBe('');
    expect(slugify('   ')).toBe('');
  });
});
