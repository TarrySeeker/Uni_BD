import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

import {
  LEAD_STATUSES,
  LEAD_STATUS_TRANSITIONS,
  isLeadStatus,
  leadStatusLabel,
  nextLeadStatuses,
  canLeadTransition,
} from '@/lib/leads/status';

// После i18n-переноса (волна 6-Б) значения мап — ключи; leadStatusLabel принимает
// переводчик. Строим t из ru.json — инвариант (читаемая русская подпись) сохранён.
const ru = JSON.parse(
  readFileSync(resolve(__dirname, '../../messages/ru.json'), 'utf8'),
) as Record<string, unknown>;
const t = (key: string): string => {
  let o: unknown = ru;
  for (const k of key.split('.'))
    o = o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined;
  return typeof o === 'string' ? o : key;
};

/**
 * G-09 (обработка заявок): чистая статус-машина заявок. Whitelist переходов —
 * единый источник истины для UI (кнопки) и сервера (валидация). Без БД/Next.
 */
describe('статус-машина заявок', () => {
  it('набор статусов совпадает с CHECK в БД (new/in_progress/done/spam)', () => {
    expect([...LEAD_STATUSES].sort()).toEqual(['done', 'in_progress', 'new', 'spam']);
  });

  it('таблица переходов покрывает все статусы и ссылается только на валидные', () => {
    for (const from of LEAD_STATUSES) {
      expect(LEAD_STATUS_TRANSITIONS[from]).toBeDefined();
      for (const to of LEAD_STATUS_TRANSITIONS[from]) {
        expect(LEAD_STATUSES).toContain(to);
        // X→X запрещён (нет «нулевого» перехода).
        expect(to).not.toBe(from);
      }
    }
  });

  it('canLeadTransition: ключевой путь new → in_progress → done разрешён', () => {
    expect(canLeadTransition('new', 'in_progress')).toBe(true);
    expect(canLeadTransition('in_progress', 'done')).toBe(true);
  });

  it('canLeadTransition: владелец может вернуть/переоткрыть заявку', () => {
    expect(canLeadTransition('in_progress', 'new')).toBe(true);
    expect(canLeadTransition('done', 'in_progress')).toBe(true);
    expect(canLeadTransition('spam', 'new')).toBe(true);
  });

  it('canLeadTransition: X→X запрещён', () => {
    for (const s of LEAD_STATUSES) {
      expect(canLeadTransition(s, s)).toBe(false);
    }
  });

  it('canLeadTransition: неизвестный статус → false (анти-tamper)', () => {
    expect(canLeadTransition('new', 'shipped')).toBe(false);
    expect(canLeadTransition('bogus', 'new')).toBe(false);
    expect(canLeadTransition('', '')).toBe(false);
  });

  it('nextLeadStatuses: из new — три перехода, без самого new', () => {
    const next = nextLeadStatuses('new');
    expect(next).toEqual(expect.arrayContaining(['in_progress', 'done', 'spam']));
    expect(next).not.toContain('new');
  });

  it('nextLeadStatuses: неизвестный статус → пустой список', () => {
    expect(nextLeadStatuses('bogus')).toEqual([]);
  });

  it('isLeadStatus распознаёт валидные и отвергает мусор', () => {
    expect(isLeadStatus('new')).toBe(true);
    expect(isLeadStatus('done')).toBe(true);
    expect(isLeadStatus('bogus')).toBe(false);
    expect(isLeadStatus(123)).toBe(false);
    expect(isLeadStatus(null)).toBe(false);
  });

  it('leadStatusLabel даёт человекочитаемую подпись, фолбэк — строка', () => {
    expect(leadStatusLabel('new', t)).toBe('Новая');
    expect(leadStatusLabel('in_progress', t)).toBe('В работе');
    expect(leadStatusLabel('done', t)).toBe('Обработана');
    expect(leadStatusLabel('spam', t)).toBe('В архиве');
    expect(leadStatusLabel('weird', t)).toBe('weird');
  });
});
