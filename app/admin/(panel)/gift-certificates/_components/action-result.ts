import type { ActionResult } from '@/lib/server/action';

/**
 * Человекочитаемое сообщение по коду отказа ActionResult (раздел «Сертификаты»).
 * Доменное сообщение (PublicActionError: дубликат кода / номинал только вверх /
 * не найден) приходит в result.message — оно приоритетно.
 */
export function errorMessage(result: Extract<ActionResult<unknown>, { ok: false }>): string {
  if (result.message) return result.message;
  switch (result.error) {
    case 'unauthorized':
      return 'Требуется вход в систему.';
    case 'forbidden':
      return 'Недостаточно прав (требуется gift.write).';
    case 'validation':
      return 'Проверьте корректность данных.';
    case 'internal':
    default:
      return 'Не удалось выполнить операцию. Попробуйте ещё раз.';
  }
}

/** Ошибка конкретного поля формы (из fieldErrors). */
export function fieldError(
  result: Extract<ActionResult<unknown>, { ok: false }> | null,
  field: string,
): string | undefined {
  return result?.fieldErrors?.[field]?.[0];
}
