import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Сервисный слой кабинета — здесь принимаются решения по безопасности.
 *
 * Всё, что ниже, защищает от трёх вещей:
 *   • узнать по ответу, есть ли в магазине клиент с таким адресом;
 *   • подобрать пароль перебором;
 *   • сохранить доступ после смены пароля.
 */

const repo = vi.hoisted(() => ({
  upsertRegister: vi.fn(),
  findAuthByEmail: vi.fn(),
  getAuthById: vi.fn(),
  setLastLogin: vi.fn(async () => {}),
  updatePasswordHash: vi.fn(async () => {}),
  createAuthToken: vi.fn(async () => {}),
  consumeAuthToken: vi.fn(),
  setEmailVerified: vi.fn(async () => {}),
  linkGuestOrdersByEmail: vi.fn(async () => 0),
}));
vi.mock('@/lib/customer/repository', () => repo);

const sessions = vi.hoisted(() => ({
  createCustomerSession: vi.fn(async () => ({ token: 'raw', expiresAt: new Date() })),
  invalidateCustomerSessions: vi.fn(async () => {}),
}));
vi.mock('@/lib/customer/session', () => sessions);

const mail = vi.hoisted(() => ({ sendMail: vi.fn(async () => ({ sent: true })) }));
vi.mock('@/lib/mailer', () => mail);

const rate = vi.hoisted(() => ({
  checkLoginRate: vi.fn(async () => ({ allowed: true, retryAfterSec: 0 })),
  registerLoginFailure: vi.fn(async () => {}),
  resetLoginFailures: vi.fn(async () => {}),
}));
vi.mock('@/lib/auth/rate-limit', () => rate);

const passwords = vi.hoisted(() => ({
  hashPassword: vi.fn(async () => 'phc-new'),
  verifyPassword: vi.fn(async () => true),
  verifyDummy: vi.fn(async () => false),
}));
vi.mock('@/lib/auth/password', () => passwords);

vi.mock('@/lib/config/settings', () => ({
  getEffectiveSettings: vi.fn(async () => ({
    branding: { shopName: 'Магазин' },
    seo: { site_url: 'https://shop.example' },
  })),
}));

import {
  registerCustomer,
  loginCustomer,
  changeCustomerPassword,
  requestPasswordReset,
  confirmPasswordReset,
} from '@/lib/customer/service';

const ACTIVE_ROW = {
  id: 'cust-1',
  email: 'buyer@example.com',
  name: 'Имя',
  phone: null,
  passwordHash: 'phc-stored',
  status: 'active' as const,
  emailVerified: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  rate.checkLoginRate.mockResolvedValue({ allowed: true, retryAfterSec: 0 });
  passwords.verifyPassword.mockResolvedValue(true);
  passwords.hashPassword.mockResolvedValue('phc-new');
  sessions.createCustomerSession.mockResolvedValue({ token: 'raw', expiresAt: new Date() });
});

describe('customer/service — регистрация', () => {
  it('успешная регистрация выдаёт сессию и НЕподтверждённый адрес', async () => {
    repo.upsertRegister.mockResolvedValue({ id: 'cust-1' });
    const res = await registerCustomer({
      email: 'buyer@example.com', password: 'longenough', name: 'Имя', phone: '',
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Подтверждение — отдельный шаг: пока его нет, чужие гостевые заказы не видны.
    expect(res.customer.emailVerified).toBe(false);
    expect(sessions.createCustomerSession).toHaveBeenCalled();
  });

  it('при регистрации выпускается токен подтверждения и уходит письмо', async () => {
    repo.upsertRegister.mockResolvedValue({ id: 'cust-1' });
    await registerCustomer({ email: 'b@e.co', password: 'longenough', name: '', phone: '' });

    expect(repo.createAuthToken).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'email_verify' }),
    );
    expect(mail.sendMail).toHaveBeenCalled();
  });

  it('гостевые заказы НЕ привязываются при регистрации', async () => {
    // Регистрация не доказывает владение адресом. Привязка — только после
    // перехода по ссылке из письма.
    repo.upsertRegister.mockResolvedValue({ id: 'cust-1' });
    await registerCustomer({ email: 'b@e.co', password: 'longenough', name: '', phone: '' });
    expect(repo.linkGuestOrdersByEmail).not.toHaveBeenCalled();
  });

  it('занятый адрес: отказ БЕЗ подсказки, что аккаунт существует', async () => {
    // Ответ «такой email уже зарегистрирован» — это готовая проверялка чужой
    // клиентской базы. Причина отказа наружу не выносится.
    repo.upsertRegister.mockResolvedValue(null);
    const res = await registerCustomer({
      email: 'taken@e.co', password: 'longenough', name: '', phone: '',
    });
    expect(res.ok).toBe(false);
  });

  it('письмо не уходит, если регистрация не состоялась', async () => {
    repo.upsertRegister.mockResolvedValue(null);
    await registerCustomer({ email: 'taken@e.co', password: 'longenough', name: '', phone: '' });
    expect(mail.sendMail).not.toHaveBeenCalled();
  });
});

describe('customer/service — вход', () => {
  it('верный пароль пускает и обновляет отметку входа', async () => {
    repo.findAuthByEmail.mockResolvedValue(ACTIVE_ROW);
    const res = await loginCustomer({ email: 'buyer@example.com', password: 'right' });

    expect(res.ok).toBe(true);
    expect(repo.setLastLogin).toHaveBeenCalledWith('cust-1');
  });

  it('несуществующий адрес всё равно проверяет «пароль» — иначе отказ выдаёт себя временем', async () => {
    // Без этого несуществующий адрес отвечал бы заметно быстрее, и перебор
    // определял бы наличие клиента по секундомеру.
    repo.findAuthByEmail.mockResolvedValue(null);
    const res = await loginCustomer({ email: 'nobody@e.co', password: 'x' });

    expect(res.ok).toBe(false);
    expect(passwords.verifyDummy).toHaveBeenCalled();
  });

  it('гостевая строка без пароля ведёт себя как несуществующий аккаунт', async () => {
    repo.findAuthByEmail.mockResolvedValue({ ...ACTIVE_ROW, passwordHash: null, status: 'guest' });
    const res = await loginCustomer({ email: 'guest@e.co', password: 'x' });

    expect(res.ok).toBe(false);
    expect(passwords.verifyDummy).toHaveBeenCalled();
  });

  it('заблокированный покупатель не входит даже с верным паролем', async () => {
    repo.findAuthByEmail.mockResolvedValue({ ...ACTIVE_ROW, status: 'disabled' });
    const res = await loginCustomer({ email: 'buyer@example.com', password: 'right' });
    expect(res.ok).toBe(false);
  });

  it('неверный пароль засчитывается в лимит попыток', async () => {
    repo.findAuthByEmail.mockResolvedValue(ACTIVE_ROW);
    passwords.verifyPassword.mockResolvedValue(false);
    await loginCustomer({ email: 'buyer@example.com', password: 'wrong' });
    expect(rate.registerLoginFailure).toHaveBeenCalled();
  });

  it('исчерпанный лимит отклоняет попытку ДО проверки пароля', async () => {
    rate.checkLoginRate.mockResolvedValue({ allowed: false, retryAfterSec: 60 });
    const res = await loginCustomer({ email: 'buyer@example.com', password: 'right' });

    expect(res.ok).toBe(false);
    expect(repo.findAuthByEmail).not.toHaveBeenCalled();
  });

  it('успешный вход обнуляет счётчик неудач', async () => {
    repo.findAuthByEmail.mockResolvedValue(ACTIVE_ROW);
    await loginCustomer({ email: 'buyer@example.com', password: 'right' });
    expect(rate.resetLoginFailures).toHaveBeenCalled();
  });
});

describe('customer/service — смена пароля изнутри кабинета', () => {
  it('требует верный текущий пароль', async () => {
    repo.getAuthById.mockResolvedValue(ACTIVE_ROW);
    passwords.verifyPassword.mockResolvedValue(false);

    const res = await changeCustomerPassword('cust-1', {
      currentPassword: 'wrong', newPassword: 'longenough',
    });
    expect(res.ok).toBe(false);
    expect(repo.updatePasswordHash).not.toHaveBeenCalled();
  });

  it('закрывает все прежние сессии и выдаёт новую текущему устройству', async () => {
    // Если пароль меняют из-за утечки, сессия злоумышленника не должна пережить
    // смену. Но и выкидывать самого инициатора незачем.
    repo.getAuthById.mockResolvedValue(ACTIVE_ROW);
    const res = await changeCustomerPassword('cust-1', {
      currentPassword: 'right', newPassword: 'longenough',
    });

    expect(res.ok).toBe(true);
    expect(sessions.invalidateCustomerSessions).toHaveBeenCalledWith('cust-1');
    expect(sessions.createCustomerSession).toHaveBeenCalled();
  });
});

describe('customer/service — восстановление пароля', () => {
  it('несуществующий адрес: ответ такой же, письма нет, токена нет', async () => {
    // Иначе форма восстановления сообщала бы, зарегистрирован ли адрес.
    repo.findAuthByEmail.mockResolvedValue(null);
    await expect(requestPasswordReset('nobody@e.co')).resolves.toBeUndefined();

    expect(repo.createAuthToken).not.toHaveBeenCalled();
    expect(mail.sendMail).not.toHaveBeenCalled();
  });

  it('существующий адрес: выпускается токен и уходит письмо', async () => {
    repo.findAuthByEmail.mockResolvedValue(ACTIVE_ROW);
    await requestPasswordReset('buyer@example.com');

    expect(repo.createAuthToken).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'password_reset' }),
    );
    expect(mail.sendMail).toHaveBeenCalled();
  });

  it('гостю без пароля восстанавливать нечего — токен не выпускается', async () => {
    repo.findAuthByEmail.mockResolvedValue({ ...ACTIVE_ROW, status: 'guest', passwordHash: null });
    await requestPasswordReset('guest@e.co');
    expect(repo.createAuthToken).not.toHaveBeenCalled();
  });

  it('негодный токен: пароль не меняется', async () => {
    repo.consumeAuthToken.mockResolvedValue(null);
    const res = await confirmPasswordReset('плохой-токен', 'longenough');

    expect(res.ok).toBe(false);
    expect(repo.updatePasswordHash).not.toHaveBeenCalled();
  });

  it('годный токен: пароль меняется и ВСЕ сессии закрываются', async () => {
    // Здесь новая сессия НЕ выдаётся: восстановление проходит человек, который
    // в кабинет ещё не вошёл — пусть войдёт новым паролем.
    repo.consumeAuthToken.mockResolvedValue({ customerId: 'cust-1' });
    const res = await confirmPasswordReset('годный', 'longenough');

    expect(res.ok).toBe(true);
    expect(repo.updatePasswordHash).toHaveBeenCalledWith('cust-1', 'phc-new');
    expect(sessions.invalidateCustomerSessions).toHaveBeenCalledWith('cust-1');
  });
});
