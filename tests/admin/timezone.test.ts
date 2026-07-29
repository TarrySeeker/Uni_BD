import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SHOP_TIME_ZONE,
  parseTimeZone,
  resolveShopTimeZone,
  getShopTimeZone,
  utcDayRangeForShopDay,
} from '@/lib/admin/timezone';
import { formatDateTime } from '@/lib/admin/order-format';

/**
 * Аудит, major №26 — ЧАСОВЫЕ ПОЯСА админки.
 *
 * До правки: order-format.formatDateTime рендерил время БЕЗ timeZone (то есть в
 * поясе контейнера — обычно UTC), а журнал аудита жёстко ставил 'Europe/Moscow'.
 * Оператор видел одно событие в двух поясах на соседних экранах. Фильтр по датам
 * в списке заказов резал по UTC-суткам, и «заказы за сегодня» теряли ночные
 * заказы (в МСК = UTC+3 заказ в 01:00 попадает в предыдущие UTC-сутки).
 *
 * 🔴 МУЛЬТИТЕНАНТНОСТЬ: Москва НЕ хардкодится. Пояс — настройка магазина
 * (shop_settings.branding.timeZone), env SHOP_TIMEZONE — дефолт инстанса,
 * 'Europe/Moscow' — дефолт платформы (базовый рынок). Магазин в другом поясе
 * меняет ОДНУ настройку, и все три экрана (аудит/список/карточка) едут вместе.
 */

describe('timezone — граница клиент↔сервер (leaf без БД)', () => {
  it('order-format тянет ЧИСТЫЙ leaf, а не серверный timezone.ts', () => {
    // order-format импортируют КЛИЕНТСКИЕ компоненты (OrderFilters, PromoForm).
    // Если он потянет timezone.ts (тот читает shop_settings → lib/db/client →
    // драйвер postgres), прод-сборка упадёт на «Can't resolve 'fs'/'net'/'tls'».
    const src = readFileSync(join(process.cwd(), 'lib/admin/order-format.ts'), 'utf8');
    expect(src).toContain("from '@/lib/admin/timezone-token'");
    expect(src, 'order-format снова тянет серверный timezone.ts — сборка упадёт').not.toMatch(
      /from '@\/lib\/admin\/timezone'/,
    );
  });

  it('leaf вообще не имеет импортов — значит, не может утянуть БД в браузер', () => {
    const leaf = readFileSync(join(process.cwd(), 'lib/admin/timezone-token.ts'), 'utf8')
      // Комментарии обязаны объяснять, ЧЕГО здесь нет, — иначе следующий читатель
      // не поймёт запрета; за живой код их считать нельзя.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(leaf, 'в client-safe leaf появился импорт — проверьте, что он не тянет БД').not.toMatch(
      /^\s*import\s/m,
    );
    expect(leaf).not.toMatch(/require\(/);
  });

  it('серверный модуль ре-экспортирует leaf — у сервера один вход', () => {
    expect(parseTimeZone('UTC')).toBe('UTC');
    expect(DEFAULT_SHOP_TIME_ZONE).toBeTruthy();
  });
});

describe('timezone — parseTimeZone (валидация IANA-идентификатора)', () => {
  it('валидный IANA-идентификатор проходит как есть', () => {
    expect(parseTimeZone('Europe/Moscow')).toBe('Europe/Moscow');
    expect(parseTimeZone('Europe/Paris')).toBe('Europe/Paris');
    expect(parseTimeZone('Asia/Yekaterinburg')).toBe('Asia/Yekaterinburg');
    expect(parseTimeZone('UTC')).toBe('UTC');
  });

  it('пробелы обрезаются', () => {
    expect(parseTimeZone('  Europe/Paris  ')).toBe('Europe/Paris');
  });

  it('мусор/пустое/не строка → null (не бросает)', () => {
    expect(parseTimeZone('Мордор/Барад-Дур')).toBeNull();
    expect(parseTimeZone('')).toBeNull();
    expect(parseTimeZone('   ')).toBeNull();
    expect(parseTimeZone(null)).toBeNull();
    expect(parseTimeZone(undefined)).toBeNull();
    expect(parseTimeZone(42)).toBeNull();
    expect(parseTimeZone({ tz: 'Europe/Moscow' })).toBeNull();
  });
});

describe('timezone — resolveShopTimeZone (приоритет настройка → env → платформа)', () => {
  it('настройка магазина побеждает env', () => {
    expect(
      resolveShopTimeZone({ timeZone: 'Europe/Paris' }, { SHOP_TIMEZONE: 'Asia/Tokyo' }),
    ).toBe('Europe/Paris');
  });

  it('нет настройки → env инстанса', () => {
    expect(resolveShopTimeZone({}, { SHOP_TIMEZONE: 'Asia/Tokyo' })).toBe('Asia/Tokyo');
    expect(resolveShopTimeZone(null, { SHOP_TIMEZONE: 'Asia/Tokyo' })).toBe('Asia/Tokyo');
  });

  it('нет ни настройки, ни env → дефолт платформы', () => {
    expect(resolveShopTimeZone(null, {})).toBe(DEFAULT_SHOP_TIME_ZONE);
    expect(resolveShopTimeZone({}, {})).toBe(DEFAULT_SHOP_TIME_ZONE);
  });

  it('битая настройка НЕ роняет экран — откат на env, затем на платформу', () => {
    expect(resolveShopTimeZone({ timeZone: 'Nowhere/Nothing' }, { SHOP_TIMEZONE: 'Asia/Tokyo' })).toBe(
      'Asia/Tokyo',
    );
    expect(resolveShopTimeZone({ timeZone: 'Nowhere/Nothing' }, { SHOP_TIMEZONE: 'тоже мусор' })).toBe(
      DEFAULT_SHOP_TIME_ZONE,
    );
  });

  it('дефолт платформы сам обязан быть валидным поясом', () => {
    expect(parseTimeZone(DEFAULT_SHOP_TIME_ZONE)).toBe(DEFAULT_SHOP_TIME_ZONE);
  });
});

describe('timezone — getShopTimeZone (чтение shop_settings.branding, fail-safe)', () => {
  it('берёт timeZone из значения ключа branding', async () => {
    const tz = await getShopTimeZone(async () => ({ timeZone: 'Europe/Paris' }), {});
    expect(tz).toBe('Europe/Paris');
  });

  it('ключа нет → дефолт, без броска', async () => {
    expect(await getShopTimeZone(async () => null, {})).toBe(DEFAULT_SHOP_TIME_ZONE);
  });

  it('читатель упал (БД недоступна) → дефолт, без броска', async () => {
    const tz = await getShopTimeZone(async () => {
      throw new Error('db down');
    }, {});
    expect(tz).toBe(DEFAULT_SHOP_TIME_ZONE);
  });
});

describe('timezone — utcDayRangeForShopDay (фильтр «за сегодня» не теряет ночь)', () => {
  it('сутки МСК начинаются в 21:00 UTC предыдущего дня', () => {
    const { fromUtc, toUtc } = utcDayRangeForShopDay('2026-06-15', '2026-06-15', 'Europe/Moscow');
    expect(fromUtc).toBe('2026-06-14T21:00:00.000Z');
    // Верхняя граница — ЭКСКЛЮЗИВНАЯ: начало следующих суток магазина.
    expect(toUtc).toBe('2026-06-15T21:00:00.000Z');
  });

  it('🔴 заказ, сделанный в 01:00 МСК, попадает в СВОИ сутки, а не в предыдущие', () => {
    // 2026-06-15 01:00 МСК == 2026-06-14T22:00Z. По старой UTC-логике фильтр
    // «за 15 июня» (00:00Z..23:59Z) этот заказ ТЕРЯЛ.
    const nightOrder = new Date('2026-06-14T22:00:00.000Z');
    const { fromUtc, toUtc } = utcDayRangeForShopDay('2026-06-15', '2026-06-15', 'Europe/Moscow');
    expect(nightOrder >= new Date(fromUtc!)).toBe(true);
    expect(nightOrder < new Date(toUtc!)).toBe(true);
  });

  it('заказ в 23:30 МСК того же дня тоже внутри диапазона', () => {
    const lateOrder = new Date('2026-06-15T20:30:00.000Z'); // 23:30 МСК
    const { fromUtc, toUtc } = utcDayRangeForShopDay('2026-06-15', '2026-06-15', 'Europe/Moscow');
    expect(lateOrder >= new Date(fromUtc!)).toBe(true);
    expect(lateOrder < new Date(toUtc!)).toBe(true);
  });

  it('заказ в 00:30 МСК СЛЕДУЮЩЕГО дня уже вне диапазона', () => {
    const nextDay = new Date('2026-06-15T21:30:00.000Z'); // 00:30 МСК 16-го
    const { toUtc } = utcDayRangeForShopDay('2026-06-15', '2026-06-15', 'Europe/Moscow');
    expect(nextDay < new Date(toUtc!)).toBe(false);
  });

  it('пояс с отрицательным смещением (UTC-5) — сутки начинаются позже полуночи UTC', () => {
    const { fromUtc, toUtc } = utcDayRangeForShopDay('2026-01-15', '2026-01-15', 'America/New_York');
    expect(fromUtc).toBe('2026-01-15T05:00:00.000Z');
    expect(toUtc).toBe('2026-01-16T05:00:00.000Z');
  });

  it('UTC-магазин ведёт себя как раньше (границы ровно по суткам UTC)', () => {
    const { fromUtc, toUtc } = utcDayRangeForShopDay('2026-06-15', '2026-06-15', 'UTC');
    expect(fromUtc).toBe('2026-06-15T00:00:00.000Z');
    expect(toUtc).toBe('2026-06-16T00:00:00.000Z');
  });

  it('задана только нижняя/только верхняя граница', () => {
    expect(utcDayRangeForShopDay('2026-06-15', undefined, 'Europe/Moscow')).toEqual({
      fromUtc: '2026-06-14T21:00:00.000Z',
      toUtc: null,
    });
    expect(utcDayRangeForShopDay(undefined, '2026-06-15', 'Europe/Moscow')).toEqual({
      fromUtc: null,
      toUtc: '2026-06-15T21:00:00.000Z',
    });
  });

  it('границы не заданы → null/null (фильтр по дате не применяется)', () => {
    expect(utcDayRangeForShopDay(undefined, undefined, 'Europe/Moscow')).toEqual({
      fromUtc: null,
      toUtc: null,
    });
  });

  it('мусорная дата не роняет фильтр (трактуется как «не задано»)', () => {
    expect(utcDayRangeForShopDay('вчера', 'позавчера', 'Europe/Moscow')).toEqual({
      fromUtc: null,
      toUtc: null,
    });
  });

  it('битый пояс не роняет фильтр — считает в дефолтном поясе платформы', () => {
    const broken = utcDayRangeForShopDay('2026-06-15', '2026-06-15', 'Nowhere/Nothing');
    const fallback = utcDayRangeForShopDay('2026-06-15', '2026-06-15', DEFAULT_SHOP_TIME_ZONE);
    expect(broken).toEqual(fallback);
  });
});

describe('order-format — formatDateTime уважает часовой пояс магазина (major №26)', () => {
  it('одно и то же мгновение в разных поясах даёт РАЗНОЕ время', () => {
    const instant = new Date('2026-06-15T22:30:00.000Z');
    const msk = formatDateTime(instant, 'Europe/Moscow'); // 16.06 01:30
    const utc = formatDateTime(instant, 'UTC'); // 15.06 22:30
    expect(msk).not.toBe(utc);
    expect(msk).toContain('16.06.2026');
    expect(utc).toContain('15.06.2026');
  });

  it('без явного пояса используется дефолт платформы (а НЕ пояс контейнера)', () => {
    const instant = new Date('2026-06-15T22:30:00.000Z');
    expect(formatDateTime(instant)).toBe(formatDateTime(instant, DEFAULT_SHOP_TIME_ZONE));
  });

  it('битый пояс не роняет ячейку таблицы — откат на дефолт платформы', () => {
    const instant = new Date('2026-06-15T22:30:00.000Z');
    expect(formatDateTime(instant, 'Nowhere/Nothing')).toBe(
      formatDateTime(instant, DEFAULT_SHOP_TIME_ZONE),
    );
  });

  it('null/невалидная дата по-прежнему «—» (регресс существующего контракта)', () => {
    expect(formatDateTime(null, 'Europe/Moscow')).toBe('—');
    expect(formatDateTime(undefined, 'Europe/Moscow')).toBe('—');
    expect(formatDateTime('not-a-date', 'Europe/Moscow')).toBe('—');
  });
});
