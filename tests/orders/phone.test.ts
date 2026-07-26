import { describe, it, expect } from 'vitest';

import {
  MIN_PHONE_DIGITS,
  phoneDigits,
  looksLikePhone,
  normalizeRussianPhone,
  isRussianPhone,
} from '@/lib/orders/phone';
import { normalizePhone } from '@/lib/cdek/services/order';

/**
 * Чистые хелперы телефона (аудит-находка #8, группа C1).
 *
 * Единственный источник истины «пройдёт ли номер нормализацию для накладной
 * СДЭК» — normalizeRussianPhone. cdek/services/order.normalizePhone обязана
 * делегировать сюда (иначе админка показывала бы предупреждение по одним
 * правилам, а накладная падала бы по другим).
 *
 * ВАЖНО: магазин трёхъязычный, СДЭК возит по РФ. Поэтому «не российский номер» —
 * НЕ повод отклонить заказ (самовывоз/зона/иной перевозчик остаются валидны),
 * а повод предупредить менеджера. Отсюда две РАЗНЫЕ функции: looksLikePhone
 * (мягкий вход, любые страны) и isRussianPhone (жёсткий гейт СДЭК).
 */

describe('orders/phone — phoneDigits', () => {
  it('оставляет только цифры', () => {
    expect(phoneDigits('+7 (912) 345-67-89')).toBe('79123456789');
    expect(phoneDigits('tel: 8-800-555-35-35')).toBe('88005553535');
  });

  it('пустой/мусорный ввод → пустая строка', () => {
    expect(phoneDigits('')).toBe('');
    expect(phoneDigits('---')).toBe('');
  });
});

describe('orders/phone — looksLikePhone (мягкая проверка входа)', () => {
  it('принимает иностранные номера (магазин трёхъязычный)', () => {
    expect(looksLikePhone('+33 6 12 34 56 78')).toBe(true);
    expect(looksLikePhone('+1 415 555 0123')).toBe(true);
  });

  it('принимает короткий городской номер (7 цифр) — заказ отклонять нельзя', () => {
    expect(looksLikePhone('2223344')).toBe(true);
  });

  it('отклоняет строку без достаточного числа цифр', () => {
    expect(looksLikePhone('-')).toBe(false);
    expect(looksLikePhone('нет')).toBe(false);
    expect(looksLikePhone('1234')).toBe(false);
    expect(MIN_PHONE_DIGITS).toBe(5);
  });
});

describe('orders/phone — normalizeRussianPhone (жёсткий гейт СДЭК)', () => {
  it('10 цифр → +7XXXXXXXXXX', () => {
    expect(normalizeRussianPhone('9123456789')).toBe('+79123456789');
  });

  it('11 цифр с 8 или 7 → +7XXXXXXXXXX', () => {
    expect(normalizeRussianPhone('89123456789')).toBe('+79123456789');
    expect(normalizeRussianPhone('79123456789')).toBe('+79123456789');
  });

  it('разделители игнорируются', () => {
    expect(normalizeRussianPhone('+7 (912) 345-67-89')).toBe('+79123456789');
  });

  it('городской/иностранный → null (не бросает)', () => {
    expect(normalizeRussianPhone('2223344')).toBeNull();
    expect(normalizeRussianPhone('+33612345678')).toBeNull();
    expect(normalizeRussianPhone('')).toBeNull();
  });

  it('isRussianPhone — булев фасад над той же логикой', () => {
    expect(isRussianPhone('89123456789')).toBe(true);
    expect(isRussianPhone('2223344')).toBe(false);
  });
});

describe('cdek/order — normalizePhone делегирует в общий хелпер', () => {
  const OK = ['9123456789', '89123456789', '79123456789', '+7 (912) 345-67-89'];
  const BAD = ['2223344', '+33612345678', '12345', ''];

  it('успешные случаи совпадают посимвольно', () => {
    for (const raw of OK) {
      expect(normalizePhone(raw)).toBe(normalizeRussianPhone(raw));
    }
  });

  it('бросает ровно там, где хелпер отдаёт null', () => {
    for (const raw of BAD) {
      expect(isRussianPhone(raw)).toBe(false);
      expect(() => normalizePhone(raw)).toThrow();
    }
  });
});
