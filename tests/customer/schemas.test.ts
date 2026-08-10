import { describe, it, expect } from 'vitest';

import {
  RegisterSchema,
  LoginSchema,
  ProfileSchema,
  ChangePasswordSchema,
  PasswordResetRequestSchema,
  PasswordResetConfirmSchema,
  AddressSchema,
  WishlistItemSchema,
  TokenSchema,
} from '@/lib/customer/schemas';
import { CUSTOMER_PASSWORD_MAX } from '@/lib/customer/constants';

/**
 * Валидация входа кабинета. Это граница доверия: всё, что приходит от
 * покупателя, проверяется здесь, а не в бизнес-логике.
 *
 * Схемы чистые — тестируются без БД и сети.
 */

describe('customer/schemas — email', () => {
  it('приводится к нижнему регистру: адрес не должен зависеть от регистра ввода', () => {
    // В базе email — citext, но нормализуем и на входе: иначе «Ivan@X» и
    // «ivan@x» дали бы два разных ключа лимита попыток.
    const r = RegisterSchema.parse({ email: '  IvAn@Example.COM ', password: 'longenough' });
    expect(r.email).toBe('ivan@example.com');
  });

  it('мусор вместо адреса отвергается', () => {
    expect(RegisterSchema.safeParse({ email: 'не-адрес', password: 'longenough' }).success).toBe(false);
  });
});

describe('customer/schemas — пароль', () => {
  it('слишком короткий пароль отвергается на регистрации', () => {
    expect(RegisterSchema.safeParse({ email: 'a@b.co', password: 'short' }).success).toBe(false);
  });

  it('чрезмерно длинный пароль отвергается — иначе это способ занять процессор', () => {
    // argon2 считает хеш от всего ввода: без верхней границы мегабайтный
    // «пароль» превращается в отказ в обслуживании одним запросом.
    const huge = 'x'.repeat(CUSTOMER_PASSWORD_MAX + 1);
    expect(RegisterSchema.safeParse({ email: 'a@b.co', password: huge }).success).toBe(false);
  });

  it('на ВХОДЕ минимальная длина не навязывается', () => {
    // Это данные существующего аккаунта: он мог быть заведён по прежним
    // правилам. Отвергнув короткий пароль здесь, мы бы сообщили «такого пароля
    // не бывает» — то есть подсказали бы перебору.
    expect(LoginSchema.safeParse({ email: 'a@b.co', password: 'x' }).success).toBe(true);
  });

  it('но и на входе длина ограничена сверху', () => {
    const huge = 'x'.repeat(CUSTOMER_PASSWORD_MAX + 1);
    expect(LoginSchema.safeParse({ email: 'a@b.co', password: huge }).success).toBe(false);
  });
});

describe('customer/schemas — смена и восстановление пароля', () => {
  it('смена пароля требует текущий — знания сессии недостаточно', () => {
    // Иначе угнанная сессия позволяла бы сменить пароль и запереть владельца.
    expect(ChangePasswordSchema.safeParse({ newPassword: 'longenough' }).success).toBe(false);
  });

  it('новый пароль при смене проходит те же требования, что и при регистрации', () => {
    expect(
      ChangePasswordSchema.safeParse({ currentPassword: 'whatever', newPassword: 'short' }).success,
    ).toBe(false);
  });

  it('запрос восстановления принимает только адрес', () => {
    const r = PasswordResetRequestSchema.parse({ email: 'A@B.CO' });
    expect(r.email).toBe('a@b.co');
  });

  it('подтверждение восстановления требует и токен, и новый пароль', () => {
    expect(PasswordResetConfirmSchema.safeParse({ token: 'abc' }).success).toBe(false);
    expect(
      PasswordResetConfirmSchema.safeParse({ token: 'abc', newPassword: 'longenough' }).success,
    ).toBe(true);
  });
});

describe('customer/schemas — адрес доставки', () => {
  it('пустой адрес допустим: покупатель заполняет книгу постепенно', () => {
    const r = AddressSchema.parse({});
    expect(r.isDefault).toBe(false);
    expect(r.city).toBe('');
  });

  it('коды доставки принимают null — магазин может работать без службы доставки', () => {
    const r = AddressSchema.parse({ deliveryCityCode: null, pickupPointCode: null });
    expect(r.deliveryCityCode).toBeNull();
    expect(r.pickupPointCode).toBeNull();
  });

  it('коды доставки МОЖНО не присылать вовсе — это отличается от null', () => {
    // Различие принципиально для частичного обновления: «поле не пришло»
    // означает «не трогай», а null — «очисти». Смешав их, форма редактирования
    // города затирала бы коды и ломала уже выбранную цель доставки.
    const r = AddressSchema.parse({ city: 'Город' });
    expect(r.deliveryCityCode).toBeUndefined();
    expect(r.pickupPointCode).toBeUndefined();
  });

  it('чрезмерно длинные значения отвергаются', () => {
    expect(AddressSchema.safeParse({ city: 'x'.repeat(1000) }).success).toBe(false);
  });
});

describe('customer/schemas — избранное и токены', () => {
  it('избранное ключуется публичным slug, а не внутренним идентификатором', () => {
    // Внутренние идентификаторы товаров наружу не отдаются вовсе.
    expect(WishlistItemSchema.safeParse({ slug: 'nabor-nozhej' }).success).toBe(true);
    expect(WishlistItemSchema.safeParse({ slug: '' }).success).toBe(false);
  });

  it('токен из ссылки ограничен по длине — он приходит из URL от постороннего', () => {
    expect(TokenSchema.safeParse({ token: 'a'.repeat(64) }).success).toBe(true);
    expect(TokenSchema.safeParse({ token: '' }).success).toBe(false);
    expect(TokenSchema.safeParse({ token: 'a'.repeat(5000) }).success).toBe(false);
  });
});

describe('customer/schemas — профиль', () => {
  it('имя и телефон обрезаются от пробелов', () => {
    const r = ProfileSchema.parse({ name: '  Иван  ', phone: ' +7 900 ' });
    expect(r.name).toBe('Иван');
    expect(r.phone).toBe('+7 900');
  });
});
