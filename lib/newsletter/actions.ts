'use server';

import { defineAction, PublicActionError } from '@/lib/server/action';

import { unsubscribe } from './repository';
import { UnsubscribeSchema } from './schemas';

/**
 * Server Actions раздела «Подписчики» (устранение тупика владельца — аудит
 * dead-button: в разделе не было ни одного действия с собранными адресами).
 *
 * Единый пайплайн defineAction (docs/04 §4.7, ADR-002): guard (orders.write —
 * то же право, что и прочие изменения операционных данных; чтение раздела —
 * orders.read) → Zod → guarded UPDATE в БД → revalidatePath → audit_log.
 *
 * Экспорт адресов (CSV) — операция ЧТЕНИЯ, реализован отдельным GET-роутом
 * app/admin/(panel)/subscribers/export/route.ts под правом orders.read.
 */

/** Путь раздела для инвалидации списка после отписки. */
const SUBSCRIBERS_PATH = '/admin/subscribers';

/**
 * Отписать подписчика (status='unsubscribed'). Идемпотентно: повторная отписка
 * или несуществующий id (guarded UPDATE вернул 0 строк) → понятная доменная
 * ошибка (PublicActionError → validation + message), без записи в аудит.
 */
export const unsubscribeSubscriber = defineAction({
  permission: 'orders.write',
  input: UnsubscribeSchema,
  handler: async (data, _ctx) => {
    const row = await unsubscribe(data.id);
    if (!row) {
      throw new PublicActionError('Подписчик не найден или уже отписан.');
    }
    return {
      result: { id: row.id },
      revalidate: [SUBSCRIBERS_PATH],
      audit: {
        action: 'newsletter.unsubscribe',
        entityType: 'newsletter_subscriber',
        entityId: row.id,
        before: { status: 'active' },
        after: { status: 'unsubscribed' },
      },
    };
  },
});
