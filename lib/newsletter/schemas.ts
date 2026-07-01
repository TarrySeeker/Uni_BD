/**
 * Схема подписки на рассылку (G-12). Валидируется на публичном Storefront API.
 */
import { z } from 'zod';

export const NewsletterInputSchema = z.object({
  email: z.string().trim().email().max(320),
});

export type NewsletterInput = z.infer<typeof NewsletterInputSchema>;

/**
 * Вход админ-действия «Отписать» (раздел «Подписчики»). Только id подписчика —
 * целевой статус ('unsubscribed') не приходит от клиента (анти-tamper), он
 * фиксирован в repository.unsubscribe.
 */
export const UnsubscribeSchema = z.object({
  id: z.string().uuid(),
});

export type UnsubscribeInput = z.infer<typeof UnsubscribeSchema>;
