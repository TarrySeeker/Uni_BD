import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, it, expect } from 'vitest';

/**
 * Минор №4 — в карточке сертификата печаталось СЛУЖЕБНОЕ значение статуса
 * ('depleted'), хотя подпись поля рядом локализована и есть готовый
 * GiftStatusBadge с локализованными подписями всех четырёх статусов.
 *
 * GUARD сторожит суть: сырого `cert.status` в разметке нет, вместо него —
 * общий компонент бейджа; подписи всех статусов есть в ru/en/fr.
 */

function src(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), 'utf8');
}

const FORM = src('app/admin/(panel)/gift-certificates/_components/GiftCertificateForm.tsx');
const BADGE = src('app/admin/(panel)/gift-certificates/_components/GiftStatusBadge.tsx');

const catalogs = {
  ru: JSON.parse(src('messages/ru.json')) as Record<string, unknown>,
  en: JSON.parse(src('messages/en.json')) as Record<string, unknown>,
  fr: JSON.parse(src('messages/fr.json')) as Record<string, unknown>,
};

function val(cat: Record<string, unknown>, dot: string): string {
  let o: unknown = cat;
  for (const k of dot.split('.')) o = o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined;
  return typeof o === 'string' ? o : '';
}

describe('минор №4 — статус в карточке сертификата локализован', () => {
  it('🔴 сырого служебного значения статуса в разметке нет', () => {
    // Антипаттерн — печать значения ТЕКСТОМ внутри узла разметки:
    // `<dd …>{cert!.status}</dd>`. Передача в компонент (`status={cert!.status}`)
    // законна: подпись там резолвится по каталогу.
    expect(FORM).not.toMatch(/>\s*\{cert!?\.status\}\s*</);
    expect(FORM).not.toMatch(/<dd[^>]*>\s*\{cert!?\.status\}/);
  });

  it('используется общий бейдж статуса, а не своя вторая копия подписей', () => {
    expect(FORM).toContain('GiftStatusStamp');
    expect(FORM).toMatch(/status=\{cert!?\.status\}/);
  });

  it('подпись поля рядом по-прежнему из каталога', () => {
    expect(FORM).toContain('giftCertificates.giftCertificateForm.summary.status');
  });
});

describe('минор №4 — подписи всех четырёх статусов есть во всех языках', () => {
  const KEYS = [
    'common.states.active',
    'giftCertificates.giftStatusBadge.depleted',
    'common.states.disabled',
    'giftCertificates.giftStatusBadge.expired',
  ] as const;

  it('бейдж знает все четыре статуса домена', () => {
    for (const s of ['active', 'depleted', 'disabled', 'expired']) {
      expect(BADGE).toContain(`${s}:`);
    }
  });

  it('ru/en/fr несут непустой текст для каждого статуса', () => {
    for (const key of KEYS) {
      for (const [loc, cat] of Object.entries(catalogs)) {
        expect(val(cat, key), `${loc}: ${key}`).not.toBe('');
      }
    }
  });

  it('🔴 en/fr не являются копией русского', () => {
    for (const key of KEYS) {
      const ru = val(catalogs.ru, key);
      expect(val(catalogs.en, key), `en:${key}`).not.toBe(ru);
      expect(val(catalogs.fr, key), `fr:${key}`).not.toBe(ru);
    }
  });
});
