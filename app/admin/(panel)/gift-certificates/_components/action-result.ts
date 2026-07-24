import type { ActionResult } from '@/lib/server/action';

/**
 * Человекочитаемое сообщение по коду отказа ActionResult (раздел «Сертификаты»).
 * Доменное сообщение (PublicActionError: дубликат кода / номинал только вверх /
 * не найден) приходит в result.message — оно приоритетно.
 */
export function errorMessage(
  result: Extract<ActionResult<unknown>, { ok: false }>,
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  if (result.message) return result.message;
  switch (result.error) {
    case 'unauthorized':
      return t('errors.action.unauthorized');
    case 'forbidden':
      return t('errors.action.forbidden', { permission: 'gift.write' });
    case 'validation':
      return t('errors.action.validation');
    case 'internal':
    default:
      return t('errors.action.internal');
  }
}

/** Ошибка конкретного поля формы (из fieldErrors). */
export function fieldError(
  result: Extract<ActionResult<unknown>, { ok: false }> | null,
  field: string,
): string | undefined {
  return result?.fieldErrors?.[field]?.[0];
}
