import { describe, expect, it, vi } from 'vitest';

import { defineAction, type ActionDeps } from '@/lib/server/action';
import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';
import {
  ProductCreateSchema,
  ProductIdSchema,
  VariantReorderSchema,
  AttributeValueDeleteSchema,
} from '@/lib/catalog/schemas';

// ЮНИТ: проверяем, что мутации каталога, собранные через defineAction с реальными
// Zod-схемами каталога, корректно проходят guard (catalog.write) и валидацию —
// БЕЗ БД и Next (handler замокан, deps инъецированы). Это проверяет, что наши
// схемы совместимы с пайплайном ядра и что guard опирается на нужное право.

function makeUser(perms: PermissionCode[], isOwner = false): AuthUser {
  return {
    id: 'u-1',
    email: 'u@shop.io',
    isOwner,
    permissions: new Set<PermissionCode>(perms),
  };
}

function makeDeps(user: AuthUser | null): ActionDeps {
  return {
    getCurrentUser: vi.fn(async () => user),
    writeAudit: vi.fn(async () => {}),
    revalidate: vi.fn(async () => {}),
    getRequestMeta: vi.fn(async () => ({ ip: '127.0.0.1', userAgent: 'vitest' })),
  };
}

// Сборка createProduct-подобного действия с тем же permission/schema, но
// замоканным handler — изолируем guard+валидацию от БД.
function buildProductAction(deps: ActionDeps, handler = vi.fn(async () => ({ result: { id: 'new' } }))) {
  return {
    action: defineAction({
      permission: 'catalog.write',
      input: ProductCreateSchema,
      handler,
      deps,
    }),
    handler,
  };
}

const validInput = { sku: 'SKU-1', slug: 'product-1', name: 'Товар' };

describe('каталог через defineAction — guard catalog.write', () => {
  it('не аутентифицирован → unauthorized, handler не вызван', async () => {
    const deps = makeDeps(null);
    const { action, handler } = buildProductAction(deps);
    const res = await action(validInput);
    expect(res).toEqual({ ok: false, error: 'unauthorized' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('есть только catalog.read → forbidden', async () => {
    const deps = makeDeps(makeUser(['catalog.read']));
    const { action, handler } = buildProductAction(deps);
    const res = await action(validInput);
    expect(res).toEqual({ ok: false, error: 'forbidden' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('catalog.write → проходит guard, handler вызван', async () => {
    const deps = makeDeps(makeUser(['catalog.write']));
    const { action, handler } = buildProductAction(deps);
    const res = await action(validInput);
    expect(res.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('owner проходит без явного права', async () => {
    const deps = makeDeps(makeUser([], true));
    const { action, handler } = buildProductAction(deps);
    const res = await action(validInput);
    expect(res.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('невалидный вход (отрицательная цена) → validation, handler не вызван', async () => {
    const deps = makeDeps(makeUser(['catalog.write']));
    const { action, handler } = buildProductAction(deps);
    const res = await action({ ...validInput, basePrice: '-10' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(handler).not.toHaveBeenCalled();
  });

  it('успех с audit/revalidate прокидывается пайплайном', async () => {
    const deps = makeDeps(makeUser(['catalog.write']));
    const handler = vi.fn(async () => ({
      result: { id: 'p-1' },
      revalidate: ['/admin/catalog'],
      audit: { action: 'catalog.product.create', entityType: 'product', entityId: 'p-1' },
    }));
    const action = defineAction({
      permission: 'catalog.write',
      input: ProductCreateSchema,
      handler,
      deps,
    });
    const res = await action(validInput);
    expect(res).toEqual({ ok: true, data: { id: 'p-1' } });
    expect(deps.revalidate).toHaveBeenCalledWith('/admin/catalog');
    expect(deps.writeAudit).toHaveBeenCalledTimes(1);
  });
});

// Полное удаление товара (Prevki «нет возможности удалить товар»): guard
// catalog.write + ProductIdSchema (id обязателен и должен быть uuid). Сам DELETE
// с каскадом — интеграционно (БД), здесь — пайплайн guard/валидации без БД.
describe('deleteProduct через defineAction — guard + ProductIdSchema', () => {
  function buildDeleteAction(deps: ActionDeps, handler = vi.fn(async () => ({ result: { id: 'p-1' } }))) {
    return {
      action: defineAction({ permission: 'catalog.write', input: ProductIdSchema, handler, deps }),
      handler,
    };
  }
  const validId = { id: '123e4567-e89b-42d3-a456-426614174000' };

  it('только catalog.read → forbidden, handler не вызван', async () => {
    const deps = makeDeps(makeUser(['catalog.read']));
    const { action, handler } = buildDeleteAction(deps);
    const res = await action(validId);
    expect(res).toEqual({ ok: false, error: 'forbidden' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('catalog.write + валидный uuid → проходит, handler вызван', async () => {
    const deps = makeDeps(makeUser(['catalog.write']));
    const { action, handler } = buildDeleteAction(deps);
    const res = await action(validId);
    expect(res.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('невалидный id (не uuid) → validation, handler не вызван', async () => {
    const deps = makeDeps(makeUser(['catalog.write']));
    const { action, handler } = buildDeleteAction(deps);
    const res = await action({ id: 'not-a-uuid' });
    expect(res.ok).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});

// C12 — reorderVariant: guard catalog.write + VariantReorderSchema (productId uuid,
// order — непустой массив uuid). Round-trip SQL — в variant-attribute-mutations.test.ts.
describe('reorderVariant через defineAction — guard + VariantReorderSchema', () => {
  function buildReorderAction(deps: ActionDeps, handler = vi.fn(async () => ({ result: { productId: 'p-1' } }))) {
    return {
      action: defineAction({ permission: 'catalog.write', input: VariantReorderSchema, handler, deps }),
      handler,
    };
  }
  const validInput = {
    productId: '123e4567-e89b-42d3-a456-426614174000',
    order: ['223e4567-e89b-42d3-a456-426614174000'],
  };

  it('только catalog.read → forbidden, handler не вызван', async () => {
    const deps = makeDeps(makeUser(['catalog.read']));
    const { action, handler } = buildReorderAction(deps);
    const res = await action(validInput);
    expect(res).toEqual({ ok: false, error: 'forbidden' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('catalog.write + валидный вход → проходит, handler вызван', async () => {
    const deps = makeDeps(makeUser(['catalog.write']));
    const { action, handler } = buildReorderAction(deps);
    const res = await action(validInput);
    expect(res.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('пустой order → validation, handler не вызван', async () => {
    const deps = makeDeps(makeUser(['catalog.write']));
    const { action, handler } = buildReorderAction(deps);
    const res = await action({ productId: validInput.productId, order: [] });
    expect(res.ok).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});

// C14 — deleteAttributeValue: guard catalog.write + AttributeValueDeleteSchema.
// Поведение хендлера (conflict при использовании / DELETE) — в
// variant-attribute-mutations.test.ts.
describe('deleteAttributeValue через defineAction — guard + AttributeValueDeleteSchema', () => {
  function buildAction(deps: ActionDeps, handler = vi.fn(async () => ({ result: { id: 'av-1' } }))) {
    return {
      action: defineAction({ permission: 'catalog.write', input: AttributeValueDeleteSchema, handler, deps }),
      handler,
    };
  }
  const validId = { id: '123e4567-e89b-42d3-a456-426614174000' };

  it('только catalog.read → forbidden, handler не вызван', async () => {
    const deps = makeDeps(makeUser(['catalog.read']));
    const { action, handler } = buildAction(deps);
    const res = await action(validId);
    expect(res).toEqual({ ok: false, error: 'forbidden' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('catalog.write + валидный uuid → проходит, handler вызван', async () => {
    const deps = makeDeps(makeUser(['catalog.write']));
    const { action, handler } = buildAction(deps);
    const res = await action(validId);
    expect(res.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('невалидный id → validation, handler не вызван', async () => {
    const deps = makeDeps(makeUser(['catalog.write']));
    const { action, handler } = buildAction(deps);
    const res = await action({ id: 'not-a-uuid' });
    expect(res.ok).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});
