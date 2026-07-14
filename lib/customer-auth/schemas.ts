import { z } from 'zod';

/**
 * Zod-схемы контура customer-auth (docs/24 §6).
 *
 * Валидируют ФОРМУ ввода витрины. Бизнес-инварианты (email занят, токен разовый,
 * locale ∈ shop_settings.i18n.locales) проверяются сервисом/репозиторием — здесь
 * только синтаксис/длины. Пароль: 8..128 (нижняя граница OWASP; верхняя — щит от
 * argon2-DoS длинным вводом).
 */

/** Пароль покупателя: 8..128 символов. */
const passwordSchema = z
  .string()
  .min(8, 'Пароль не короче 8 символов.')
  .max(128, 'Пароль не длиннее 128 символов.');

/** Email: нормализуем к нижнему регистру и обрезаем пробелы (citext-совместимо). */
const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Некорректный email.')
  .max(254);

/** Необязательная предпочитаемая локаль (членство в наборе — проверяет сервис). */
const preferredLocaleSchema = z.string().trim().min(1).max(35).optional();

export const RegisterSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().max(200).optional(),
  preferredLocale: preferredLocaleSchema,
});
export type RegisterInput = z.infer<typeof RegisterSchema>;

export const LoginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});
export type LoginInput = z.infer<typeof LoginSchema>;

export const PasswordResetRequestSchema = z.object({
  email: emailSchema,
});
export type PasswordResetRequestInput = z.infer<typeof PasswordResetRequestSchema>;

export const PasswordResetConfirmSchema = z.object({
  token: z.string().trim().min(1).max(200),
  password: passwordSchema,
});
export type PasswordResetConfirmInput = z.infer<typeof PasswordResetConfirmSchema>;

export const EmailVerifyRequestSchema = z.object({
  email: emailSchema,
});
export type EmailVerifyRequestInput = z.infer<typeof EmailVerifyRequestSchema>;

export const EmailVerifyConfirmSchema = z.object({
  token: z.string().trim().min(1).max(200),
});
export type EmailVerifyConfirmInput = z.infer<typeof EmailVerifyConfirmSchema>;

export const ProfileUpdateSchema = z
  .object({
    name: z.string().trim().max(200).optional(),
    phone: z.string().trim().max(50).optional(),
    preferredLocale: preferredLocaleSchema,
  })
  .refine((v) => v.name !== undefined || v.phone !== undefined || v.preferredLocale !== undefined, {
    message: 'Нечего обновлять.',
  });
export type ProfileUpdateInput = z.infer<typeof ProfileUpdateSchema>;
