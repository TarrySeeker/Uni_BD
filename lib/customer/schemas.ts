/**
 * Схемы входных данных личного кабинета.
 *
 * Это граница доверия: всё, что приходит от покупателя, проверяется здесь, а не
 * в бизнес-логике. Схемы чистые — тестируются без БД и сети.
 */

import { z } from 'zod';

import { CUSTOMER_PASSWORD_MIN, CUSTOMER_PASSWORD_MAX } from './constants';

/**
 * Адрес почты приводится к нижнему регистру.
 *
 * В базе колонка нечувствительна к регистру, но нормализуем и на входе: иначе
 * «Ivan@X» и «ivan@x» дали бы два разных ключа ограничения попыток, и лимит
 * обходился бы сменой регистра.
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Некорректный адрес электронной почты')
  .max(320);

/** Пароль при РЕГИСТРАЦИИ и смене: полные требования. */
export const passwordSchema = z
  .string()
  .min(CUSTOMER_PASSWORD_MIN, `Минимум ${CUSTOMER_PASSWORD_MIN} символов`)
  .max(CUSTOMER_PASSWORD_MAX);

/**
 * Пароль при ВХОДЕ: минимальная длина не навязывается.
 *
 * Аккаунт мог быть заведён по прежним правилам, а отказ «слишком короткий»
 * сообщил бы перебору, что таких паролей в системе не бывает. Верхняя граница
 * остаётся — она защищает не от пользователя, а от нагрузки на хеширование.
 */
const loginPasswordSchema = z.string().min(1).max(CUSTOMER_PASSWORD_MAX);

export const RegisterSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().max(200).optional().default(''),
  phone: z.string().trim().max(40).optional().default(''),
});
export type RegisterInput = z.infer<typeof RegisterSchema>;

export const LoginSchema = z.object({
  email: emailSchema,
  password: loginPasswordSchema,
});
export type LoginInput = z.infer<typeof LoginSchema>;

export const ProfileSchema = z.object({
  name: z.string().trim().max(200),
  phone: z.string().trim().max(40),
});
export type ProfileInput = z.infer<typeof ProfileSchema>;

/**
 * Смена пароля изнутри кабинета требует текущий пароль.
 *
 * Знания сессии недостаточно: иначе угнанная сессия позволяла бы сменить пароль
 * и запереть владельца снаружи собственного аккаунта.
 */
export const ChangePasswordSchema = z.object({
  currentPassword: loginPasswordSchema,
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>;

/** Запрос ссылки восстановления пароля. */
export const PasswordResetRequestSchema = z.object({
  email: emailSchema,
});
export type PasswordResetRequestInput = z.infer<typeof PasswordResetRequestSchema>;

/** Установка нового пароля по ссылке из письма. */
export const PasswordResetConfirmSchema = z.object({
  token: z.string().trim().min(1).max(200),
  newPassword: passwordSchema,
});
export type PasswordResetConfirmInput = z.infer<typeof PasswordResetConfirmSchema>;

/**
 * Адрес доставки.
 *
 * Коды доставки объявлены `nullish()` БЕЗ значения по умолчанию, и это важно:
 * «поле не пришло» (`undefined`) означает «не трогай», а `null` — «очисти».
 * Смешав их, частичное обновление затирало бы коды при любой правке города и
 * ломало уже выбранную цель доставки.
 */
export const AddressSchema = z.object({
  label: z.string().trim().max(80).optional().default(''),
  recipientName: z.string().trim().max(200).optional().default(''),
  phone: z.string().trim().max(40).optional().default(''),
  city: z.string().trim().max(160).optional().default(''),
  deliveryCityCode: z.string().trim().max(40).nullish(),
  addressLine: z.string().trim().max(400).optional().default(''),
  postalCode: z.string().trim().max(20).optional().default(''),
  pickupPointCode: z.string().trim().max(40).nullish(),
  isDefault: z.boolean().optional().default(false),
});
export type AddressInput = z.infer<typeof AddressSchema>;

/**
 * Избранное ключуется публичным slug товара.
 *
 * Внутренние идентификаторы наружу не отдаются вовсе (см. DTO каталога), поэтому
 * и приходить они не могут. Slug превращается в идентификатор на сервере.
 */
export const WishlistItemSchema = z.object({
  slug: z.string().trim().min(1).max(200),
});
export type WishlistItemInput = z.infer<typeof WishlistItemSchema>;

/**
 * Одноразовый токен из ссылки в письме (подтверждение адреса, сброс пароля).
 * Сам по себе является учётными данными, приходит из URL — то есть от
 * постороннего, поэтому длина ограничена.
 */
export const TokenSchema = z.object({
  token: z.string().trim().min(1).max(200),
});
export type TokenInput = z.infer<typeof TokenSchema>;
