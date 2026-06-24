import { describe, it, expect } from 'vitest';
import {
  isCdekMock,
  getCdekConfig,
  parseCsvInts,
  parseCsvStrings,
  tariffForMode,
  CDEK_FALLBACK_DIMENSIONS,
} from '@/lib/cdek/config';

/**
 * Юнит-тесты конфигурации СДЭК (docs/08 §2, §13.2). Без БД/сети, всегда зелёные.
 * Передаём source-объект в getCdekConfig/isCdekMock, чтобы не мутировать process.env.
 */

describe('cdek/config — isCdekMock (ключевая mock-детекция)', () => {
  it('пустые ключи → mock=true', () => {
    expect(isCdekMock({ NODE_ENV: 'test' })).toBe(true);
  });

  it('только account без secret → mock=true', () => {
    expect(isCdekMock({ NODE_ENV: 'test', CDEK_ACCOUNT: 'acc' })).toBe(true);
  });

  it('только secret без account → mock=true', () => {
    expect(isCdekMock({ NODE_ENV: 'test', CDEK_SECRET: 'sec' })).toBe(true);
  });

  it('пустые строки ключей → mock=true', () => {
    expect(isCdekMock({ NODE_ENV: 'test', CDEK_ACCOUNT: '', CDEK_SECRET: '' })).toBe(true);
  });

  it('оба ключа заданы → mock=false', () => {
    expect(
      isCdekMock({ NODE_ENV: 'test', CDEK_ACCOUNT: 'acc', CDEK_SECRET: 'sec' }),
    ).toBe(false);
  });
});

describe('cdek/config — getCdekConfig (чтение env)', () => {
  it('дефолты при пустом окружении (mock-готово)', () => {
    const cfg = getCdekConfig({ NODE_ENV: 'test' });
    expect(cfg.baseUrl).toBe('https://api.cdek.ru');
    expect(cfg.account).toBeNull();
    expect(cfg.secret).toBeNull();
    expect(cfg.testMode).toBe(false);
    expect(cfg.fromLocationCode).toBe(44);
    expect(cfg.defaultTariffCode).toBe(136);
    expect(cfg.doorTariffCode).toBe(137); // M4: курьер ≠ ПВЗ-тариф
    expect(cfg.allowedTariffs).toEqual([]);
    expect(cfg.createEnabled).toBe(true);
    expect(cfg.webhookAllowedIps).toEqual([]);
  });

  it('дефолтные габариты — 500/30/20/10 (аналог cdek-dimensions.php)', () => {
    const cfg = getCdekConfig({ NODE_ENV: 'test' });
    expect(cfg.defaultDimensions).toEqual({
      weightG: 500,
      lengthCm: 30,
      widthCm: 20,
      heightCm: 10,
    });
    // Хардкод-фоллбэк совпадает с дефолтами env.
    expect(CDEK_FALLBACK_DIMENSIONS).toEqual(cfg.defaultDimensions);
  });

  it('переопределение габаритов и города из env', () => {
    const cfg = getCdekConfig({
      NODE_ENV: 'test',
      CDEK_FROM_LOCATION_CODE: '137',
      CDEK_DEFAULT_WEIGHT_G: '800',
      CDEK_DEFAULT_LENGTH_CM: '40',
      CDEK_DEFAULT_WIDTH_CM: '25',
      CDEK_DEFAULT_HEIGHT_CM: '15',
    });
    expect(cfg.fromLocationCode).toBe(137);
    expect(cfg.defaultDimensions).toEqual({
      weightG: 800,
      lengthCm: 40,
      widthCm: 25,
      heightCm: 15,
    });
  });

  it('CDEK_TEST_MODE coerce из строки', () => {
    expect(getCdekConfig({ NODE_ENV: 'test', CDEK_TEST_MODE: 'true' }).testMode).toBe(true);
    expect(getCdekConfig({ NODE_ENV: 'test', CDEK_TEST_MODE: '1' }).testMode).toBe(true);
    expect(getCdekConfig({ NODE_ENV: 'test', CDEK_TEST_MODE: 'false' }).testMode).toBe(false);
    expect(getCdekConfig({ NODE_ENV: 'test', CDEK_TEST_MODE: '0' }).testMode).toBe(false);
  });

  it('CDEK_CREATE_ENABLED kill-switch', () => {
    expect(getCdekConfig({ NODE_ENV: 'test', CDEK_CREATE_ENABLED: 'false' }).createEnabled).toBe(
      false,
    );
  });

  it('тестовый контур СДЭК (sandbox edu): edu-URL + тестовые ключи + testMode → НЕ mock', () => {
    const source = {
      NODE_ENV: 'test',
      CDEK_BASE_URL: 'https://api.edu.cdek.ru',
      CDEK_ACCOUNT: 'test-client-id',
      CDEK_SECRET: 'test-client-secret',
      CDEK_TEST_MODE: 'true',
    };
    // Ключи заданы → реальный клиент (не mock), OAuth/запросы идут на edu-контур.
    expect(isCdekMock(source)).toBe(false);
    const cfg = getCdekConfig(source);
    expect(cfg.baseUrl).toBe('https://api.edu.cdek.ru');
    expect(cfg.account).toBe('test-client-id');
    expect(cfg.secret).toBe('test-client-secret');
    expect(cfg.testMode).toBe(true);
    // В test-режиме пустой webhook IP-whitelist допустим (bypass с warn) —
    // здесь подтверждаем, что флаг прокинут в конфиг (используется webhook-роутом).
    expect(cfg.webhookAllowedIps).toEqual([]);
  });

  it('белый список тарифов из csv', () => {
    const cfg = getCdekConfig({ NODE_ENV: 'test', CDEK_ALLOWED_TARIFFS: '136, 137 ,233' });
    expect(cfg.allowedTariffs).toEqual([136, 137, 233]);
  });

  it('M4: doorTariffCode из CDEK_DOOR_TARIFF (override)', () => {
    const cfg = getCdekConfig({ NODE_ENV: 'test', CDEK_DOOR_TARIFF: '139', CDEK_DEFAULT_TARIFF: '136' });
    expect(cfg.defaultTariffCode).toBe(136);
    expect(cfg.doorTariffCode).toBe(139);
  });

  it('M4: tariffForMode — door→doorTariffCode, pvz/postamat/undefined→defaultTariffCode', () => {
    const cfg = getCdekConfig({ NODE_ENV: 'test' });
    expect(tariffForMode(cfg, 'door')).toBe(137);
    expect(tariffForMode(cfg, 'pvz')).toBe(136);
    expect(tariffForMode(cfg, 'postamat')).toBe(136);
    expect(tariffForMode(cfg, undefined)).toBe(136);
  });

  it('IP-whitelist webhook парсится из csv', () => {
    const cfg = getCdekConfig({
      NODE_ENV: 'test',
      CDEK_WEBHOOK_IPS: '212.69.96.0/24, 91.232.230.10 ',
    });
    expect(cfg.webhookAllowedIps).toEqual(['212.69.96.0/24', '91.232.230.10']);
  });

  it('отправитель из CDEK_SENDER_*', () => {
    const cfg = getCdekConfig({
      NODE_ENV: 'test',
      CDEK_SENDER_NAME: 'ООО Магазин',
      CDEK_SENDER_PHONE: '+79991234567',
      CDEK_SENDER_EMAIL: 'sender@example.com',
      CDEK_SENDER_INN: '7700000000',
    });
    expect(cfg.sender.name).toBe('ООО Магазин');
    expect(cfg.sender.phone).toBe('+79991234567');
    expect(cfg.sender.email).toBe('sender@example.com');
    expect(cfg.sender.inn).toBe('7700000000');
    expect(cfg.sender.contactName).toBeNull();
  });

  it('боевые ключи → account/secret заполнены, isCdekMock=false', () => {
    const src = { NODE_ENV: 'test', CDEK_ACCOUNT: 'acc', CDEK_SECRET: 'sec' };
    const cfg = getCdekConfig(src);
    expect(cfg.account).toBe('acc');
    expect(cfg.secret).toBe('sec');
    expect(isCdekMock(src)).toBe(false);
  });
});

describe('cdek/config — csv-парсеры', () => {
  it('parseCsvInts: пустые/нечисловые отбрасываются', () => {
    expect(parseCsvInts(undefined)).toEqual([]);
    expect(parseCsvInts('')).toEqual([]);
    expect(parseCsvInts('1, , 2,abc,3')).toEqual([1, 2, 3]);
  });

  it('parseCsvStrings: триммит и убирает пустые', () => {
    expect(parseCsvStrings(undefined)).toEqual([]);
    expect(parseCsvStrings(' a , b ,, c ')).toEqual(['a', 'b', 'c']);
  });
});
