import { describe, it, expect } from 'vitest';

import {
  GIFT_ITEM_MARKER_KEYS,
  buildGiftCodeForOrderItem,
  certificateItemHint,
  giftFaceValueFromItem,
  looksLikeCertificateItem,
  normalizeGiftParty,
  isGiftPartyEmpty,
  type CertificateSourceItem,
} from '@/lib/gift-certificates/origin';

/**
 * ЮНИТ — чистое ядро «выпуск сертификата по заказу» (ТЗ п.7): номинал из СНИМКА
 * позиции, распознавание позиции-сертификата по снимку (не по текущему каталогу),
 * нормализация снимков покупателя/получателя, детерминированный код.
 */

function item(over: Partial<CertificateSourceItem> = {}): CertificateSourceItem {
  return {
    id: '9f1e0a2b-1111-4111-8111-111111111111',
    nameSnapshot: 'Платок шёлковый',
    skuSnapshot: 'SC-1',
    attributesSnapshot: {},
    unitPrice: '1500.00',
    quantity: 1,
    lineTotal: '1500.00',
    ...over,
  };
}

describe('giftFaceValueFromItem — номинал из ценового снимка позиции', () => {
  it('берёт фактически уплаченную сумму позиции (lineTotal), а не текущую цену товара', () => {
    expect(giftFaceValueFromItem(item({ unitPrice: '5000.00', quantity: 1, lineTotal: '5000.00' }))).toBe(
      '5000.00',
    );
  });

  it('quantity > 1 → номинал = вся уплаченная сумма позиции', () => {
    expect(giftFaceValueFromItem(item({ unitPrice: '2000.00', quantity: 3, lineTotal: '6000.00' }))).toBe(
      '6000.00',
    );
  });

  it('битый lineTotal → пересчёт unitPrice × quantity (снимок остаётся источником)', () => {
    expect(giftFaceValueFromItem(item({ unitPrice: '2000.50', quantity: 2, lineTotal: '' }))).toBe(
      '4001.00',
    );
  });

  it('нулевая позиция (подарок по промокоду) → номинал 0.00 (выпуск запрещает action)', () => {
    expect(giftFaceValueFromItem(item({ unitPrice: '0.00', quantity: 1, lineTotal: '0.00' }))).toBe('0.00');
  });
});

describe('looksLikeCertificateItem — распознавание по СНИМКУ позиции', () => {
  it('маркер в attributes_snapshot → позиция-сертификат (любой магазин платформы)', () => {
    for (const key of GIFT_ITEM_MARKER_KEYS) {
      expect(looksLikeCertificateItem(item({ attributesSnapshot: { [key]: true } }))).toBe(true);
    }
  });

  it('маркер как строка "true"/"1"/"да" тоже считается', () => {
    for (const v of ['true', '1', 'да', 'yes']) {
      expect(looksLikeCertificateItem(item({ attributesSnapshot: { gift_certificate: v } }))).toBe(true);
    }
  });

  it('маркер со значением false/пусто → не сертификат', () => {
    expect(looksLikeCertificateItem(item({ attributesSnapshot: { gift_certificate: false } }))).toBe(false);
    expect(looksLikeCertificateItem(item({ attributesSnapshot: { gift_certificate: '' } }))).toBe(false);
  });

  it('без маркера, но имя-снимок говорит «сертификат» → подсказка по имени', () => {
    expect(certificateItemHint(item({ nameSnapshot: 'Подарочный сертификат 5000 ₽' }))).toBe('name');
    expect(certificateItemHint(item({ nameSnapshot: 'Gift certificate 5000' }))).toBe('name');
    expect(looksLikeCertificateItem(item({ nameSnapshot: 'Подарочный сертификат' }))).toBe(true);
  });

  it('маркер сильнее имени (hint=marked) и обычный товар → none', () => {
    expect(certificateItemHint(item({ attributesSnapshot: { gift_certificate: true } }))).toBe('marked');
    expect(certificateItemHint(item())).toBe('none');
    expect(looksLikeCertificateItem(item())).toBe(false);
  });
});

describe('normalizeGiftParty — снимок стороны сделки', () => {
  it('обрезает пробелы, пустое → null', () => {
    expect(normalizeGiftParty({ name: '  Аня  ', email: ' A@Shop.IO ', phone: '' })).toEqual({
      name: 'Аня',
      email: 'A@Shop.IO',
      phone: null,
    });
  });

  it('undefined/пустой вход → пустой снимок', () => {
    expect(normalizeGiftParty(undefined)).toEqual({ name: null, email: null, phone: null });
    expect(isGiftPartyEmpty(normalizeGiftParty(undefined))).toBe(true);
    expect(isGiftPartyEmpty(normalizeGiftParty({ name: 'Аня' }))).toBe(false);
  });
});

describe('buildGiftCodeForOrderItem — детерминированный код по позиции', () => {
  it('код детерминирован (повтор даёт то же значение) и содержит номер заказа', () => {
    const a = buildGiftCodeForOrderItem({ orderNumber: 'CR-2026-000123', orderItemId: 'abc12345-1111-4111-8111-111111111111' });
    const b = buildGiftCodeForOrderItem({ orderNumber: 'CR-2026-000123', orderItemId: 'abc12345-1111-4111-8111-111111111111' });
    expect(a).toBe(b);
    expect(a).toContain('CR-2026-000123');
    expect(a.length).toBeLessThanOrEqual(64);
  });

  it('разные позиции одного заказа → разные коды', () => {
    const a = buildGiftCodeForOrderItem({ orderNumber: 'CR-2026-000123', orderItemId: 'aaaaaaaa-1111-4111-8111-111111111111' });
    const b = buildGiftCodeForOrderItem({ orderNumber: 'CR-2026-000123', orderItemId: 'bbbbbbbb-1111-4111-8111-111111111111' });
    expect(a).not.toBe(b);
  });

  it('код в верхнем регистре и без пробелов', () => {
    const code = buildGiftCodeForOrderItem({ orderNumber: 'ord 2026 7', orderItemId: 'cccccccc-1111-4111-8111-111111111111' });
    expect(code).toBe(code.toUpperCase());
    expect(code).not.toMatch(/\s/);
  });
});
