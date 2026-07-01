import { describe, it, expect } from 'vitest';

/**
 * ЮНИТ-тест словаря меток источника заявки (C20) — чистая функция leadSourceLabel.
 * Образец — leadStatusLabel / auditActionLabel: маппинг известных + passthrough
 * неизвестных значений (без throw), чтобы не падать на будущих источниках.
 */

import { leadSourceLabel } from '@/lib/leads/schemas';

describe('leadSourceLabel', () => {
  it('contact_form → «Форма контактов»', () => {
    expect(leadSourceLabel('contact_form')).toBe('Форма контактов');
  });

  it('неизвестный источник → passthrough (возвращает саму строку, без throw)', () => {
    expect(leadSourceLabel('telegram_bot')).toBe('telegram_bot');
  });

  it('пустая строка не ломает (passthrough)', () => {
    expect(leadSourceLabel('')).toBe('');
  });
});
