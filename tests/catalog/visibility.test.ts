import { describe, it, expect } from 'vitest';
import { isPubliclyVisible } from '@/lib/catalog/visibility';

describe('isPubliclyVisible — единый предикат видимости на витрине', () => {
  it('active → виден', () => {
    expect(isPubliclyVisible('active')).toBe(true);
  });

  it('draft/archived → не виден', () => {
    expect(isPubliclyVisible('draft')).toBe(false);
    expect(isPubliclyVisible('archived')).toBe(false);
  });

  it('остаток/цена НЕ влияют на видимость (по ним фильтра витрины нет)', () => {
    // Предикат принимает только статус — это и есть гарантия совпадения с
    // реальным фильтром Storefront API (status=active), без stock/price.
    expect(isPubliclyVisible('active')).toBe(true);
  });
});
