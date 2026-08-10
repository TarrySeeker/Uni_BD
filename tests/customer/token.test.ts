import { describe, it, expect } from 'vitest';

import { generateRawToken, hashToken, safeEqualHex } from '@/lib/customer/token';

/**
 * Одноразовые токены покупателя (подтверждение адреса, сброс пароля).
 *
 * Модель безопасности, которую стерегут эти тесты:
 *   • сырой токен уходит покупателю в письмо и НИГДЕ не хранится;
 *   • в базе лежит только его sha256 — дамп базы, лог запроса или доступ
 *     «только на чтение» не дают подтвердить чужой адрес и сбросить чужой пароль;
 *   • sha256, а не argon2: токен высокоэнтропийный и живёт часы, перебирать его
 *     бессмысленно, а замедлять проверку на каждом переходе по ссылке — вредно.
 *
 * Логика чистая (крипто без БД и сети) — поэтому проверяется напрямую.
 */

describe('customer/token — генерация', () => {
  it('токен непредсказуем: 100 генераций дают 100 разных значений', () => {
    const seen = new Set(Array.from({ length: 100 }, () => generateRawToken()));
    expect(seen.size).toBe(100);
  });

  it('длина соответствует 32 байтам энтропии (256 бит) в hex', () => {
    // Меньше — уже перебираемо; hex выбран, чтобы токен безопасно жил в URL письма.
    expect(generateRawToken()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('customer/token — хеширование', () => {
  it('одинаковый вход даёт одинаковый хеш (иначе ссылку не проверить)', () => {
    const raw = generateRawToken();
    expect(hashToken(raw)).toBe(hashToken(raw));
  });

  it('разные токены дают разные хеши', () => {
    expect(hashToken(generateRawToken())).not.toBe(hashToken(generateRawToken()));
  });

  it('хеш не содержит исходный токен — иначе хранение было бы бессмысленным', () => {
    const raw = generateRawToken();
    expect(hashToken(raw)).not.toContain(raw);
  });

  it('результат — hex-строка sha256 фиксированной длины', () => {
    expect(hashToken('что угодно')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('customer/token — сравнение хешей', () => {
  it('совпадающие хеши признаются равными', () => {
    const h = hashToken(generateRawToken());
    expect(safeEqualHex(h, h)).toBe(true);
  });

  it('несовпадающие — не равными', () => {
    expect(safeEqualHex(hashToken('a'), hashToken('b'))).toBe(false);
  });

  it('пустая строка НЕ равна пустой строке', () => {
    // Иначе отсутствие токена совпадало бы с отсутствием токена, и запрос без
    // токена проходил бы проверку.
    expect(safeEqualHex('', '')).toBe(false);
  });

  it('строки разной длины не равны и не роняют сравнение', () => {
    expect(safeEqualHex('ab', 'abcd')).toBe(false);
  });

  it('не-hex мусор не роняет сравнение, а даёт false', () => {
    // Значение приходит из URL, то есть от постороннего: любой ввод обязан
    // приводить к отказу, а не к исключению.
    expect(safeEqualHex('не hex вовсе', hashToken('x'))).toBe(false);
  });
});
