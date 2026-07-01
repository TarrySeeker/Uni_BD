/**
 * Чистая логика исхода «печати накладной/ШК» в UI (находка #12).
 *
 * В MOCK-режиме СДЭК (боевые ключи не заданы — дефолт демо/нового магазина)
 * print_url = https://example.invalid/mock-waybill.pdf. TLD .invalid (RFC 2606)
 * никогда не резолвится, поэтому window.open открывал мёртвую вкладку, хотя UI
 * рапортовал «выполнено». Здесь — детерминированное решение: открывать ли URL и
 * какое сообщение показать владельцу. Боевую ветку (реальный URL) не трогаем.
 *
 * Чистая функция, тестируема без браузера/Next.
 */

/** Пояснение для mock-режима (почему вкладка с PDF не открывается). */
export const MOCK_LABEL_NOTICE =
  'MOCK-режим: реальная накладная появится в боевом режиме (с боевыми ключами СДЭК).';

export interface LabelOutcome {
  /** Открывать ли URL в новой вкладке (только боевой режим с готовым URL). */
  open: boolean;
  /** Сообщение для пользователя (success-блок). */
  message: string;
}

/**
 * Решает исход печати по флагу mock и наличию URL.
 *   - mock           → не открывать, пояснить про боевой режим;
 *   - боевой + URL   → открыть вкладку, «выполнено»;
 *   - боевой без URL → не открывать (нечего), «выполнено».
 */
export function resolveLabelOutcome(
  label: string,
  input: { isMock: boolean; url: string | null | undefined },
): LabelOutcome {
  if (input.isMock) {
    return { open: false, message: `${label}: ${MOCK_LABEL_NOTICE}` };
  }
  if (typeof input.url === 'string' && input.url.length > 0) {
    return { open: true, message: `${label}: выполнено.` };
  }
  return { open: false, message: `${label}: выполнено.` };
}
