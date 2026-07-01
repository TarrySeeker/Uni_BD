import { describe, it, expect } from 'vitest';

import {
  SUBSCRIBER_STATUSES,
  SUBSCRIBER_STATUS_LABELS,
  isSubscriberStatus,
  subscriberStatusLabel,
} from '@/lib/newsletter/status';

/**
 * G-12 (подписчики): локализация статуса подписчика. Раньше колонка «Статус»
 * печатала сырой 'active'/'unsubscribed' в русскоязычной админке (находка #8).
 * Чистые функции, без БД/Next.
 */
describe('статусы подписчика', () => {
  it('набор статусов совпадает с CHECK в БД (active/unsubscribed)', () => {
    expect([...SUBSCRIBER_STATUSES].sort()).toEqual(['active', 'unsubscribed']);
  });

  it('каждому статусу задана русская подпись', () => {
    for (const s of SUBSCRIBER_STATUSES) {
      expect(SUBSCRIBER_STATUS_LABELS[s]).toBeTruthy();
    }
  });

  it('isSubscriberStatus распознаёт валидные и отвергает мусор', () => {
    expect(isSubscriberStatus('active')).toBe(true);
    expect(isSubscriberStatus('unsubscribed')).toBe(true);
    expect(isSubscriberStatus('bogus')).toBe(false);
    expect(isSubscriberStatus(123)).toBe(false);
    expect(isSubscriberStatus(null)).toBe(false);
  });

  it('subscriberStatusLabel даёт русскую подпись, фолбэк — сама строка', () => {
    expect(subscriberStatusLabel('active')).toBe('Активен');
    expect(subscriberStatusLabel('unsubscribed')).toBe('Отписан');
    expect(subscriberStatusLabel('weird')).toBe('weird');
  });
});
