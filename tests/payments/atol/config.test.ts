/**
 * Конфигурация АТОЛ Pay: чтение окружения без мутации process.env.
 *
 * Два разряда проверок:
 *   1) mock-режим — магазин без боевого токена не должен ТИХО выглядеть рабочим;
 *   2) фискальные реквизиты (sno, tax) — их нельзя подставлять «разумным
 *      дефолтом»: неверная СНО или ставка НДС в чеке = нарушение 54-ФЗ.
 */

import { describe, it, expect } from 'vitest';

import {
  getAtolConfig,
  isAtolMock,
  canVerifyAtolCallbacks,
  atolConfigProblems,
  ATOL_DEFAULT_BASE_URL,
  ATOL_SANDBOX_BASE_URL,
} from '@/lib/payments/atol/config';

/** Минимально «боевое» окружение. */
const LIVE = {
  // Форма токена АТОЛа (32 hex), но значение ВЫМЫШЛЕННОЕ: боевым секретам
  // не место в репозитории кита, который ставится многим магазинам.
  ATOL_PAY_TOKEN: '0123456789abcdef0123456789abcdef',
  ATOL_PAY_NOTIFICATION_SECRET: 'a'.repeat(32),
  ATOL_PAY_SNO: '1',
  ATOL_PAY_DEFAULT_TAX: '5',
} as const;

describe('payments/atol/config — mock-режим', () => {
  /**
   * ⚠️ Урок СВформы/DAV: mock не падает и не ругается — магазин выглядит
   * рабочим, а оплата ненастоящая. Отсутствие токена обязано читаться как mock.
   */
  it('без токена — mock', () => {
    expect(isAtolMock({})).toBe(true);
    expect(isAtolMock({ ATOL_PAY_TOKEN: '   ' })).toBe(true);
  });

  it('с токеном — не mock', () => {
    expect(isAtolMock({ ...LIVE })).toBe(false);
  });

  it('пробелы вокруг значений обрезаются', () => {
    const cfg = getAtolConfig({ ...LIVE, ATOL_PAY_TOKEN: '  tok  ' });
    expect(cfg.token).toBe('tok');
  });
});

describe('payments/atol/config — базовый URL', () => {
  it('по умолчанию боевой контур', () => {
    expect(getAtolConfig({ ...LIVE }).baseUrl).toBe(ATOL_DEFAULT_BASE_URL);
  });

  it('песочница включается явным флагом', () => {
    const cfg = getAtolConfig({ ...LIVE, ATOL_PAY_SANDBOX: 'true' });
    expect(cfg.baseUrl).toBe(ATOL_SANDBOX_BASE_URL);
  });

  it('явный URL переопределяет всё', () => {
    const cfg = getAtolConfig({ ...LIVE, ATOL_PAY_BASE_URL: 'https://example.test/v1/ecom/' });
    expect(cfg.baseUrl).toBe('https://example.test/v1/ecom/');
  });
});

describe('payments/atol/config — 🔴 фискальные реквизиты (54-ФЗ)', () => {
  /**
   * 🔴 sno и tax уходят в КАЖДЫЙ чек. Молчаливый дефолт здесь — это чек с
   * неверной системой налогообложения, то есть нарушение 54-ФЗ, которое
   * обнаружится по требованию налоговой, а не по упавшему тесту.
   */
  it('🔴 без sno и tax конфиг не считается готовым к чекам', () => {
    const problems = atolConfigProblems({ ATOL_PAY_TOKEN: 'tok' });
    expect(problems.join(' ')).toMatch(/ATOL_PAY_SNO/);
    expect(problems.join(' ')).toMatch(/ATOL_PAY_DEFAULT_TAX/);
  });

  it('🔴 sno и tax не получают значения по умолчанию', () => {
    const cfg = getAtolConfig({ ATOL_PAY_TOKEN: 'tok' });
    expect(cfg.sno).toBeNull();
    expect(cfg.defaultTax).toBeNull();
  });

  it('заданные sno и tax читаются как числа', () => {
    const cfg = getAtolConfig({ ...LIVE });
    // Пример: УСН Доход (1) + «Без НДС» (5) — частый случай у небольших ИМ.
    expect(cfg.sno).toBe(1);
    expect(cfg.defaultTax).toBe(5);
  });

  /**
   * 🔴 Ловушка словаря АТОЛа: «Без НДС» = 5, а 0 = НДС 20%. Ноль — законное
   * значение (ОСНО со ставкой 20%), поэтому реализация не имеет права
   * отбрасывать его как falsy и «чинить» на 5.
   */
  it('🔴 tax=0 (НДС 20%) сохраняется, а не подменяется', () => {
    const cfg = getAtolConfig({ ...LIVE, ATOL_PAY_DEFAULT_TAX: '0' });
    expect(cfg.defaultTax).toBe(0);
  });

  it('🔴 sno=0 (общая СН) сохраняется, а не считается «не задано»', () => {
    const cfg = getAtolConfig({ ...LIVE, ATOL_PAY_SNO: '0' });
    expect(cfg.sno).toBe(0);
  });

  it('нечисловые и отрицательные значения отбрасываются', () => {
    expect(getAtolConfig({ ...LIVE, ATOL_PAY_SNO: 'усн' }).sno).toBeNull();
    expect(getAtolConfig({ ...LIVE, ATOL_PAY_DEFAULT_TAX: '-1' }).defaultTax).toBeNull();
  });
});

describe('payments/atol/config — 🔴 секрет callback', () => {
  /**
   * 🔴 У callback АТОЛа НЕТ подписи. Секрет в query-параметре — единственный
   * канал аутентификации, который даёт API. Без него принимать вебхуки нельзя:
   * кто угодно, узнав URL, объявит неоплаченный заказ оплаченным.
   */
  it('🔴 без секрета вебхуки проверять нечем', () => {
    expect(canVerifyAtolCallbacks({ ATOL_PAY_TOKEN: 'tok' })).toBe(false);
  });

  it('с секретом — проверка возможна', () => {
    expect(canVerifyAtolCallbacks({ ...LIVE })).toBe(true);
  });

  /**
   * Короткий секрет перебирается, а сверка идёт по открытому URL (он попадает
   * в логи). Слабый секрет здесь хуже, чем очевидно отсутствующий.
   */
  it('🔴 слишком короткий секрет не принимается', () => {
    expect(canVerifyAtolCallbacks({ ATOL_PAY_TOKEN: 'tok', ATOL_PAY_NOTIFICATION_SECRET: 'abc' })).toBe(
      false,
    );
    const problems = atolConfigProblems({
      ATOL_PAY_TOKEN: 'tok',
      ATOL_PAY_NOTIFICATION_SECRET: 'abc',
    });
    expect(problems.join(' ')).toMatch(/ATOL_PAY_NOTIFICATION_SECRET/);
  });
});

describe('payments/atol/config — прочее', () => {
  it('sessionType по умолчанию одностадийный', () => {
    expect(getAtolConfig({ ...LIVE }).sessionType).toBe('oneStep');
    expect(getAtolConfig({ ...LIVE, ATOL_PAY_SESSION_TYPE: 'twoStep' }).sessionType).toBe('twoStep');
  });

  it('мусор в sessionType не превращает оплату в двухстадийную', () => {
    expect(getAtolConfig({ ...LIVE, ATOL_PAY_SESSION_TYPE: 'нечто' }).sessionType).toBe('oneStep');
  });

  it('id банков читаются, при отсутствии — null (банк берётся из настроек ЛК)', () => {
    const cfg = getAtolConfig({ ...LIVE, ATOL_PAY_CARD_BANK_ID: '600', ATOL_PAY_SBP_BANK_ID: '400' });
    expect(cfg.cardBankId).toBe(600);
    expect(cfg.sbpBankId).toBe(400);
    expect(getAtolConfig({ ...LIVE }).cardBankId).toBeNull();
  });

  it('полностью боевой конфиг не имеет замечаний', () => {
    expect(atolConfigProblems({ ...LIVE })).toEqual([]);
  });
});
