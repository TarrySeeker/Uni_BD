import type { ActionResult } from '@/lib/server/action';

/**
 * Человекочитаемое сообщение по коду отказа ActionResult (для UI заказов/промо).
 * Доменные ошибки модуля orders (недопустимый переход, нет остатка, дубликат
 * кода и т.п.) приходят в поле `message` из OrderError — показываем его как есть;
 * иначе — общий текст по коду пайплайна. fieldErrors показываются у полей формы.
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

/** Первая ошибка поля (или undefined) — для подписи под input. */
export function fieldError(
  result: Extract<ActionResult<unknown>, { ok: false }> | null,
  field: string,
): string | undefined {
  return result?.fieldErrors?.[field]?.[0];
}
