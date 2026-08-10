import { describe, it, expect } from 'vitest';

import {
  buildReadinessReport,
  type ReadinessInput,
} from '@/lib/admin/readiness';

/**
 * Тесты «Готовности магазина» — чистой функции buildReadinessReport.
 *
 * ЗАЧЕМ ЭТОТ ЭКРАН СУЩЕСТВУЕТ (и почему тесты именно такие). Самый дорогой класс
 * отказов на боевых магазинах — не падение кода, а «код исправен, а магазин не
 * работает»: ключи интеграции пусты, cron-секрет пуст, товары без цены. Каждый
 * такой случай выглядел как «всё зелёное», жил неделями и вскрывался только
 * живой проверкой. Реальные примеры, которые здесь закодированы проверками:
 *   • ключи СДЭК владелец «передавал трижды» — во ВСЕХ бэкапах .env длина 0,
 *     покупателю показывались выдуманные ПВЗ из mock-фикстур;
 *   • CDEK_CRON_SECRET пуст → cron-роут отвечает 503 → трекинг статусов мёртв
 *     (случилось в трёх магазинах подряд);
 *   • цена стояла у 2 товаров из 4484 — магазин физически не мог продавать.
 *
 * Функция ЧИСТАЯ: принимает готовый снимок фактов и возвращает отчёт. Никаких
 * обращений к БД/сети внутри — иначе её нельзя было бы протестировать без стенда
 * (а именно непроверяемость и порождает такие дыры).
 */

/** Идеальный магазин: всё настроено, данные заполнены. */
function healthyInput(): ReadinessInput {
  return {
    modules: { cdek: true, payments: true, catalog: true, orders: true },
    integrations: {
      cdekMock: false,
      cdekCronSecretSet: true,
      paymentsMock: false,
      storageConfigured: true,
      mailConfigured: true,
    },
    site: { siteUrl: 'https://shop.example', shopNameSet: true, contactsSet: true },
    catalog: { activeProducts: 120, withoutPrice: 0, withoutImage: 0, testLike: 0 },
    legal: { publishedDocs: ['privacy', 'offer', 'returns'], legalEntitySet: true },
  };
}

describe('admin/readiness — общий вердикт', () => {
  it('всё настроено → ok, блокеров нет', () => {
    const r = buildReadinessReport(healthyInput());
    expect(r.status).toBe('ok');
    expect(r.blockers).toHaveLength(0);
  });

  it('вердикт = худший из пунктов: один блокер делает весь отчёт blocked', () => {
    const input = healthyInput();
    input.integrations.cdekMock = true;
    const r = buildReadinessReport(input);
    expect(r.status).toBe('blocked');
  });

  it('только предупреждения (без блокеров) → attention, а не blocked', () => {
    const input = healthyInput();
    input.catalog.withoutImage = 5;
    const r = buildReadinessReport(input);
    expect(r.status).toBe('attention');
    expect(r.blockers).toHaveLength(0);
  });
});

describe('admin/readiness — интеграции', () => {
  it('модуль СДЭК включён, но ключи пусты → БЛОКЕР (покупателю показывались бы выдуманные ПВЗ)', () => {
    const input = healthyInput();
    input.integrations.cdekMock = true;
    const r = buildReadinessReport(input);
    const item = r.items.find((i) => i.id === 'cdek.keys');
    expect(item?.level).toBe('blocker');
    // Формулировка обязана называть последствие для ПОКУПАТЕЛЯ, а не «mock-режим»:
    // владелец не обязан знать это слово, а именно оно скрывало проблему.
    expect(item?.detail).toMatch(/вымышленн|ненастоящ|тестов/i);
  });

  it('модуль СДЭК ВЫКЛЮЧЕН → пустые ключи не проблема (пункт пропущен)', () => {
    const input = healthyInput();
    input.modules.cdek = false;
    input.integrations.cdekMock = true;
    const r = buildReadinessReport(input);
    expect(r.items.find((i) => i.id === 'cdek.keys')?.level).toBe('skipped');
    expect(r.status).toBe('ok');
  });

  it('cron-секрет пуст при включённом СДЭК → БЛОКЕР (статусы доставки не обновляются)', () => {
    const input = healthyInput();
    input.integrations.cdekCronSecretSet = false;
    const r = buildReadinessReport(input);
    const item = r.items.find((i) => i.id === 'cron.secret');
    expect(item?.level).toBe('blocker');
  });

  it('модуль оплаты включён, ключи пусты → БЛОКЕР (заказы не оплатить)', () => {
    const input = healthyInput();
    input.integrations.paymentsMock = true;
    const r = buildReadinessReport(input);
    expect(r.items.find((i) => i.id === 'payments.keys')?.level).toBe('blocker');
  });

  it('модуль оплаты выключен → пункт пропущен (магазин-заявка — легальный сценарий)', () => {
    const input = healthyInput();
    input.modules.payments = false;
    input.integrations.paymentsMock = true;
    const r = buildReadinessReport(input);
    expect(r.items.find((i) => i.id === 'payments.keys')?.level).toBe('skipped');
  });
});

/**
 * Почта. Её отсутствие — предупреждение, а не блокер: магазин без писем
 * работает, просто уведомления о заказах приходится рассылать вручную.
 *
 * (В сборке с личным кабинетом этот же пункт становится блокером — там без
 * почты нельзя ни подтвердить адрес, ни восстановить пароль.)
 */
describe('admin/readiness — отправка писем', () => {
  it('почта не настроена → предупреждение, вердикт не blocked', () => {
    const input = healthyInput();
    input.integrations.mailConfigured = false;
    const r = buildReadinessReport(input);

    expect(r.items.find((i) => i.id === 'mail')?.level).toBe('warning');
    expect(r.status).not.toBe('blocked');
  });

  it('текст называет последствие, а не «SMTP не задан»', () => {
    const input = healthyInput();
    input.integrations.mailConfigured = false;
    const item = buildReadinessReport(input).items.find((i) => i.id === 'mail');

    expect(item?.detail).toMatch(/письма не отправляются|вручную/i);
    expect(item?.action.length).toBeGreaterThan(0);
  });

  it('почта настроена → пункт в порядке', () => {
    expect(buildReadinessReport(healthyInput()).items.find((i) => i.id === 'mail')?.level).toBe('ok');
  });
});

describe('admin/readiness — витрина и данные', () => {
  it('site_url не задан → БЛОКЕР (без него ломаются ссылки в письмах и вебхуках)', () => {
    const input = healthyInput();
    input.site.siteUrl = null;
    const r = buildReadinessReport(input);
    expect(r.items.find((i) => i.id === 'site.url')?.level).toBe('blocker');
  });

  it('каталог пуст → БЛОКЕР (покупателю нечего купить)', () => {
    const input = healthyInput();
    input.catalog.activeProducts = 0;
    const r = buildReadinessReport(input);
    expect(r.items.find((i) => i.id === 'catalog.products')?.level).toBe('blocker');
  });

  it('часть товаров без цены → БЛОКЕР с ЧИСЛОМ (2 из 4484 — реальный случай)', () => {
    const input = healthyInput();
    input.catalog.activeProducts = 4484;
    input.catalog.withoutPrice = 4482;
    const r = buildReadinessReport(input);
    const item = r.items.find((i) => i.id === 'catalog.price');
    expect(item?.level).toBe('blocker');
    // Число обязано попасть в текст: «есть проблема» без масштаба не заставляет
    // действовать, «4482 товара нельзя купить» — заставляет.
    expect(item?.detail).toContain('4482');
  });

  it('товары без фото → предупреждение, НЕ блокер (продавать можно)', () => {
    const input = healthyInput();
    input.catalog.withoutImage = 7;
    const r = buildReadinessReport(input);
    expect(r.items.find((i) => i.id === 'catalog.images')?.level).toBe('warning');
  });

  it('тестовые товары в каталоге → предупреждение (их видит покупатель)', () => {
    const input = healthyInput();
    input.catalog.testLike = 3;
    const r = buildReadinessReport(input);
    const item = r.items.find((i) => i.id === 'catalog.testdata');
    expect(item?.level).toBe('warning');
    expect(item?.detail).toContain('3');
  });

  it('контакты не заполнены → предупреждение (покупателю некуда обратиться)', () => {
    const input = healthyInput();
    input.site.contactsSet = false;
    const r = buildReadinessReport(input);
    expect(r.items.find((i) => i.id === 'site.contacts')?.level).toBe('warning');
  });
});

/**
 * Правовые документы. Урок Rubber 2026-08-10: магазин работал на бою без
 * публичной оферты вовсе, а страница возврата содержала незаконное «возврату не
 * подлежит». Такое не ловится тестами кода — только проверкой фактов, поэтому
 * проверка живёт здесь, а не только в docs/32.
 */
describe('admin/readiness — правовые документы', () => {
  it('все документы опубликованы и реквизиты заданы → ok', () => {
    const r = buildReadinessReport(healthyInput());
    expect(r.items.find((i) => i.id === 'legal.docs')?.level).toBe('ok');
    expect(r.items.find((i) => i.id === 'legal.entity')?.level).toBe('ok');
  });

  it('нет политики обработки ПДн → блокер (сбор ПДн без документа незаконен)', () => {
    const input = healthyInput();
    input.legal.publishedDocs = ['offer', 'returns'];
    const r = buildReadinessReport(input);
    const item = r.items.find((i) => i.id === 'legal.docs');
    expect(item?.level).toBe('blocker');
    expect(item?.detail).toMatch(/политик/i);
    expect(r.status).not.toBe('ok');
  });

  it('нет оферты и возврата → блокер с перечислением недостающего', () => {
    const input = healthyInput();
    input.legal.publishedDocs = ['privacy'];
    const r = buildReadinessReport(input);
    const item = r.items.find((i) => i.id === 'legal.docs');
    expect(item?.level).toBe('blocker');
    expect(item?.detail).toMatch(/оферт/i);
    expect(item?.detail).toMatch(/возврат/i);
  });

  it('реквизиты продавца не заданы → блокер (ст.9 ЗоЗПП)', () => {
    const input = healthyInput();
    input.legal.legalEntitySet = false;
    const r = buildReadinessReport(input);
    expect(r.items.find((i) => i.id === 'legal.entity')?.level).toBe('blocker');
  });

  it('список документов неизвестен (запрос не удался) → unknown, не «ok»', () => {
    const input = healthyInput();
    input.legal.publishedDocs = null;
    const r = buildReadinessReport(input);
    expect(r.items.find((i) => i.id === 'legal.docs')?.level).toBe('unknown');
    expect(r.status).not.toBe('ok');
  });
});

describe('admin/readiness — устойчивость', () => {
  it('неизвестные счётчики (null — запрос не удался) НЕ выдаются за успех', () => {
    const input = healthyInput();
    input.catalog.activeProducts = null;
    const r = buildReadinessReport(input);
    const item = r.items.find((i) => i.id === 'catalog.products');
    // Ключевое: «не смогли посчитать» ≠ «всё хорошо». Молчаливое проглатывание
    // ошибки БД уже однажды скрыло реальный дефект на дашборде.
    expect(item?.level).toBe('unknown');
    expect(r.status).not.toBe('ok');
  });

  it('каждый пункт отчёта несёт подсказку, ЧТО сделать', () => {
    const input = healthyInput();
    input.integrations.cdekMock = true;
    input.catalog.withoutPrice = 3;
    const r = buildReadinessReport(input);
    for (const item of r.items) {
      if (item.level === 'blocker' || item.level === 'warning') {
        expect(item.action.length).toBeGreaterThan(0);
      }
    }
  });

  it('блокеры собраны в отдельный список — их нельзя пролистать мимо', () => {
    const input = healthyInput();
    input.integrations.cdekMock = true;
    input.site.siteUrl = null;
    const r = buildReadinessReport(input);
    expect(r.blockers.map((b) => b.id).sort()).toEqual(['cdek.keys', 'site.url']);
  });
});
