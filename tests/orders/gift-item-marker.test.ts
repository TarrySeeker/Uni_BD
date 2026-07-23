import { describe, expect, it, vi } from 'vitest';

import {
  applyGiftCategoryMarker,
  resolveGiftCategoryIds,
} from '@/lib/orders/repository';
import { isGiftItemForAutoIssue } from '@/lib/gift-certificates/origin';

/**
 * ЮНИТ (без БД): МАРКЕР СЕРТИФИКАТА В СНИМКЕ ПОЗИЦИИ (§5.3 плана волны).
 *
 * Разведка волны установила: у товаров-сертификатов реального магазина атрибутов
 * нет вообще (EAV пуст, attributes_cache = {}), поэтому резолвер автовыпуска
 * (isGiftItemForAutoIssue, решает ТОЛЬКО по маркеру) не сработал бы НИ РАЗУ.
 * Маркер дописывается при СБОРКЕ снимка позиции — по принадлежности товара
 * разделам из настройки gift.categorySlugs.
 */

/** Позиция-заглушка для резолвера автовыпуска (нужны только атрибуты). */
function itemWith(attrs: Record<string, unknown>) {
  return {
    id: 'oi-1',
    nameSnapshot: 'Подарочный номинал',
    skuSnapshot: 'GC-1000',
    attributesSnapshot: attrs,
    unitPrice: '1000.00' as const,
    quantity: 1,
    lineTotal: '1000.00' as const,
  };
}

describe('applyGiftCategoryMarker — маркер сертификата в attributes_snapshot', () => {
  it('товар раздела-сертификата → снимок начинает опознаваться автовыпуском', () => {
    const before = { author: 'Ivanov' };
    // Контроль: без маркера резолвер автовыпуска позицию НЕ берёт.
    expect(isGiftItemForAutoIssue(itemWith(before), { autoIssue: true })).toBe(false);

    const after = applyGiftCategoryMarker(before, true);
    expect(isGiftItemForAutoIssue(itemWith(after), { autoIssue: true })).toBe(true);
    // Исходные атрибуты не теряются и не мутируются на месте.
    expect(after.author).toBe('Ivanov');
    expect(before).toEqual({ author: 'Ivanov' });
  });

  it('обычный товар → снимок не меняется и автовыпуск его не берёт', () => {
    const attrs = { author: 'Ivanov', image: 'a.jpg' };
    const after = applyGiftCategoryMarker(attrs, false);
    expect(after).toEqual(attrs);
    expect(isGiftItemForAutoIssue(itemWith(after), { autoIssue: true })).toBe(false);
  });

  it('явный маркер в каталоге ПЕРЕБИВАЕТ категорию (в т.ч. отрицательный)', () => {
    // Владелец мог положить товар «подарочная упаковка» в раздел сертификатов и
    // явно отключить выпуск атрибутом — категория не должна это молча отменять.
    const optedOut = applyGiftCategoryMarker({ gift_certificate: 'false' }, true);
    expect(optedOut).toEqual({ gift_certificate: 'false' });
    expect(isGiftItemForAutoIssue(itemWith(optedOut), { autoIssue: true })).toBe(false);
  });

  it('пустой снимок + раздел-сертификат → маркер появляется', () => {
    const after = applyGiftCategoryMarker({}, true);
    expect(isGiftItemForAutoIssue(itemWith(after), { autoIssue: true })).toBe(true);
  });
});

describe('resolveGiftCategoryIds — разделы-сертификаты берутся из НАСТРОЕК', () => {
  it('настройка задаёт свои разделы → по ним и ищем (мультитенантность)', async () => {
    const readCategoryIdsBySlug = vi.fn(async () => ['cat-a', 'cat-b']);
    const ids = await resolveGiftCategoryIds({
      readGiftSetting: async () => ({ categorySlugs: ['podarochnye-sertifikaty', 'vouchers'] }),
      readCategoryIdsBySlug,
    });
    expect(readCategoryIdsBySlug).toHaveBeenCalledWith([
      'podarochnye-sertifikaty',
      'vouchers',
    ]);
    expect([...ids].sort()).toEqual(['cat-a', 'cat-b']);
  });

  it('настройки нет → дефолт платформы (certificates), а не хардкод в коде заказа', async () => {
    const readCategoryIdsBySlug = vi.fn(async () => []);
    await resolveGiftCategoryIds({
      readGiftSetting: async () => null,
      readCategoryIdsBySlug,
    });
    expect(readCategoryIdsBySlug).toHaveBeenCalledWith(['certificates']);
  });

  it('владелец очистил список → БД не дёргаем, маркер не ставится никому', async () => {
    const readCategoryIdsBySlug = vi.fn(async () => ['never']);
    const ids = await resolveGiftCategoryIds({
      readGiftSetting: async () => ({ categorySlugs: [] }),
      readCategoryIdsBySlug,
    });
    expect(readCategoryIdsBySlug).not.toHaveBeenCalled();
    expect(ids.size).toBe(0);
  });
});
