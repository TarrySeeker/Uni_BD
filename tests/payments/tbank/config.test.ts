import { describe, it, expect } from 'vitest';
import {
  isTbankMock,
  getTbankConfig,
  parseCsvStrings,
} from '@/lib/payments/tbank/config';

/**
 * Юнит-тесты конфигурации Т-Банка (docs/15 §3). Без БД/сети, всегда зелёные.
 * Передаём source-объект, чтобы не мутировать process.env (порт cdek/config.test).
 */

describe('tbank/config — isTbankMock (ключевая mock-детекция)', () => {
  it('пустые ключи → mock=true', () => {
    expect(isTbankMock({ NODE_ENV: 'test' })).toBe(true);
  });

  it('только TerminalKey без Password → mock=true', () => {
    expect(isTbankMock({ NODE_ENV: 'test', TBANK_TERMINAL_KEY: 'tk' })).toBe(true);
  });

  it('только Password без TerminalKey → mock=true', () => {
    expect(isTbankMock({ NODE_ENV: 'test', TBANK_PASSWORD: 'pw' })).toBe(true);
  });

  it('пустые строки ключей → mock=true', () => {
    expect(
      isTbankMock({ NODE_ENV: 'test', TBANK_TERMINAL_KEY: '', TBANK_PASSWORD: '' }),
    ).toBe(true);
  });

  it('оба ключа заданы → mock=false', () => {
    expect(
      isTbankMock({ NODE_ENV: 'test', TBANK_TERMINAL_KEY: 'tk', TBANK_PASSWORD: 'pw' }),
    ).toBe(false);
  });
});

describe('tbank/config — getTbankConfig (чтение env)', () => {
  it('дефолты при пустом окружении (mock-готово)', () => {
    const cfg = getTbankConfig({ NODE_ENV: 'test' });
    expect(cfg.baseUrl).toBe('https://securepay.tinkoff.ru/v2');
    expect(cfg.terminalKey).toBeNull();
    expect(cfg.password).toBeNull();
    expect(cfg.payType).toBe('O');
    expect(cfg.receiptEnabled).toBe(false);
    expect(cfg.taxation).toBeNull();
    expect(cfg.defaultTax).toBe('none');
    expect(cfg.webhookAllowedIps).toEqual([]);
    expect(cfg.webhookTrustProxy).toBe(false);
    expect(cfg.redirectDueMin).toBe(60);
  });

  it('тестовый контур (sandbox): rest-api-test URL + тестовые ключи → НЕ mock', () => {
    const source = {
      NODE_ENV: 'test',
      TBANK_BASE_URL: 'https://rest-api-test.tinkoff.ru/v2',
      TBANK_TERMINAL_KEY: 'TestTerminalKey',
      TBANK_PASSWORD: 'TestPassword',
    };
    expect(isTbankMock(source)).toBe(false);
    const cfg = getTbankConfig(source);
    expect(cfg.baseUrl).toBe('https://rest-api-test.tinkoff.ru/v2');
    expect(cfg.terminalKey).toBe('TestTerminalKey');
    expect(cfg.password).toBe('TestPassword');
  });

  it('PayType T (двухстадийная) читается', () => {
    expect(getTbankConfig({ NODE_ENV: 'test', TBANK_PAY_TYPE: 'T' }).payType).toBe('T');
  });

  it('receiptEnabled coerce из строки', () => {
    expect(getTbankConfig({ NODE_ENV: 'test', TBANK_RECEIPT_ENABLED: 'true' }).receiptEnabled).toBe(
      true,
    );
    expect(getTbankConfig({ NODE_ENV: 'test', TBANK_RECEIPT_ENABLED: '1' }).receiptEnabled).toBe(
      true,
    );
  });

  it('webhook IP-whitelist парсится из csv', () => {
    const cfg = getTbankConfig({
      NODE_ENV: 'test',
      TBANK_WEBHOOK_IPS: '91.194.226.0/23, 91.218.132.10 ',
    });
    expect(cfg.webhookAllowedIps).toEqual(['91.194.226.0/23', '91.218.132.10']);
  });

  it('taxation/defaultTax/redirectDueMin переопределяются', () => {
    const cfg = getTbankConfig({
      NODE_ENV: 'test',
      TBANK_TAXATION: 'usn_income',
      TBANK_DEFAULT_TAX: 'vat20',
      TBANK_REDIRECT_DUE_MIN: '120',
    });
    expect(cfg.taxation).toBe('usn_income');
    expect(cfg.defaultTax).toBe('vat20');
    expect(cfg.redirectDueMin).toBe(120);
  });
});

describe('tbank/config — csv-парсер', () => {
  it('parseCsvStrings: триммит и убирает пустые', () => {
    expect(parseCsvStrings(undefined)).toEqual([]);
    expect(parseCsvStrings(' a , b ,, c ')).toEqual(['a', 'b', 'c']);
  });
});
