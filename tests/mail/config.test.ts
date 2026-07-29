import { describe, it, expect } from 'vitest';

import {
  MAIL_DEFAULT_PORT,
  MAIL_DEFAULT_TIMEOUT_MS,
  MAIL_MAX_ATTEMPTS,
  isMailConfigured,
  mailDisabledReason,
  resolveMailConfig,
} from '@/lib/mail/config';

/**
 * Конфигурация почтового модуля читается ТОЛЬКО из env (секреты в БД не живут —
 * см. шапку lib/mail/config.ts). Ключевое поведение, которое сторожит этот файл:
 * НЕПОЛНАЯ конфигурация не бросает, а даёт выключенный модуль с причиной. Магазин
 * без SMTP обязан продолжать принимать заказы (мультитенантность: на стенде carre
 * почты нет вовсе).
 */

/** Минимальный «боевой» набор переменных. */
const FULL = {
  SMTP_HOST: 'smtp.example.test',
  SMTP_PORT: '587',
  SMTP_USER: 'shop@example.test',
  SMTP_PASSWORD: 'secret',
  MAIL_FROM: 'shop@example.test',
  MAIL_FROM_NAME: 'Магазин',
};

describe('mail/config — резолв конфигурации из env', () => {
  it('полный набор переменных → модуль включён', () => {
    const cfg = resolveMailConfig(FULL);
    expect(cfg.enabled).toBe(true);
    expect(cfg.host).toBe('smtp.example.test');
    expect(cfg.port).toBe(587);
    expect(cfg.user).toBe('shop@example.test');
    expect(cfg.password).toBe('secret');
    expect(cfg.from).toBe('shop@example.test');
    expect(cfg.fromName).toBe('Магазин');
    expect(isMailConfigured(cfg)).toBe(true);
    expect(mailDisabledReason(cfg)).toBeNull();
  });

  it('пустое окружение → модуль ВЫКЛЮЧЕН и НЕ бросает', () => {
    const cfg = resolveMailConfig({});
    expect(cfg.enabled).toBe(false);
    expect(isMailConfigured(cfg)).toBe(false);
    expect(mailDisabledReason(cfg)).toBe('smtp_not_configured');
  });

  it('нет SMTP_HOST → выключен (хост — единственная незаменимая переменная)', () => {
    const cfg = resolveMailConfig({ ...FULL, SMTP_HOST: '' });
    expect(cfg.enabled).toBe(false);
    expect(mailDisabledReason(cfg)).toBe('smtp_not_configured');
  });

  it('нет MAIL_FROM → выключен: письмо без отправителя отвергнет любой релей', () => {
    const cfg = resolveMailConfig({ ...FULL, MAIL_FROM: '' });
    expect(cfg.enabled).toBe(false);
    expect(mailDisabledReason(cfg)).toBe('from_not_configured');
  });

  it('MAIL_FROM без @ → выключен (мусор в env не должен уезжать в релей)', () => {
    const cfg = resolveMailConfig({ ...FULL, MAIL_FROM: 'не-адрес' });
    expect(cfg.enabled).toBe(false);
    expect(mailDisabledReason(cfg)).toBe('from_not_configured');
  });

  it('SMTP без логина/пароля допустим (открытый релей внутри периметра)', () => {
    const cfg = resolveMailConfig({
      SMTP_HOST: 'mailhog',
      MAIL_FROM: 'shop@example.test',
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.user).toBeNull();
    expect(cfg.password).toBeNull();
  });

  it('порт по умолчанию — 587 (submission), мусорный порт откатывается на дефолт', () => {
    expect(resolveMailConfig({ ...FULL, SMTP_PORT: '' }).port).toBe(MAIL_DEFAULT_PORT);
    expect(resolveMailConfig({ ...FULL, SMTP_PORT: 'abc' }).port).toBe(MAIL_DEFAULT_PORT);
    expect(resolveMailConfig({ ...FULL, SMTP_PORT: '0' }).port).toBe(MAIL_DEFAULT_PORT);
    expect(resolveMailConfig({ ...FULL, SMTP_PORT: '99999' }).port).toBe(MAIL_DEFAULT_PORT);
    expect(resolveMailConfig({ ...FULL, SMTP_PORT: '465' }).port).toBe(465);
  });

  it('SMTP_SECURE=true → неявный TLS; по умолчанию false (STARTTLS на 587)', () => {
    expect(resolveMailConfig(FULL).secure).toBe(false);
    expect(resolveMailConfig({ ...FULL, SMTP_SECURE: 'true' }).secure).toBe(true);
    expect(resolveMailConfig({ ...FULL, SMTP_SECURE: '1' }).secure).toBe(true);
    expect(resolveMailConfig({ ...FULL, SMTP_SECURE: 'false' }).secure).toBe(false);
  });

  it('порт 465 сам по себе НЕ включает secure — решает только SMTP_SECURE', () => {
    // Явность важнее догадок: некоторые релеи слушают STARTTLS и на 465.
    expect(resolveMailConfig({ ...FULL, SMTP_PORT: '465' }).secure).toBe(false);
  });

  it('таймаут по умолчанию задан и положителен (письмо не висит вечно)', () => {
    expect(resolveMailConfig(FULL).timeoutMs).toBe(MAIL_DEFAULT_TIMEOUT_MS);
    expect(MAIL_DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(resolveMailConfig({ ...FULL, MAIL_TIMEOUT_MS: '5000' }).timeoutMs).toBe(5000);
    expect(resolveMailConfig({ ...FULL, MAIL_TIMEOUT_MS: 'мусор' }).timeoutMs).toBe(
      MAIL_DEFAULT_TIMEOUT_MS,
    );
  });

  it('число попыток ограничено сверху (ретраи не должны молотить релей вечно)', () => {
    expect(MAIL_MAX_ATTEMPTS).toBeGreaterThanOrEqual(2);
    expect(MAIL_MAX_ATTEMPTS).toBeLessThanOrEqual(10);
  });

  it('имя отправителя не обязательно (адрес уедет без display-name)', () => {
    const cfg = resolveMailConfig({ ...FULL, MAIL_FROM_NAME: '' });
    expect(cfg.enabled).toBe(true);
    expect(cfg.fromName).toBeNull();
  });

  it('значения тримятся (типовая беда .env — хвостовой пробел)', () => {
    const cfg = resolveMailConfig({ ...FULL, SMTP_HOST: '  smtp.example.test  ' });
    expect(cfg.host).toBe('smtp.example.test');
  });
});
