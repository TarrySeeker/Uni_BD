import { describe, it, expect } from 'vitest';

/**
 * ЮНИТ-тесты экспорта заявок (C8) — чистая функция leadsToCsv (без БД/Next).
 * Образец — tests/newsletter/export-unsubscribe.test.ts (subscribersToCsv).
 *
 * КРИТИЧНО: name/contact/message приходят из ПУБЛИЧНОЙ формы витрины
 * (недоверенный ввод), поэтому проверяем RFC 4180-квотирование И анти-CSV-инъекцию
 * (=,+,-,@) особенно тщательно.
 */

import { leadsToCsv } from '@/lib/leads/csv';

const ID = '11111111-1111-4111-8111-111111111111';

describe('leadsToCsv (экспорт заявок)', () => {
  it('заголовок + строки в порядке id,name,contact,message,status,created_at', () => {
    const csv = leadsToCsv([
      {
        id: ID,
        name: 'Иван',
        contact: 'i@e.ru',
        message: 'привет',
        status: 'new',
        created_at: new Date('2026-06-01T10:00:00Z'),
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        name: 'Пётр',
        contact: '+7 999 000',
        message: 'вопрос',
        status: 'done',
        created_at: new Date('2026-06-02T11:30:00Z'),
      },
    ]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('id,name,contact,message,status,created_at');
    expect(lines[1]).toBe(`${ID},Иван,i@e.ru,привет,new,2026-06-01T10:00:00.000Z`);
    // Контакт «+7 999 000» начинается с «+» (формульный префикс) → анти-инъекция
    // добавляет ведущий апостроф и квотирует поле. Это корректно и важно для
    // телефонов из публичной формы.
    expect(lines[2]).toBe(
      '22222222-2222-4222-8222-222222222222,Пётр,"\'+7 999 000",вопрос,done,2026-06-02T11:30:00.000Z',
    );
  });

  it('пустой список → только заголовок', () => {
    expect(leadsToCsv([])).toBe('id,name,contact,message,status,created_at');
  });

  it('экранирует запятые и кавычки в name/message (RFC 4180)', () => {
    const csv = leadsToCsv([
      {
        id: ID,
        name: 'Сидоров, Иван',
        contact: 'i@e.ru',
        message: 'он сказал "да"',
        status: 'new',
        created_at: new Date('2026-06-01T00:00:00Z'),
      },
    ]);
    expect(csv.split('\r\n')[1]).toBe(
      `${ID},"Сидоров, Иван",i@e.ru,"он сказал ""да""",new,2026-06-01T00:00:00.000Z`,
    );
  });

  it('экранирует перенос строки в сообщении', () => {
    const csv = leadsToCsv([
      {
        id: ID,
        name: 'Иван',
        contact: 'i@e.ru',
        message: 'строка1\nстрока2',
        status: 'new',
        created_at: new Date('2026-06-01T00:00:00Z'),
      },
    ]);
    expect(csv.split('\r\n')[1]).toBe(
      `${ID},Иван,i@e.ru,"строка1\nстрока2",new,2026-06-01T00:00:00.000Z`,
    );
  });

  it('анти-CSV-инъекция: name/contact/message с =,+,-,@ префиксуются апострофом', () => {
    // Публичная форма — главный риск формула-инъекции. Ведущий апостроф
    // нейтрализует исполнение в Excel/Sheets; значение целиком квотируется.
    const csv = leadsToCsv([
      {
        id: ID,
        name: '=cmd|calc',
        contact: '+79990000000',
        message: '@SUM(1+1)',
        status: 'new',
        created_at: new Date('2026-06-01T00:00:00Z'),
      },
    ]);
    expect(csv.split('\r\n')[1]).toBe(
      `${ID},"'=cmd|calc","'+79990000000","'@SUM(1+1)",new,2026-06-01T00:00:00.000Z`,
    );
  });

  it('дата → ISO-8601 (UTC)', () => {
    const csv = leadsToCsv([
      {
        id: ID,
        name: 'Иван',
        contact: 'i@e.ru',
        message: 'm',
        status: 'new',
        created_at: new Date('2026-06-26T19:47:05Z'),
      },
    ]);
    expect(csv.split('\r\n')[1]).toContain('2026-06-26T19:47:05.000Z');
  });
});
