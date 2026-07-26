import { describe, it, expect } from 'vitest';

import { isUserFacingCdekCode, USER_FACING_CDEK_CODES } from '@/lib/cdek/user-facing';
import { CdekError } from '@/lib/cdek/errors';

/**
 * Находка аудита №32 (major): осмысленные отказы СДЭК («PDF ещё не готов —
 * повторите», «отмена посылки в пути запрещена — оформляйте возврат», «создание
 * уже выполняется другим процессом», «статус изменился во время отмены — нужна
 * ручная сверка») не входили в USER_FACING_CDEK_CODES, поэтому defineAction
 * сворачивал их в { ok:false, error:'internal' } и оператор видел безликое
 * «Не удалось выполнить операцию. Попробуйте ещё раз.» — совет заведомо вредный
 * (повтор не поможет никогда).
 */

describe('СДЭК: доменные отказы доходят до оператора', () => {
  const shouldBeUserFacing = [
    'cdek_precondition_failed',
    'cdek_missing_pvz',
    'cdek_invalid_phone',
    'cdek_no_shipment',
    'cdek_print_not_ready',
    'cdek_cancel_not_allowed',
    'cdek_cancel_raced',
    'cdek_create_in_progress',
    'module_disabled',
  ];

  it.each(shouldBeUserFacing)('%s показывается оператору', (code) => {
    expect(USER_FACING_CDEK_CODES.has(code)).toBe(true);
    expect(isUserFacingCdekCode(new CdekError(code, 'текст для оператора'))).toBe(true);
  });

  it('технические/сетевые коды остаются внутренними (детали — только в лог)', () => {
    expect(isUserFacingCdekCode(new CdekError('cdek_auth_failed', 'секрет'))).toBe(false);
    expect(isUserFacingCdekCode(new CdekError('cdek_network_error', 'ECONNRESET'))).toBe(false);
    expect(isUserFacingCdekCode(new Error('обычная ошибка'))).toBe(false);
  });
});
