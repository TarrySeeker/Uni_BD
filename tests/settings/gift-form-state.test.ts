import { describe, it, expect } from 'vitest';

import {
  giftFormStateFrom,
  buildGiftPayload,
  parseCategorySlugs,
} from '@/app/admin/(panel)/settings/gift/gift-form-state';
import { GIFT_SETTINGS_DEFAULTS, giftSettingsSchema } from '@/lib/settings/schemas';

/**
 * Чистая логика формы «Подарочные сертификаты» (тестов React-компонентов нет:
 * vitest env 'node'). Форма — тонкая обёртка над этими функциями.
 */

describe('gift-form-state — giftFormStateFrom', () => {
  it('пустой оверрайд → поля формы показывают дефолты платформы', () => {
    const s = giftFormStateFrom({});
    expect(s.autoIssue).toBe(true);
    expect(s.allowIssueOnGiftPaidOrder).toBe(true);
    // Бессрочно показываем пустым полем, а не нулём: «0 дней» читается как ошибка.
    expect(s.validDaysText).toBe('');
    expect(s.categorySlugsText).toBe('certificates');
  });

  it('сохранённые значения попадают в поля', () => {
    const s = giftFormStateFrom({
      autoIssue: false,
      validDays: 365,
      categorySlugs: ['podarki', 'sertifikaty'],
      allowIssueOnGiftPaidOrder: false,
    });
    expect(s).toEqual({
      autoIssue: false,
      validDaysText: '365',
      categorySlugsText: 'podarki, sertifikaty',
      allowIssueOnGiftPaidOrder: false,
    });
  });

  it('явно пустой список категорий не подменяется дефолтом', () => {
    expect(giftFormStateFrom({ categorySlugs: [] }).categorySlugsText).toBe('');
  });
});

describe('gift-form-state — parseCategorySlugs', () => {
  it('режет по запятым и переводам строк, тримит, убирает пустые', () => {
    expect(parseCategorySlugs(' certificates ,\n gift-cards ,,\n')).toEqual([
      'certificates',
      'gift-cards',
    ]);
  });

  it('дубликаты схлопываются', () => {
    expect(parseCategorySlugs('a, a, b')).toEqual(['a', 'b']);
  });

  it('пустая строка → пустой список (явный оверрайд «ни одна категория»)', () => {
    expect(parseCategorySlugs('   ')).toEqual([]);
  });
});

describe('gift-form-state — buildGiftPayload', () => {
  it('собирает payload, принимаемый схемой ключа gift', () => {
    const res = buildGiftPayload({
      autoIssue: true,
      validDaysText: '180',
      categorySlugsText: 'certificates',
      allowIssueOnGiftPaidOrder: false,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toEqual({
      gift: {
        autoIssue: true,
        validDays: 180,
        categorySlugs: ['certificates'],
        allowIssueOnGiftPaidOrder: false,
      },
    });
    expect(giftSettingsSchema.safeParse(res.value.gift).success).toBe(true);
  });

  it('пустой срок → 0 (бессрочный код)', () => {
    const res = buildGiftPayload({
      autoIssue: true,
      validDaysText: '  ',
      categorySlugsText: 'certificates',
      allowIssueOnGiftPaidOrder: true,
    });
    expect(res.ok && res.value.gift.validDays).toBe(0);
  });

  it('нечисловой/отрицательный/дробный срок → понятная ошибка, а не тихий 0', () => {
    for (const validDaysText of ['abc', '-5', '1.5', '1e3']) {
      const res = buildGiftPayload({
        autoIssue: true,
        validDaysText,
        categorySlugsText: 'certificates',
        allowIssueOnGiftPaidOrder: true,
      });
      expect(res.ok, `значение ${validDaysText}`).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/срок/i);
    }
  });

  it('результат всегда проходит giftSettingsSchema (контракт формы = контракт хранения)', () => {
    const res = buildGiftPayload(giftFormStateFrom({}));
    expect(res.ok).toBe(true);
    if (res.ok) {
      const parsed = giftSettingsSchema.safeParse(res.value.gift);
      expect(parsed.success).toBe(true);
      expect(res.value.gift.categorySlugs).toEqual(GIFT_SETTINGS_DEFAULTS.categorySlugs);
    }
  });
});
