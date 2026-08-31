import { describe, expect, it } from 'vitest';

import {
  CONSENT_TEXTS,
  CONSENT_VERSION,
  ConsentInputSchema,
  PdConsentSchema,
  consentEntries,
} from '@/lib/consent/schemas';

/**
 * Согласия субъекта персональных данных (152-ФЗ).
 *
 * Проверяется не «галочка стоит», а правовые требования, которые уже стоили
 * боевому магазину нарушения (docs/32 §8-bis):
 *   • согласие на ПДн — ОТДЕЛЬНЫЙ элемент (ФЗ-156 от 24.06.2025);
 *   • обязательные согласия принимаются только явным true — сервером, а не
 *     браузером: галочка обходится прямым запросом к API;
 *   • отказ от рекламной рассылки НЕ мешает покупке (ст.16 ЗоЗПП, ст.18 ФЗ-38).
 */

describe('consent/schemas — обязательные согласия', () => {
  it('принимает заказ, когда даны ПДн и оферта', () => {
    const r = ConsentInputSchema.safeParse({ pd: true, offer: true });
    expect(r.success).toBe(true);
    expect(r.success && r.data.marketing).toBe(false);
  });

  it('без согласия на ПДн — отказ с понятным текстом', () => {
    const r = ConsentInputSchema.safeParse({ pd: false, offer: true });
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues[0]?.message).toMatch(/персональных данных/i);
  });

  it('без акцепта оферты — отказ', () => {
    expect(ConsentInputSchema.safeParse({ pd: true, offer: false }).success).toBe(false);
  });

  it('пропущенное согласие — тоже отказ, а не «по умолчанию согласен»', () => {
    expect(ConsentInputSchema.safeParse({}).success).toBe(false);
    expect(ConsentInputSchema.safeParse({ pd: true }).success).toBe(false);
  });

  it('строка «true» и единица не считаются согласием', () => {
    // Согласие должно быть явным. Любая приводимость типов здесь означала бы,
    // что случайное значение из формы засчиталось за волеизъявление.
    expect(ConsentInputSchema.safeParse({ pd: 'true', offer: true }).success).toBe(false);
    expect(ConsentInputSchema.safeParse({ pd: 1, offer: true }).success).toBe(false);
  });
});

describe('consent/schemas — рекламное согласие не блокирует покупку', () => {
  it('заказ проходит и без согласия на рекламу', () => {
    const r = ConsentInputSchema.safeParse({ pd: true, offer: true, marketing: false });
    expect(r.success).toBe(true);
  });

  it('согласие на рекламу принимается, когда дано', () => {
    const r = ConsentInputSchema.safeParse({ pd: true, offer: true, marketing: true });
    expect(r.success && r.data.marketing).toBe(true);
  });
});

describe('consent/schemas — журнал пишет только данные согласия', () => {
  it('без рекламы в журнал идут два вида', () => {
    expect(consentEntries({ pd: true, offer: true, marketing: false })).toEqual(['pd', 'offer']);
  });

  it('с рекламой — три', () => {
    expect(consentEntries({ pd: true, offer: true, marketing: true })).toEqual([
      'pd',
      'offer',
      'marketing',
    ]);
  });

  it('отказ от рекламы НЕ записывается: журнал фиксирует согласие, а не его отсутствие', () => {
    expect(consentEntries({ pd: true, offer: true, marketing: false })).not.toContain('marketing');
  });
});

describe('consent/schemas — формулировки', () => {
  it('текст есть для каждого вида согласия', () => {
    for (const purpose of ['pd', 'offer', 'marketing'] as const) {
      expect(CONSENT_TEXTS[purpose].length).toBeGreaterThan(20);
    }
  });

  it('согласие на ПДн не склеено с офертой — требование обособленности ФЗ-156', () => {
    expect(CONSENT_TEXTS.pd).not.toMatch(/оферт/i);
    expect(CONSENT_TEXTS.offer).not.toMatch(/персональных данных/i);
  });

  it('версия формулировок задана датой редакции', () => {
    expect(CONSENT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('формулировки нейтральны к нише: платформа обслуживает разные магазины', () => {
    const all = Object.values(CONSENT_TEXTS).join(' ').toLowerCase();
    for (const word of ['флешк', 'гравиров', 'гимнаст', 'одежд', 'обув']) {
      expect(all).not.toContain(word);
    }
  });
});

describe('consent/schemas — формы без продажи', () => {
  it('обратной связи достаточно согласия на ПДн', () => {
    expect(PdConsentSchema.safeParse(true).success).toBe(true);
  });

  it('без согласия форма обратной связи не отправляется', () => {
    expect(PdConsentSchema.safeParse(false).success).toBe(false);
  });
});
