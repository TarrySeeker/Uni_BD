/**
 * Схема подписки на рассылку (G-12). Валидируется на публичном Storefront API.
 */
import { z } from 'zod';

export const NewsletterInputSchema = z.object({
  email: z.string().trim().email().max(320),
});

export type NewsletterInput = z.infer<typeof NewsletterInputSchema>;
