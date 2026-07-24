import type { ActionResult } from '@/lib/server/action';

/**
 * Человекочитаемое сообщение по коду отказа ActionResult (для раздела «Заявки»).
 * Образец cms/_components/action-result.ts. Доменное сообщение (PublicActionError:
 * недопустимый переход / заявка не найдена) приходит в result.message — оно
 * приоритетно.
 */
export function errorMessage(
  result: Extract<ActionResult<unknown>, { ok: false }>,
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  if (result.message) {
    return result.message;
  }
  switch (result.error) {
    case 'unauthorized':
      return t('errors.action.unauthorized');
    case 'forbidden':
      return t('errors.action.forbidden', { permission: 'orders.write' });
    case 'validation':
      return t('errors.action.validation');
    case 'internal':
    default:
      return t('errors.action.internal');
  }
}
