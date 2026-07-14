import type { ActionResult } from '@/lib/server/action';

/**
 * Человекочитаемое сообщение по коду отказа ActionResult (раздел «Отзывы»).
 * Образец leads/_components/action-result. Доменное сообщение (PublicActionError:
 * недопустимый переход) приходит в result.message — оно приоритетно.
 */
export function errorMessage(
  result: Extract<ActionResult<unknown>, { ok: false }>,
): string {
  if (result.message) {
    return result.message;
  }
  switch (result.error) {
    case 'unauthorized':
      return 'Требуется вход в систему.';
    case 'forbidden':
      return 'Недостаточно прав (требуется reviews.write).';
    case 'validation':
      return 'Проверьте корректность данных.';
    case 'internal':
    default:
      return 'Не удалось выполнить операцию. Попробуйте ещё раз.';
  }
}
