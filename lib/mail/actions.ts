'use server';

import { z } from 'zod';

import { defineAction, PublicActionError } from '@/lib/server/action';

import { getMailLogById, markMailRetried } from './repository';
import { resendMailById } from './resend';

/**
 * Server Actions раздела «Письма».
 *
 * Единый пайплайн defineAction (docs/04 §4.7, ADR-002): guard (orders.write — то
 * же право, что и прочие изменения операционных данных; чтение раздела —
 * orders.read) → Zod → доменное действие → revalidatePath → audit_log.
 *
 * 🔴 ПОЧЕМУ ПЕРЕСЫЛКА — ПОД ПРАВОМ ЗАПИСИ, ХОТЯ «ничего не меняет».
 * Она отправляет ДЕНЬГИ: письмо с кодом подарочного сертификата на предъявителя.
 * Оператор с правом только на чтение не должен уметь выслать этот код себе или
 * третьему лицу. По той же причине действие пишется в аудит — «кто и когда
 * переслал» обязано быть восстановимо.
 *
 * 🔴 ЧТО ВОЗВРАЩАЕТСЯ НАРУЖУ: только id письма и итоговый статус. Ни тела, ни
 * кода, ни темы с подставленными данными — вызов идёт из браузера оператора.
 */

/** Путь раздела для инвалидации списка после пересылки. */
const MAIL_PATH = '/admin/mail';

/** Вход: идентификатор строки журнала. */
const ResendMailSchema = z.object({
  id: z.string().uuid('errors.mail.invalidId'),
});

/**
 * Повторно отправить письмо по записи журнала.
 *
 * Письмо ПЕРЕСОБИРАЕТСЯ из заказа (в журнале тела нет — см. lib/mail/resend.ts),
 * поэтому пересылать можно только письма, привязанные к заказу. Запись без
 * заказа даёт понятную доменную ошибку, а не пустое письмо покупателю.
 */
export const resendMail = defineAction({
  permission: 'orders.write',
  input: ResendMailSchema,
  handler: async (data, _ctx) => {
    const entry = await getMailLogById(data.id);
    if (!entry) {
      throw new PublicActionError('errors.mail.entryNotFound');
    }
    if (!entry.orderId) {
      // Пересобрать не из чего: письмо не относится к заказу.
      throw new PublicActionError('errors.mail.resendRequiresOrder');
    }

    const result = await resendMailById(data.id);

    // Снимаем исходную запись с очереди досылки: по ней уже сделана новая
    // попытка со своей строкой журнала. Без этого крон продолжал бы слать по ней
    // письмо каждые 20 минут (та же авария, что описана в markMailRetried).
    // Ошибку глотаем: пересылка уже состоялась, и откатывать её нечем.
    try {
      await markMailRetried(data.id);
    } catch {
      // Наблюдаемость, а не деньги: следующий тик крона просто повторит попытку.
    }

    return {
      result: { id: data.id, status: result.status },
      revalidate: [MAIL_PATH],
      audit: {
        action: 'mail.resend',
        entityType: 'mail_log',
        entityId: data.id,
        // В аудит идут МЕТАДАННЫЕ отправки. Адресат — уже известный админке
        // факт (он в той же строке журнала), а тела письма нет нигде.
        before: { status: entry.status },
        after: { status: result.status, template: entry.template },
      },
    };
  },
});
