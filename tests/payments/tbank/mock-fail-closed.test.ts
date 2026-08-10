import { describe, it, expect } from 'vitest';

import {
  isTbankMock,
  getTbankConfig,
  resolveTbankMock,
  TBANK_MOCK_IN_PRODUCTION_ERROR,
} from '@/lib/payments/tbank/config';
import { TbankManager } from '@/lib/payments/tbank/manager';

/**
 * FAIL-CLOSED mock Т-Банка в production.
 *
 * ПОЧЕМУ ЭТО КРИТИЧНО. В mock-режиме оплата не ходит в банк, а фоновая
 * доводка платежей помечает заказ `paid`. Значит, потерянный или не
 * проброшенный `TBANK_PASSWORD` на боевом сервере превращал магазин в
 * раздачу товара: заказы становились «оплаченными» без единого рубля, и
 * ничто в интерфейсе об этом не сообщало.
 *
 * Молчаливая деградация в mock — не гипотеза: пустые ключи интеграций
 * находились во ВСЕХ бэкапах `.env` живого магазина, а владелец был уверен,
 * что передал их. Поэтому поведение по умолчанию должно быть «упасть», а не
 * «тихо продолжить».
 *
 * ДВЕ ВЕТКИ, А НЕ ОДНА. Боевой путь оплаты спрашивает `TbankManager.isMock`,
 * а не `isTbankMock()`. Пока эти ветки считали признак независимо, защита,
 * поставленная в одной, на боевом пути просто не срабатывала. Тесты ниже
 * стерегут ОБЕ — и это главное, что они проверяют.
 */

/** Боевое окружение без ключей — самый опасный сценарий. */
const PROD_NO_KEYS = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  SESSION_SECRET: 'x'.repeat(32),
} as Record<string, string | undefined>;

/** Боевое окружение с ключами — нормальная работа. */
const PROD_WITH_KEYS = {
  ...PROD_NO_KEYS,
  TBANK_TERMINAL_KEY: 'term-1',
  TBANK_PASSWORD: 'secret-1',
};

describe('tbank/fail-closed — production без ключей', () => {
  it('isTbankMock БРОСАЕТ: молчаливый mock в проде = бесплатные «оплаченные» заказы', () => {
    expect(() => isTbankMock(PROD_NO_KEYS)).toThrow(TBANK_MOCK_IN_PRODUCTION_ERROR);
  });

  it('TbankManager.isMock тоже бросает — боевой путь оплаты идёт через него, не через isTbankMock', () => {
    const manager = new TbankManager({ config: getTbankConfig(PROD_NO_KEYS) });
    expect(() => manager.isMock).toThrow(TBANK_MOCK_IN_PRODUCTION_ERROR);
  });

  it('текст ошибки называет и причину, и способ починки (его читает админ на проде)', () => {
    expect(TBANK_MOCK_IN_PRODUCTION_ERROR).toMatch(/TBANK_TERMINAL_KEY|TBANK_PASSWORD/);
    expect(TBANK_MOCK_IN_PRODUCTION_ERROR).toContain('TBANK_ALLOW_MOCK');
  });

  it('потерян ТОЛЬКО пароль (ключ терминала на месте) — тоже блокируется', () => {
    const halfConfigured = { ...PROD_NO_KEYS, TBANK_TERMINAL_KEY: 'term-1' };
    expect(() => isTbankMock(halfConfigured)).toThrow(TBANK_MOCK_IN_PRODUCTION_ERROR);
  });
});

describe('tbank/fail-closed — легальные сценарии не ломаются', () => {
  it('production с боевыми ключами → не mock, ошибки нет', () => {
    expect(isTbankMock(PROD_WITH_KEYS)).toBe(false);
  });

  it('production + явный TBANK_ALLOW_MOCK=true → demo-стенд разрешён осознанно', () => {
    const demo = { ...PROD_NO_KEYS, TBANK_ALLOW_MOCK: 'true' };
    expect(isTbankMock(demo)).toBe(true);
  });

  it('вне production (dev/CI) mock свободен — иначе онбординг без ключей невозможен', () => {
    const dev = { ...PROD_NO_KEYS, NODE_ENV: 'development' };
    expect(isTbankMock(dev)).toBe(true);

    const test = { ...PROD_NO_KEYS, NODE_ENV: 'test' };
    expect(isTbankMock(test)).toBe(true);
  });
});

describe('tbank/fail-closed — единая точка решения', () => {
  it('resolveTbankMock решает по КОНФИГУ, а не по process.env по месту вызова', () => {
    // Признак едет в конфиге: инжектированный конфиг в тестах ведёт себя ровно
    // так же, как боевой, и ни один потребитель не может обойти решение,
    // прочитав окружение самостоятельно.
    const cfg = getTbankConfig(PROD_NO_KEYS);
    expect(cfg.mockAllowed).toBe(false);
    expect(() => resolveTbankMock(cfg)).toThrow(TBANK_MOCK_IN_PRODUCTION_ERROR);
  });

  it('mockAllowed вычислен из окружения один раз и виден в конфиге', () => {
    expect(getTbankConfig(PROD_WITH_KEYS).mockAllowed).toBe(false);
    expect(getTbankConfig({ ...PROD_NO_KEYS, NODE_ENV: 'development' }).mockAllowed).toBe(true);
    expect(getTbankConfig({ ...PROD_NO_KEYS, TBANK_ALLOW_MOCK: 'true' }).mockAllowed).toBe(true);
  });
});
