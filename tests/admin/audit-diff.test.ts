import { describe, it, expect } from 'vitest';

import { diffAuditData, type AuditDiffEntry } from '@/lib/admin/audit-diff';

/**
 * Тупик C0 (docs/20): поля before_data/after_data пишутся в audit_log, но в
 * журнале аудита не видны (нет диффа). diffAuditData — чистый, без БД/Next,
 * универсальный над произвольным JSON (мультитенантно, без привязки к магазину).
 *
 * Контракт: сравнение по объединению ключей; равные значения (deep-equal по JSON)
 * отбрасываются; before=null → 'added' (from=undefined); after=null → 'removed'
 * (to=undefined).
 */

function byKey(rows: AuditDiffEntry[], key: string): AuditDiffEntry | undefined {
  return rows.find((r) => r.key === key);
}

describe('diffAuditData — дифф снимков аудита', () => {
  it('(a) изменённые поля → kind "changed" с верными from/to', () => {
    const rows = diffAuditData(
      { price: 100, status: 'draft' },
      { price: 200, status: 'active' },
    );
    expect(rows).toHaveLength(2);

    const price = byKey(rows, 'price');
    expect(price).toEqual({ key: 'price', from: 100, to: 200, kind: 'changed' });

    const status = byKey(rows, 'status');
    expect(status).toEqual({ key: 'status', from: 'draft', to: 'active', kind: 'changed' });
  });

  it('(b) create (before=null) → kind "added", from=undefined', () => {
    const rows = diffAuditData(null, { price: 100 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ key: 'price', from: undefined, to: 100, kind: 'added' });
  });

  it('(c) delete (after=null) → kind "removed", to=undefined', () => {
    const rows = diffAuditData({ price: 100 }, null);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ key: 'price', from: 100, to: undefined, kind: 'removed' });
  });

  it('(d) неизменённые ключи исключаются; вложенные объекты сравниваются по значению', () => {
    const rows = diffAuditData(
      { price: 100, meta: { a: 1, b: 2 }, title: 'x' },
      { price: 100, meta: { a: 1, b: 2 }, title: 'y' },
    );
    // price и meta равны по значению → отброшены; меняется только title.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ key: 'title', from: 'x', to: 'y', kind: 'changed' });
  });

  it('вложенный объект, изменённый по значению, → "changed"', () => {
    const rows = diffAuditData({ meta: { a: 1 } }, { meta: { a: 2 } });
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('changed');
    expect(rows[0].key).toBe('meta');
  });

  it('ключ только в after → "added"; ключ только в before → "removed"', () => {
    const rows = diffAuditData({ a: 1 }, { b: 2 });
    expect(byKey(rows, 'b')).toEqual({ key: 'b', from: undefined, to: 2, kind: 'added' });
    expect(byKey(rows, 'a')).toEqual({ key: 'a', from: 1, to: undefined, kind: 'removed' });
  });

  it('оба null → пустой массив', () => {
    expect(diffAuditData(null, null)).toEqual([]);
  });

  it('порядок результата детерминирован (ключи по алфавиту)', () => {
    const rows = diffAuditData({ b: 1, a: 1 }, { b: 2, a: 2 });
    expect(rows.map((r) => r.key)).toEqual(['a', 'b']);
  });
});
