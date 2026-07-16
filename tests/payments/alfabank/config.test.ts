import { describe, it, expect } from 'vitest';
import {
  getAlfabankConfig,
  isAlfabankMock,
  parseCsvStrings,
} from '@/lib/payments/alfabank/config';

/**
 * Юнит-тесты конфигурации alfabank. Чистые: source-инъекция env без мутации
 * process.env. КЛЮЧЕВОЕ: isAlfabankMock=true при пустом USERNAME|PASSWORD.
 */

const BASE = { NODE_ENV: 'test' as const };

describe('alfabank/config — isAlfabankMock', () => {
  it('пустой USERNAME → mock', () => {
    expect(isAlfabankMock({ ...BASE, ALFABANK_PASSWORD: 'p' })).toBe(true);
  });

  it('пустой PASSWORD → mock', () => {
    expect(isAlfabankMock({ ...BASE, ALFABANK_USERNAME: 'u' })).toBe(true);
  });

  it('оба пустые → mock', () => {
    expect(isAlfabankMock({ ...BASE })).toBe(true);
  });

  it('USERNAME и PASSWORD заданы → НЕ mock (боевой)', () => {
    expect(isAlfabankMock({ ...BASE, ALFABANK_USERNAME: 'u', ALFABANK_PASSWORD: 'p' })).toBe(false);
  });

  it('пустые строки трактуются как отсутствие → mock', () => {
    expect(isAlfabankMock({ ...BASE, ALFABANK_USERNAME: '', ALFABANK_PASSWORD: '' })).toBe(true);
  });
});

describe('alfabank/config — getAlfabankConfig', () => {
  it('читает все поля из env с дефолтами (тестовый gateway по умолчанию)', () => {
    const cfg = getAlfabankConfig({
      ...BASE,
      ALFABANK_USERNAME: 'merchant',
      ALFABANK_PASSWORD: 'pass',
      ALFABANK_CALLBACK_SECRET: 'hmac-secret',
      ALFABANK_RETURN_URL: 'https://shop.example/thanks',
      ALFABANK_WEBHOOK_IPS: '1.2.3.4, 5.6.7.0/24',
      ALFABANK_WEBHOOK_TRUST_PROXY: 'true',
    });
    // Дефолтный gateway — ТЕСТОВЫЙ контур (безопасно), не боевой.
    expect(cfg.gateway).toBe('https://alfa.rbsuat.com');
    expect(cfg.username).toBe('merchant');
    expect(cfg.password).toBe('pass');
    expect(cfg.callbackSecret).toBe('hmac-secret');
    expect(cfg.returnUrl).toBe('https://shop.example/thanks');
    expect(cfg.webhookAllowedIps).toEqual(['1.2.3.4', '5.6.7.0/24']);
    expect(cfg.webhookTrustProxy).toBe(true);
  });

  it('пустые ключи → null (mock-совместимо)', () => {
    const cfg = getAlfabankConfig({ ...BASE });
    expect(cfg.username).toBeNull();
    expect(cfg.password).toBeNull();
    expect(cfg.callbackSecret).toBeNull();
    expect(cfg.returnUrl).toBeNull();
    expect(cfg.webhookAllowedIps).toEqual([]);
    expect(cfg.webhookTrustProxy).toBe(false);
  });

  it('боевой gateway задаётся через env', () => {
    const cfg = getAlfabankConfig({
      ...BASE,
      ALFABANK_GATEWAY: 'https://payment.alfabank.ru',
      ALFABANK_USERNAME: 'u',
      ALFABANK_PASSWORD: 'p',
    });
    expect(cfg.gateway).toBe('https://payment.alfabank.ru');
  });

  it('cronSecret берётся из CDEK_CRON_SECRET (общий секрет инстанса)', () => {
    expect(getAlfabankConfig({ ...BASE, CDEK_CRON_SECRET: 'shh' }).cronSecret).toBe('shh');
    expect(getAlfabankConfig({ ...BASE }).cronSecret).toBeNull();
  });
});

describe('alfabank/config — parseCsvStrings', () => {
  it('разбивает csv, тримит, отбрасывает пустые', () => {
    expect(parseCsvStrings(' a , b ,, c ')).toEqual(['a', 'b', 'c']);
    expect(parseCsvStrings(undefined)).toEqual([]);
    expect(parseCsvStrings('')).toEqual([]);
  });
});
