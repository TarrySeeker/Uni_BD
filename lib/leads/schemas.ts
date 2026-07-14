/**
 * Схемы заявок (G-09).
 *
 * - LeadInputSchema — приём заявки с витрины (anti-tamper/anti-spam: ограничения
 *   длины). Поля — как в форме /contacts.
 * - LeadStatusInputSchema / LeadIdInputSchema — вход админских мутаций (смена
 *   статуса / удаление). Валидируются внутри Server Action (defineAction).
 */
import { z } from 'zod';

import { LEAD_STATUSES } from './status';

export const LeadInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  contact: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(5000),
  // Доп. поля формы (§9, ← b_os_feedback) — опциональны, старая форма их не шлёт.
  // Пустая строка допустима (min не задан), нормализуется в null роутом.
  company: z.string().trim().max(200).optional(),
  city: z.string().trim().max(200).optional(),
  subject: z.string().trim().max(300).optional(),
});

export type LeadInput = z.infer<typeof LeadInputSchema>;

/** Вход ответа оператора на заявку (§9): id заявки + текст ответа (пустой → снять). */
export const LeadAnswerInputSchema = z.object({
  id: z.uuid(),
  answer: z.string().trim().max(5000),
});

export type LeadAnswerInput = z.infer<typeof LeadAnswerInputSchema>;

/** Вход смены статуса заявки: id заявки + целевой статус (из whitelist). */
export const LeadStatusInputSchema = z.object({
  id: z.uuid(),
  status: z.enum(LEAD_STATUSES),
});

export type LeadStatusInput = z.infer<typeof LeadStatusInputSchema>;

/** Вход действия по одной заявке (удаление). */
export const LeadIdInputSchema = z.object({
  id: z.uuid(),
});

export type LeadIdInput = z.infer<typeof LeadIdInputSchema>;

/**
 * Человекочитаемые подписи источника заявки (C20). Образец — leadStatusLabel /
 * auditActionLabel: маппинг известных значений + passthrough неизвестных, чтобы
 * не падать на будущих источниках (telegram_bot, whatsapp и т.п.). Источник
 * пишется в leads.source (DEFAULT 'contact_form').
 */
export const LEAD_SOURCE_LABELS: Readonly<Record<string, string>> = {
  contact_form: 'Форма контактов',
  // §9: обратный звонок (← b_os_call). CHECK на leads.source нет — значение
  // добавляется без миграции; ETL заказов проставит его в Фазе 3.
  callback: 'Обратный звонок',
};

/** Подпись источника заявки (фолбэк — сама строка, если источник неизвестен). */
export function leadSourceLabel(source: string): string {
  return LEAD_SOURCE_LABELS[source] ?? source;
}
