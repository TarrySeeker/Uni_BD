import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Почтовый модуль: ИНЕРТНОСТЬ без настройки — главное свойство.
 *
 * Зачем такое поведение. Почта нужна не всем магазинам и почти никогда не
 * настроена в первый день: SMTP-креды владельцы отдают позже всего остального.
 * Если бы `sendMail` бросал, любой путь, где отправляется письмо (регистрация,
 * подтверждение адреса, восстановление пароля), падал бы целиком — и магазин
 * нельзя было бы даже развернуть до получения кредов.
 *
 * Обратная сторона у инертности опасная: на боевом магазине она означает
 * молчаливую поломку — всё «работает», а письма не доходят. Поэтому
 * `isMailerConfigured()` вынесена наружу и проверяется в «Готовности магазина»,
 * а сам факт неотправки пишется в лог, а не проглатывается.
 *
 * Тесты подменяют `lib/config/env`, чтобы не зависеть от реального окружения.
 */

const mockEnv = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock('@/lib/config/env', () => ({
  getEnv: () => mockEnv.value,
}));

const logWarn = vi.hoisted(() => vi.fn());
const logError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logger', () => ({
  logger: { warn: logWarn, error: logError, info: vi.fn(), debug: vi.fn() },
}));

import { sendMail, isMailerConfigured } from '@/lib/mailer';

const MESSAGE = { to: 'buyer@example.com', subject: 'Тема', text: 'Текст' };

beforeEach(() => {
  mockEnv.value = {};
  logWarn.mockClear();
  logError.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mailer — инертность без настройки', () => {
  it('SMTP не задан → isMailerConfigured() = false', () => {
    expect(isMailerConfigured()).toBe(false);
  });

  it('задан только хост без адреса отправителя → всё ещё не настроен', () => {
    // Письмо без From не примет ни один сервер — половина конфигурации
    // не считается конфигурацией.
    mockEnv.value = { SMTP_HOST: 'smtp.example' };
    expect(isMailerConfigured()).toBe(false);
  });

  it('задан только адрес отправителя без хоста → не настроен', () => {
    mockEnv.value = { MAIL_FROM: 'shop@example' };
    expect(isMailerConfigured()).toBe(false);
  });

  it('заданы хост и отправитель → настроен', () => {
    mockEnv.value = { SMTP_HOST: 'smtp.example', MAIL_FROM: 'shop@example' };
    expect(isMailerConfigured()).toBe(true);
  });

  it('sendMail без настройки НЕ бросает, а честно сообщает причину', () => {
    // Ключевое свойство: вызывающий код (регистрация, сброс пароля) продолжает
    // работать. Он сам решит, критична ли неотправка.
    return expect(sendMail(MESSAGE)).resolves.toEqual({
      sent: false,
      reason: 'not_configured',
    });
  });

  it('неотправка попадает в лог — иначе поломка была бы полностью молчаливой', async () => {
    await sendMail(MESSAGE);
    expect(logWarn).toHaveBeenCalled();
    // В записи должно быть видно, кому и что не ушло.
    const [, meta] = logWarn.mock.calls[0] as [string, Record<string, unknown>];
    expect(meta).toMatchObject({ to: MESSAGE.to, subject: MESSAGE.subject });
  });

  it('в логе неотправки нет тела письма — оно может содержать токен доступа', async () => {
    await sendMail({ ...MESSAGE, text: 'Ссылка: https://shop/verify?token=SECRET' });
    const [, meta] = logWarn.mock.calls[0] as [string, Record<string, unknown>];
    expect(JSON.stringify(meta)).not.toContain('SECRET');
  });
});

describe('mailer — SMTP настроен, но пакет отправки недоступен', () => {
  it('возвращает no_transport и пишет ошибку, а не падает', async () => {
    // nodemailer — опциональная зависимость: он грузится косвенно, чтобы сборка
    // не тянула его в бандл и не падала, когда пакет не установлен. Если SMTP
    // настроен, а пакета нет — это ошибка конфигурации сервера, и она обязана
    // быть громкой, но не ронять запрос покупателя.
    mockEnv.value = { SMTP_HOST: 'smtp.example', MAIL_FROM: 'shop@example' };

    const res = await sendMail(MESSAGE);

    // В окружении тестов nodemailer не установлен → ожидаем именно no_transport.
    // Если пакет появится в зависимостях, тест поймает смену поведения.
    expect(res.sent).toBe(false);
    expect(res.reason).toBe('no_transport');
    expect(logError).toHaveBeenCalled();
  });
});
