import { describe, expect, it } from 'vitest';

import {
  BulkSetProductStatusSchema,
  DuplicateProductSchema,
} from '@/lib/catalog/schemas';

const UUID = '11111111-1111-4111-8111-111111111111';
const UUID2 = '22222222-2222-4222-8222-222222222222';

// ЮНИТ: Zod-схемы массовых действий и дублирования — без БД, всегда зелёные.

describe('BulkSetProductStatusSchema', () => {
  it('валидный вход: непустой ids + статус из PRODUCT_STATUSES', () => {
    for (const status of ['draft', 'active', 'archived'] as const) {
      const res = BulkSetProductStatusSchema.safeParse({ ids: [UUID, UUID2], status });
      expect(res.success).toBe(true);
    }
  });

  it('пустой ids отклонён (min 1)', () => {
    expect(BulkSetProductStatusSchema.safeParse({ ids: [], status: 'active' }).success).toBe(false);
  });

  it('более 200 id отклонено (max 200)', () => {
    const ids = Array.from({ length: 201 }, () => UUID);
    expect(BulkSetProductStatusSchema.safeParse({ ids, status: 'active' }).success).toBe(false);
  });

  it('ровно 200 id допустимо (граница)', () => {
    const ids = Array.from({ length: 200 }, () => UUID);
    expect(BulkSetProductStatusSchema.safeParse({ ids, status: 'active' }).success).toBe(true);
  });

  it('неизвестный статус отклонён', () => {
    expect(BulkSetProductStatusSchema.safeParse({ ids: [UUID], status: 'published' }).success).toBe(false);
  });

  it('плохой uuid в ids отклонён', () => {
    expect(BulkSetProductStatusSchema.safeParse({ ids: ['not-a-uuid'], status: 'active' }).success).toBe(false);
  });

  it('отсутствие status отклонено', () => {
    expect(BulkSetProductStatusSchema.safeParse({ ids: [UUID] }).success).toBe(false);
  });
});

describe('DuplicateProductSchema', () => {
  it('валидный uuid', () => {
    expect(DuplicateProductSchema.safeParse({ id: UUID }).success).toBe(true);
  });

  it('плохой uuid отклонён', () => {
    expect(DuplicateProductSchema.safeParse({ id: 'x' }).success).toBe(false);
  });

  it('без id отклонено', () => {
    expect(DuplicateProductSchema.safeParse({}).success).toBe(false);
  });
});
