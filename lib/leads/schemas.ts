/**
 * Схема заявки с витрины (G-09). Валидируется на публичном Storefront API
 * (anti-tamper/anti-spam: ограничения длины). Поля — как в форме /contacts.
 */
import { z } from 'zod';

export const LeadInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  contact: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(5000),
});

export type LeadInput = z.infer<typeof LeadInputSchema>;
