import type { ActionResult } from '@/lib/server/action';

/**
 * Человекочитаемое сообщение по коду отказа ActionResult (формы пользователей/
 * ролей). Если handler вернул публичное сообщение (PublicActionError → message)
 * — показываем его как есть; иначе — обобщённый текст по коду ошибки.
 * fieldErrors показываются у полей, общая ошибка — этим сообщением.
 */
export function errorMessage(result: Extract<ActionResult<unknown>, { ok: false }>): string {
  if (result.message) {
    return result.message;
  }
  switch (result.error) {
    case 'unauthorized':
      return 'Требуется вход в систему.';
    case 'forbidden':
      return 'Недостаточно прав для этого действия.';
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
