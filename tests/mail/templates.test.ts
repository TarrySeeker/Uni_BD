import { describe, it, expect } from 'vitest';

import { escapeHtml, renderMailTemplate, MAIL_TEMPLATE_IDS } from '@/lib/mail/templates';
import type { MailTemplateId } from '@/lib/mail/types';

/**
 * Шаблоны писем: рендер в HTML + текстовую версию на языке ПОКУПАТЕЛЯ (ru/en/fr).
 *
 * 🔴 ГЛАВНОЕ, ЧТО СТОРОЖИТ ЭТОТ ФАЙЛ — ЭКРАНИРОВАНИЕ. Имя, адрес и названия
 * товаров приходят от покупателя; почтовый клиент рендерит HTML, поэтому
 * невыведенный `<script>`/`onerror=` — это XSS в чужом почтовом ящике.
 */

const CUSTOMER = { name: 'Иван Иванов', email: 'ivan@example.test' };

describe('mail/templates — escapeHtml', () => {
  it('экранирует все пять опасных символов', () => {
    expect(escapeHtml('<a href="x">&\'</a>')).toBe(
      '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;',
    );
  });

  it('амперсанд экранируется ПЕРВЫМ (иначе двойное экранирование ломает текст)', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('null/undefined/число → безопасная строка, а не «undefined» в письме', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(42)).toBe('42');
  });
});

describe('mail/templates — подарочный сертификат (главный шаблон)', () => {
  const base = {
    shopName: 'Магазин',
    customer: CUSTOMER,
    certificates: [{ code: 'ABCD-1234', amount: '5000.00', currency: 'RUB', validUntil: null }],
    orderNumber: '2026-000123',
    orderUrl: 'https://shop.test/cart/success?number=2026-000123&token=t',
  };

  it('код сертификата присутствует в HTML и в тексте (иначе письмо бесполезно)', () => {
    const out = renderMailTemplate('gift_certificate', 'ru', base);
    expect(out.html).toContain('ABCD-1234');
    expect(out.text).toContain('ABCD-1234');
  });

  it('несколько сертификатов в одном письме — все коды на месте', () => {
    const out = renderMailTemplate('gift_certificate', 'ru', {
      ...base,
      certificates: [
        { code: 'AAAA-1111', amount: '1000.00', currency: 'RUB', validUntil: null },
        { code: 'BBBB-2222', amount: '2000.00', currency: 'RUB', validUntil: null },
      ],
    });
    expect(out.html).toContain('AAAA-1111');
    expect(out.html).toContain('BBBB-2222');
    expect(out.text).toContain('AAAA-1111');
    expect(out.text).toContain('BBBB-2222');
  });

  it('имя покупателя с разметкой ЭКРАНИРУЕТСЯ (XSS в почтовом клиенте)', () => {
    const out = renderMailTemplate('gift_certificate', 'ru', {
      ...base,
      customer: { name: '<img src=x onerror=alert(1)>', email: 'x@example.test' },
    });
    expect(out.html).not.toContain('<img src=x');
    expect(out.html).toContain('&lt;img src=x');
  });

  it('код сертификата тоже экранируется (код приходит из БД, но правило одно)', () => {
    const out = renderMailTemplate('gift_certificate', 'ru', {
      ...base,
      certificates: [
        { code: '<b>X</b>', amount: '1.00', currency: 'RUB', validUntil: null },
      ],
    });
    expect(out.html).not.toContain('<b>X</b>');
    expect(out.html).toContain('&lt;b&gt;X&lt;/b&gt;');
  });

  it('название магазина из настроек тоже экранируется (мультитенантность)', () => {
    const out = renderMailTemplate('gift_certificate', 'ru', {
      ...base,
      shopName: 'Shop "A" & <b>B</b>',
    });
    expect(out.html).not.toContain('<b>B</b>');
    expect(out.html).toContain('&amp;');
  });

  it('срок действия печатается, если задан, и не печатается, если бессрочно', () => {
    const withDate = renderMailTemplate('gift_certificate', 'ru', {
      ...base,
      certificates: [
        { code: 'C-1', amount: '100.00', currency: 'RUB', validUntil: '31.12.2026' },
      ],
    });
    expect(withDate.text).toContain('31.12.2026');
  });

  it('тема письма непустая на всех трёх языках и различается по языкам', () => {
    const ru = renderMailTemplate('gift_certificate', 'ru', base).subject;
    const en = renderMailTemplate('gift_certificate', 'en', base).subject;
    const fr = renderMailTemplate('gift_certificate', 'fr', base).subject;
    for (const s of [ru, en, fr]) expect(s.length).toBeGreaterThan(0);
    expect(new Set([ru, en, fr]).size).toBe(3);
  });

  it('неизвестный язык → откат на язык магазина, а не пустое письмо', () => {
    const out = renderMailTemplate('gift_certificate', 'kl', base);
    expect(out.subject.length).toBeGreaterThan(0);
    expect(out.html).toContain('ABCD-1234');
  });
});

describe('mail/templates — подтверждение заказа', () => {
  const base = {
    shopName: 'Магазин',
    customer: CUSTOMER,
    orderNumber: '2026-000123',
    orderUrl: 'https://shop.test/cart/success?number=2026-000123&token=t',
    total: '12 500,00 ₽',
    items: [
      { name: 'Платок «Осень»', qty: 2, sum: '10 000,00 ₽' },
      { name: 'Шарф', qty: 1, sum: '2 500,00 ₽' },
    ],
  };

  it('номер заказа, состав и сумма попадают в письмо', () => {
    const out = renderMailTemplate('order_confirmation', 'ru', base);
    expect(out.html).toContain('2026-000123');
    expect(out.html).toContain('Шарф');
    expect(out.text).toContain('2026-000123');
    expect(out.text).toContain('12 500,00 ₽');
  });

  it('ссылка на заказ — кликабельная и указывает на переданный адрес', () => {
    const out = renderMailTemplate('order_confirmation', 'ru', base);
    expect(out.html).toContain('href="https://shop.test/cart/success?number=2026-000123&amp;token=t"');
    expect(out.text).toContain('https://shop.test/cart/success?number=2026-000123&token=t');
  });

  it('название товара с разметкой экранируется', () => {
    const out = renderMailTemplate('order_confirmation', 'ru', {
      ...base,
      items: [{ name: '<script>alert(1)</script>', qty: 1, sum: '1,00 ₽' }],
    });
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;');
  });

  it('javascript:-ссылка в orderUrl не попадает в href (открытый редирект/XSS)', () => {
    const out = renderMailTemplate('order_confirmation', 'ru', {
      ...base,
      orderUrl: 'javascript:alert(1)',
    });
    expect(out.html).not.toContain('javascript:');
  });

  it('без ссылки на заказ письмо всё равно валидно (шлюз не дал origin)', () => {
    const out = renderMailTemplate('order_confirmation', 'ru', { ...base, orderUrl: null });
    expect(out.html).toContain('2026-000123');
    expect(out.html).not.toContain('href="null"');
  });
});

describe('mail/templates — смена статуса доставки', () => {
  const base = {
    shopName: 'Магазин',
    customer: CUSTOMER,
    orderNumber: '2026-000123',
    orderUrl: null,
    trackNumber: 'CDEK-777',
  };

  /**
   * Идентификаторы шаблонов доставки — ровно те, что уже перечислены в
   * STATUS_TO_CLIENT_TEMPLATE (lib/cdek/services/status-map.ts). Карта написана
   * давно и до этой волны не вызывалась НИКЕМ; смысл модуля — научиться её
   * исполнять, а не заводить рядом второй словарь.
   */
  const DELIVERY_TEMPLATES = [
    'cdek_accepted',
    'cdek_in_transit',
    'cdek_ready_for_pickup',
    'cdek_courier_dispatched',
    'cdek_delivered',
  ] as const;

  it.each(DELIVERY_TEMPLATES)('%s рендерится на ru/en/fr с номером заказа', (id) => {
    for (const locale of ['ru', 'en', 'fr']) {
      const out = renderMailTemplate(id as MailTemplateId, locale, base);
      expect(out.subject.length).toBeGreaterThan(0);
      expect(out.html).toContain('2026-000123');
      expect(out.text).toContain('2026-000123');
    }
  });

  it('трек-номер печатается, когда он есть', () => {
    const out = renderMailTemplate('cdek_in_transit', 'ru', base);
    expect(out.text).toContain('CDEK-777');
  });

  it('без трек-номера письмо не печатает «null»', () => {
    const out = renderMailTemplate('cdek_in_transit', 'ru', { ...base, trackNumber: null });
    expect(out.text).not.toContain('null');
    expect(out.html).not.toContain('null');
  });
});

describe('mail/templates — общие инварианты', () => {
  const ctx = {
    shopName: 'Магазин',
    customer: CUSTOMER,
    orderNumber: '2026-000123',
    orderUrl: null,
    certificates: [{ code: 'X-1', amount: '1.00', currency: 'RUB', validUntil: null }],
    items: [{ name: 'Товар', qty: 1, sum: '1,00 ₽' }],
    total: '1,00 ₽',
    trackNumber: null,
  };

  it('каждый объявленный шаблон рендерится на каждом языке (нет дыр в каталоге)', () => {
    for (const id of MAIL_TEMPLATE_IDS) {
      for (const locale of ['ru', 'en', 'fr']) {
        const out = renderMailTemplate(id, locale, ctx);
        expect(out.subject.trim().length, `${id}/${locale}: пустая тема`).toBeGreaterThan(0);
        expect(out.html.trim().length, `${id}/${locale}: пустой HTML`).toBeGreaterThan(0);
        expect(out.text.trim().length, `${id}/${locale}: пустой текст`).toBeGreaterThan(0);
      }
    }
  });

  it('текстовая версия не содержит HTML-тегов (это plain-text альтернатива)', () => {
    for (const id of MAIL_TEMPLATE_IDS) {
      const out = renderMailTemplate(id, 'ru', ctx);
      expect(out.text, `${id}: в text/plain попал тег`).not.toMatch(/<[a-z/][^>]*>/i);
    }
  });

  it('HTML-письмо самодостаточно: без внешних скриптов и картинок', () => {
    for (const id of MAIL_TEMPLATE_IDS) {
      const out = renderMailTemplate(id, 'ru', ctx);
      expect(out.html).not.toMatch(/<script/i);
      expect(out.html).not.toMatch(/<img\s/i);
    }
  });

  it('тема письма однострочная (перевод строки в Subject = инъекция заголовков)', () => {
    for (const id of MAIL_TEMPLATE_IDS) {
      for (const locale of ['ru', 'en', 'fr']) {
        const out = renderMailTemplate(id, locale, {
          ...ctx,
          orderNumber: '2026-1\r\nBcc: attacker@evil.test',
        });
        expect(out.subject, `${id}/${locale}: CRLF в теме`).not.toMatch(/[\r\n]/);
      }
    }
  });
});
