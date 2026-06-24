import { describe, it, expect } from 'vitest';
import { escapeLike } from '@/lib/db/like';

describe('escapeLike — экранирование метасимволов ILIKE', () => {
  it('экранирует процент (иначе wildcard «любая последовательность»)', () => {
    expect(escapeLike('50%')).toBe('50\\%');
  });
  it('экранирует подчёркивание (иначе wildcard «любой символ»)', () => {
    expect(escapeLike('a_b')).toBe('a\\_b');
  });
  it('экранирует обратный слэш (escape-символ)', () => {
    expect(escapeLike('a\\b')).toBe('a\\\\b');
  });
  it('обычный текст не меняется', () => {
    expect(escapeLike('Халат белый')).toBe('Халат белый');
  });
  it('комбинация метасимволов', () => {
    expect(escapeLike('100%_\\')).toBe('100\\%\\_\\\\');
  });
});
