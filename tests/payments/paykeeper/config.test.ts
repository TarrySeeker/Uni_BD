import { describe, it, expect } from 'vitest';
import {
  getPaykeeperConfig,
  isPaykeeperMock,
  parseCsvStrings,
} from '@/lib/payments/paykeeper/config';

/**
 * Юнит-тесты конфигурации paykeeper (docs/24 §2). Чистые: source-инъекция env без
 * мутации process.env. КЛЮЧЕВОЕ: isPaykeeperMock=true при пустом LOGIN|PASSWORD.
 */

const BASE = { NODE_ENV: 'test' as const };

describe('paykeeper/config — isPaykeeperMock', () => {
  it('пустой LOGIN → mock', () => {
    expect(isPaykeeperMock({ ...BASE, PAYKEEPER_PASSWORD: 'p' })).toBe(true);
  });

  it('пустой PASSWORD → mock', () => {
    expect(isPaykeeperMock({ ...BASE, PAYKEEPER_LOGIN: 'l' })).toBe(true);
  });

  it('оба пустые → mock', () => {
    expect(isPaykeeperMock({ ...BASE })).toBe(true);
  });

  it('LOGIN и PASSWORD заданы → НЕ mock (боевой)', () => {
    expect(isPaykeeperMock({ ...BASE, PAYKEEPER_LOGIN: 'l', PAYKEEPER_PASSWORD: 'p' })).toBe(false);
  });

  it('пустые строки трактуются как отсутствие → mock', () => {
    expect(isPaykeeperMock({ ...BASE, PAYKEEPER_LOGIN: '', PAYKEEPER_PASSWORD: '' })).toBe(true);
  });
});

describe('paykeeper/config — getPaykeeperConfig', () => {
  it('читает все поля из env с дефолтами', () => {
    const cfg = getPaykeeperConfig({
      ...BASE,
      PAYKEEPER_BASE_URL: 'https://shop.server.paykeeper.ru',
      PAYKEEPER_LOGIN: 'login',
      PAYKEEPER_PASSWORD: 'pass',
      PAYKEEPER_SECRET: 'secret-word',
      PAYKEEPER_WEBHOOK_IPS: '1.2.3.4, 5.6.7.0/24',
      PAYKEEPER_WEBHOOK_TRUST_PROXY: 'true',
    });
    expect(cfg.baseUrl).toBe('https://shop.server.paykeeper.ru');
    expect(cfg.login).toBe('login');
    expect(cfg.password).toBe('pass');
    expect(cfg.secret).toBe('secret-word');
    expect(cfg.serviceName).toBe('Sale');
    expect(cfg.defaultTax).toBe('vat20');
    expect(cfg.lang).toBe('ru');
    expect(cfg.webhookAllowedIps).toEqual(['1.2.3.4', '5.6.7.0/24']);
    expect(cfg.webhookTrustProxy).toBe(true);
  });

  it('пустые ключи → null (mock-совместимо)', () => {
    const cfg = getPaykeeperConfig({ ...BASE });
    expect(cfg.login).toBeNull();
    expect(cfg.password).toBeNull();
    expect(cfg.secret).toBeNull();
    expect(cfg.webhookAllowedIps).toEqual([]);
    expect(cfg.webhookTrustProxy).toBe(false);
  });

  it('cronSecret берётся из CDEK_CRON_SECRET (общий секрет инстанса)', () => {
    expect(getPaykeeperConfig({ ...BASE, CDEK_CRON_SECRET: 'shh' }).cronSecret).toBe('shh');
    expect(getPaykeeperConfig({ ...BASE }).cronSecret).toBeNull();
  });
});

describe('paykeeper/config — parseCsvStrings', () => {
  it('разбивает csv, тримит, отбрасывает пустые', () => {
    expect(parseCsvStrings(' a , b ,, c ')).toEqual(['a', 'b', 'c']);
    expect(parseCsvStrings(undefined)).toEqual([]);
    expect(parseCsvStrings('')).toEqual([]);
  });
});
