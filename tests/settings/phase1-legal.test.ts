import { describe, expect, it } from 'vitest';

import { legalEntitySchema } from '@/lib/settings/schemas';

/**
 * §9: offer_doc / email_designers в legal_entity (shop_settings — jsonb key/value,
 * без DDL). Аддитивные опц. поля; старые настройки без них остаются валидными.
 * rek_* (реквизиты) — уже покрыты name/inn/kpp/ogrn/legalAddress/bankDetails.
 */
describe('§9 settings — legal_entity (юнит)', () => {
  it('обратная совместимость: настройки без новых полей валидны', () => {
    expect(legalEntitySchema.safeParse({ name: 'ООО', inn: '7712345678' }).success).toBe(true);
    expect(legalEntitySchema.safeParse({}).success).toBe(true);
  });

  it('offerDocKey (ключ файла оферты) принимается', () => {
    const parsed = legalEntitySchema.safeParse({ offerDocKey: 'docs/offer.pdf' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.offerDocKey).toBe('docs/offer.pdf');
  });

  it('emailDesigners: валидный e-mail проходит, мусор — нет', () => {
    expect(legalEntitySchema.safeParse({ emailDesigners: 'd@shop.test' }).success).toBe(true);
    expect(legalEntitySchema.safeParse({ emailDesigners: 'not-an-email' }).success).toBe(false);
  });

  it('rek_* (реквизиты) по-прежнему валидируются строго', () => {
    expect(legalEntitySchema.safeParse({ inn: '123' }).success).toBe(false); // ИНН 10/12 цифр
    expect(legalEntitySchema.safeParse({ inn: '7712345678', kpp: '771201001' }).success).toBe(true);
  });
});
