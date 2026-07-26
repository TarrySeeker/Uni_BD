import { describe, it, expect } from 'vitest';

import { buildGiftCodeForOrderItem, randomGiftCode } from '@/lib/gift-certificates/origin';

import { normalizeGiftCode } from '../../storefront/lib/gift-code';

/**
 * Нормализация кода сертификата, введённого покупателем на чекауте.
 *
 * ФАКТ (не догадка), из которого выведены правила:
 *   • `gift_certificates.code` — citext (миграция 0039), т.е. РЕГИСТР не важен,
 *     а поиск точный: `findByCode` → `WHERE code = $1`;
 *   • автовыпуск и покупка сертификата дают код `randomGiftCode()` — 16 символов
 *     Crockford base32 группами по 4 через ДЕФИС: `XXXX-XXXX-XXXX-XXXX`. Именно
 *     в этом виде код лежит в БД, показывается на /cart/success и копируется
 *     кнопкой «Скопировать». Значит дефис — ЧАСТЬ хранимого кода, и «просто
 *     выкинуть разделители» = сломать все живые сертификаты;
 *   • ручной выпуск по позиции заказа даёт `buildGiftCodeForOrderItem()` =
 *     `НОМЕР-ЗАКАЗА-XXXXXX`, где номер заказа сам содержит дефисы
 *     (`[ПРЕФИКС-]ГОД-NNNNNN`). У такого кода полезная нагрузка тоже бывает
 *     ровно 16 символов base32 («2026-000123-A1B2C3»), но группы НЕ по 4 —
 *     перегруппировка убила бы и его;
 *   • админ вводит код руками свободным текстом (`giftCodeSchema` = trim/1..64),
 *     так что произвольные разделители и пробелы внутри допустимы.
 *
 * Отсюда правило: нормализуем ТОЛЬКО то, что однозначно является каноническим
 * кодом выпуска (16 символов Crockford base32, набранных слитно либо группами
 * ровно по 4 через любые пробелы/тире) — приводим к хранимому виду
 * `XXXX-XXXX-XXXX-XXXX`. Всё остальное — только trim, ни одного символа больше.
 */

const NBSP = '\u00A0';
const NARROW_NBSP = '\u202F';
const UNICODE_HYPHEN = '\u2010';
const EN_DASH = '\u2013';
const EM_DASH = '\u2014';
const MINUS = '\u2212';

describe('normalizeGiftCode — канонический код выпуска приводится к хранимому виду', () => {
  it('код randomGiftCode() возвращается БАЙТ-В-БАЙТ (дефисы — часть хранимого кода)', () => {
    for (let i = 0; i < 64; i++) {
      const code = randomGiftCode();
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
      expect(normalizeGiftCode(code)).toBe(code);
    }
  });

  it('нижний регистр → верхний (citext, но в БД код лежит в верхнем)', () => {
    expect(normalizeGiftCode('abcd-1234-efgh-5678')).toBe('ABCD-1234-EFGH-5678');
  });

  it('покупатель набрал код СЛИТНО, без дефисов → дефисы восстановлены', () => {
    expect(normalizeGiftCode('ABCD1234EFGH5678')).toBe('ABCD-1234-EFGH-5678');
    expect(normalizeGiftCode('abcd1234efgh5678')).toBe('ABCD-1234-EFGH-5678');
  });

  it('пробелы вместо дефисов (копипаста из письма/PDF) → канонический вид', () => {
    expect(normalizeGiftCode('ABCD 1234 EFGH 5678')).toBe('ABCD-1234-EFGH-5678');
    expect(normalizeGiftCode(`ABCD${NBSP}1234${NARROW_NBSP}EFGH 5678`)).toBe(
      'ABCD-1234-EFGH-5678',
    );
    expect(normalizeGiftCode('ABCD\t1234\nEFGH  5678')).toBe('ABCD-1234-EFGH-5678');
  });

  it('юникодные тире (Word/автозамена) → ASCII-дефис', () => {
    for (const dash of [UNICODE_HYPHEN, EN_DASH, EM_DASH, MINUS]) {
      expect(normalizeGiftCode(`ABCD${dash}1234${dash}EFGH${dash}5678`)).toBe(
        'ABCD-1234-EFGH-5678',
      );
    }
  });

  it('смешанные разделители и обрамляющие пробелы', () => {
    expect(normalizeGiftCode('  abcd 1234-EFGH\u20135678 ')).toBe('ABCD-1234-EFGH-5678');
  });

  it('идемпотентна', () => {
    for (const raw of ['abcd1234efgh5678', 'ABCD 1234 EFGH 5678', '2026-000123-A1B2C3', 'NY 2026']) {
      const once = normalizeGiftCode(raw);
      expect(normalizeGiftCode(once)).toBe(once);
    }
  });
});

describe('normalizeGiftCode — коды, где разделитель ЗНАЧИМ, не трогаются', () => {
  it('код, выпущенный по позиции заказа, остаётся как есть (группы НЕ по 4)', () => {
    const code = buildGiftCodeForOrderItem({
      orderNumber: '2026-000123',
      orderItemId: 'a1b2c3d4-0000-4000-8000-000000000000',
    });
    expect(code).toBe('2026-000123-A1B2C3');
    // Ловушка: полезная нагрузка — ровно 16 символов алфавита Crockford,
    // т.е. «слепая» перегруппировка по 4 превратила бы код в несуществующий.
    expect(code.replace(/-/g, '')).toHaveLength(16);
    expect(normalizeGiftCode(code)).toBe(code);
    expect(normalizeGiftCode(` ${code} `)).toBe(code);
  });

  it('код с префиксом магазина тоже цел', () => {
    const code = buildGiftCodeForOrderItem({
      orderNumber: 'CR-2026-000123',
      orderItemId: 'a1b2c3d4-0000-4000-8000-000000000000',
    });
    expect(normalizeGiftCode(code)).toBe(code);
  });

  it('ручной код админа со значащим пробелом/дефисом не переписывается', () => {
    expect(normalizeGiftCode('GIFT 2026 SPRING')).toBe('GIFT 2026 SPRING');
    expect(normalizeGiftCode('  NY-2026  ')).toBe('NY-2026');
    expect(normalizeGiftCode('promo-code-2026')).toBe('promo-code-2026');
  });

  it('16 символов, но НЕ алфавит Crockford (есть I/L/O/U) → не перегруппировываем', () => {
    expect(normalizeGiftCode('HELLO-WORLD-FOOBAR')).toBe('HELLO-WORLD-FOOBAR');
    expect(normalizeGiftCode('HELLOWORLDFOOBAR')).toBe('HELLOWORLDFOOBAR');
  });

  it('пустой ввод и пробелы → пустая строка (код не применяется)', () => {
    expect(normalizeGiftCode('')).toBe('');
    expect(normalizeGiftCode('   ')).toBe('');
    expect(normalizeGiftCode(`${NBSP}`)).toBe('');
  });
});
