import { describe, expect, it } from 'vitest';

import { canTransitionNews, nextNewsStatuses } from '@/lib/news/status';

/**
 * ЮНИТ (без БД): машина статусов новости (docs/24 §3).
 * draft → published|archived; published → draft|archived; archived → draft.
 */
describe('news/status — машина переходов', () => {
  it('draft → published/archived разрешены', () => {
    expect(canTransitionNews('draft', 'published')).toBe(true);
    expect(canTransitionNews('draft', 'archived')).toBe(true);
  });

  it('published → draft/archived разрешены (снятие/архив)', () => {
    expect(canTransitionNews('published', 'draft')).toBe(true);
    expect(canTransitionNews('published', 'archived')).toBe(true);
  });

  it('archived → draft разрешён (возврат в работу)', () => {
    expect(canTransitionNews('archived', 'draft')).toBe(true);
  });

  it('archived → published напрямую ЗАПРЕЩЁН', () => {
    expect(canTransitionNews('archived', 'published')).toBe(false);
  });

  it('переход в себя запрещён (нет X→X)', () => {
    expect(canTransitionNews('draft', 'draft')).toBe(false);
    expect(canTransitionNews('published', 'published')).toBe(false);
    expect(canTransitionNews('archived', 'archived')).toBe(false);
  });

  it('nextNewsStatuses перечисляет допустимые цели', () => {
    expect(nextNewsStatuses('draft')).toEqual(['published', 'archived']);
    expect(nextNewsStatuses('published')).toEqual(['draft', 'archived']);
    expect(nextNewsStatuses('archived')).toEqual(['draft']);
  });
});
