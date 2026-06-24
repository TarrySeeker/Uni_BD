import { describe, it, expect, afterEach, vi } from 'vitest';
import { redirectDueDate } from '@/lib/payments/tbank/service';

/**
 * Юнит-тесты redirectDueDate — формат поля Init.RedirectDueDate Т-Банка
 * (docs/15 §4.1). Т-API требует 'YYYY-MM-DDTHH:MM:SS+03:00' (МСК, БЕЗ
 * миллисекунд, БЕЗ суффикса 'Z'). До фикса возвращалась строка ISO
 * (.toISOString() → '...SS.mmmZ'), что Т-Банк отклонял по валидации формата.
 *
 * Время детерминировано через vi.setSystemTime; МСК-смещение фиксированное
 * +03:00 (РФ без перехода на летнее время с 2014 г.), не зависит от TZ сервера.
 */

const RE_TBANK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+\d{2}:\d{2}$/;

afterEach(() => {
  vi.useRealTimers();
});

describe('tbank/service — redirectDueDate', () => {
  it('возвращает строку формата Т-Банка YYYY-MM-DDTHH:MM:SS+03:00 (без мс, без Z)', () => {
    vi.useFakeTimers();
    // UTC-момент; +60 мин → 22:06:40 UTC = 01:06:40 МСК следующих суток.
    vi.setSystemTime(new Date('2026-06-17T21:06:40.544Z'));

    const out = redirectDueDate(60);

    expect(out).toMatch(RE_TBANK);
    expect(out).not.toMatch(/\.\d{3}/); // нет миллисекунд
    expect(out.endsWith('Z')).toBe(false); // нет 'Z'
    expect(out.endsWith('+03:00')).toBe(true); // явное смещение МСК
  });

  it('корректно отражает МСК-смещение: UTC + N минут переводится в стенные часы МСК', () => {
    vi.useFakeTimers();
    // 21:06:40 UTC + 60 мин = 22:06:40 UTC = 01:06:40 +03:00 (18 июня).
    vi.setSystemTime(new Date('2026-06-17T21:06:40.000Z'));

    expect(redirectDueDate(60)).toBe('2026-06-18T01:06:40+03:00');
  });

  it('смещение +03:00 не зависит от длительности окна (без мс при ненулевых секундах)', () => {
    vi.useFakeTimers();
    // 09:00:00 UTC + 15 мин = 09:15:00 UTC = 12:15:00 +03:00.
    vi.setSystemTime(new Date('2026-01-10T09:00:00.000Z'));

    expect(redirectDueDate(15)).toBe('2026-01-10T12:15:00+03:00');
  });

  it('РЕГРЕСС: текущая реализация на .toISOString() НЕ должна проходить (мс + Z)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-17T21:06:40.544Z'));

    const isoLike = new Date(Date.now() + 60 * 60_000).toISOString();
    expect(isoLike).toMatch(/\.\d{3}Z$/); // подтверждает несоответствие старого формата
    expect(redirectDueDate(60)).not.toBe(isoLike);
  });
});
