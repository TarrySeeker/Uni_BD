import type { ActionResult } from '@/lib/server/action';

/**
 * Человекочитаемое сообщение по коду отказа ActionResult (для UI заказов/промо).
 * Доменные ошибки модуля orders (недопустимый переход, нет остатка, дубликат
 * кода и т.п.) приходят в поле `message` из OrderError — показываем его как есть;
 * иначе — общий текст по коду пайплайна. fieldErrors показываются у полей формы.
 */
export function errorMessage(result: Extract<ActionResult<unknown>, { ok: false }>): string {
  if (result.message) {
    return result.message;
  }
  switch (result.error) {
    case 'unauthorized':
      return 'Требуется вход в систему.';
    case 'forbidden':
      return 'Недостаточно прав (требуется orders.write).';
    case 'validation':
      return 'Проверьте корректность полей формы.';
    case 'internal':
    default:
      return 'Не удалось выполнить операцию. Попробуйте ещё раз.';
  }
}

/** Первая ошибка поля (или undefined) — для подписи под input. */
export function fieldError(
  result: Extract<ActionResult<unknown>, { ok: false }> | null,
  field: string,
): string | undefined {
  return result?.fieldErrors?.[field]?.[0];
}
