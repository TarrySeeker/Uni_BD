import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  buildAttributeCreatePayload,
  buildAttributeUpdatePayload,
  buildAttributeValuePayload,
  buildAttributeValueUpdatePayload,
} from '@/app/admin/(panel)/catalog/attributes/_components/payload';
import {
  AttributeCreateSchema,
  AttributeUpdateSchema,
  AttributeValueSchema,
  AttributeValueUpdateSchema,
} from '@/lib/catalog/schemas';
import { defineAction, type ActionDeps } from '@/lib/server/action';
import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';

const UUID = '11111111-1111-4111-8111-111111111111';

// ЮНИТ: сборка payload форм справочника характеристик (F3 аудита) —
// чистые функции, общие для клиентских форм и Server Actions. Тестируем без
// БД/Next: что собранный объект проходит соответствующую Zod-схему каталога
// (тот же источник правды, что и внутри defineAction), плюс гейтинг по праву.

// ---------------------------------------------------------------------------
// Создание характеристики: payload → AttributeCreateSchema.
// ---------------------------------------------------------------------------
describe('buildAttributeCreatePayload', () => {
  it('минимальный валидный вход (code + name) проходит схему', () => {
    const payload = buildAttributeCreatePayload({ code: 'color', name: 'Цвет' });
    const res = AttributeCreateSchema.safeParse(payload);
    expect(res.success).toBe(true);
    if (res.success) {
      // Дефолты применяются Zod 4 даже к optional-полям (sanity).
      expect(res.data.type).toBe('select');
      expect(res.data.isVariant).toBe(false);
      expect(res.data.isFilterable).toBe(true);
      expect(res.data.isRequired).toBe(false);
      expect(res.data.sort).toBe(0);
    }
  });

  it('тримит код и название, прокидывает флаги/тип/единицу/сортировку', () => {
    const payload = buildAttributeCreatePayload({
      code: '  size  ',
      name: '  Размер  ',
      type: 'number',
      unit: '  см  ',
      isVariant: true,
      isFilterable: false,
      isRequired: true,
      sort: 5,
    });
    expect(payload.code).toBe('size');
    expect(payload.name).toBe('Размер');
    const res = AttributeCreateSchema.safeParse(payload);
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.type).toBe('number');
      expect(res.data.unit).toBe('см');
      expect(res.data.isVariant).toBe(true);
      expect(res.data.isFilterable).toBe(false);
      expect(res.data.isRequired).toBe(true);
      expect(res.data.sort).toBe(5);
    }
  });

  it('пустая единица измерения → undefined (не пустая строка)', () => {
    const payload = buildAttributeCreatePayload({ code: 'weight', name: 'Вес', unit: '   ' });
    expect(payload.unit).toBeUndefined();
    expect(AttributeCreateSchema.safeParse(payload).success).toBe(true);
  });

  it('невалидный код (кириллица) отклоняется схемой (attributeCodeSchema)', () => {
    const payload = buildAttributeCreatePayload({ code: 'Цвет', name: 'Цвет' });
    const res = AttributeCreateSchema.safeParse(payload);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path[0] === 'code')).toBe(true);
    }
  });

  it('невалидный код (пробел/верхний регистр) отклоняется схемой', () => {
    expect(AttributeCreateSchema.safeParse(buildAttributeCreatePayload({ code: 'co lor', name: 'X' })).success).toBe(false);
    expect(AttributeCreateSchema.safeParse(buildAttributeCreatePayload({ code: 'Color', name: 'X' })).success).toBe(false);
  });

  it('пустое название после трима отклоняется схемой', () => {
    const payload = buildAttributeCreatePayload({ code: 'x', name: '   ' });
    expect(AttributeCreateSchema.safeParse(payload).success).toBe(false);
  });

  it('неизвестный тип отклоняется enum-схемой', () => {
    const payload = buildAttributeCreatePayload({ code: 'x', name: 'X', type: 'json' as never });
    expect(AttributeCreateSchema.safeParse(payload).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Правка характеристики: payload → AttributeUpdateSchema (code неизменяем).
// ---------------------------------------------------------------------------
describe('buildAttributeUpdatePayload', () => {
  it('частичный апдейт: только id + название', () => {
    const payload = buildAttributeUpdatePayload(UUID, { name: 'Новое имя' });
    expect(payload.id).toBe(UUID);
    expect('code' in payload).toBe(false); // code не правится через update
    const res = AttributeUpdateSchema.safeParse(payload);
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.name).toBe('Новое имя');
  });

  it('единица: пустая строка → null (сброс), значение → тримится', () => {
    const cleared = buildAttributeUpdatePayload(UUID, { unit: '   ' });
    expect(cleared.unit).toBeNull();
    expect(AttributeUpdateSchema.safeParse(cleared).success).toBe(true);

    const set = buildAttributeUpdatePayload(UUID, { unit: ' кг ' });
    expect(set.unit).toBe('кг');
    expect(AttributeUpdateSchema.safeParse(set).success).toBe(true);
  });

  it('прокидывает флаги/тип/сортировку и проходит схему', () => {
    const payload = buildAttributeUpdatePayload(UUID, {
      name: 'Цвет',
      type: 'select',
      isVariant: true,
      isFilterable: false,
      isRequired: true,
      sort: 3,
    });
    const res = AttributeUpdateSchema.safeParse(payload);
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.isVariant).toBe(true);
      expect(res.data.isFilterable).toBe(false);
      expect(res.data.isRequired).toBe(true);
      expect(res.data.sort).toBe(3);
    }
  });

  it('невалидный id (не uuid) отклоняется схемой', () => {
    const payload = buildAttributeUpdatePayload('not-a-uuid', { name: 'X' });
    expect(AttributeUpdateSchema.safeParse(payload).success).toBe(false);
  });

  it('пустое название (после трима) отклоняется схемой', () => {
    const payload = buildAttributeUpdatePayload(UUID, { name: '   ' });
    expect(AttributeUpdateSchema.safeParse(payload).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Добавление значения словаря: payload → AttributeValueSchema.
// ---------------------------------------------------------------------------
describe('buildAttributeValuePayload', () => {
  it('минимальный валидный вход (attributeId + value) проходит схему', () => {
    const payload = buildAttributeValuePayload(UUID, { value: 'Красный' });
    const res = AttributeValueSchema.safeParse(payload);
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.attributeId).toBe(UUID);
      expect(res.data.value).toBe('Красный');
      expect(res.data.sort).toBe(0);
    }
  });

  it('тримит значение, прокидывает slug и sort', () => {
    const payload = buildAttributeValuePayload(UUID, { value: '  Синий  ', slug: 'blue', sort: 2 });
    expect(payload.value).toBe('Синий');
    const res = AttributeValueSchema.safeParse(payload);
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.slug).toBe('blue');
      expect(res.data.sort).toBe(2);
    }
  });

  it('пустой slug → undefined (авто на сервере), не пустая строка', () => {
    const payload = buildAttributeValuePayload(UUID, { value: 'Зелёный', slug: '   ' });
    expect(payload.slug).toBeUndefined();
    expect(AttributeValueSchema.safeParse(payload).success).toBe(true);
  });

  it('невалидный slug (верхний регистр/двойной дефис) отклоняется схемой', () => {
    expect(AttributeValueSchema.safeParse(buildAttributeValuePayload(UUID, { value: 'X', slug: 'Foo' })).success).toBe(false);
    expect(AttributeValueSchema.safeParse(buildAttributeValuePayload(UUID, { value: 'X', slug: 'foo--bar' })).success).toBe(false);
  });

  it('пустое значение (после трима) отклоняется схемой', () => {
    const payload = buildAttributeValuePayload(UUID, { value: '   ' });
    expect(AttributeValueSchema.safeParse(payload).success).toBe(false);
  });

  it('невалидный attributeId (не uuid) отклоняется схемой', () => {
    const payload = buildAttributeValuePayload('nope', { value: 'X' });
    expect(AttributeValueSchema.safeParse(payload).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RBAC: справочник характеристик мутируется под catalog.write (как соседние
// разделы каталога). Проверяем пайплайн guard на реальных схемах атрибутов,
// без БД (handler замокан, deps инъецированы) — тот же приём, что в
// actions-guard.test.ts.
// ---------------------------------------------------------------------------
function makeUser(perms: PermissionCode[], isOwner = false): AuthUser {
  return { id: 'u-1', email: 'u@shop.io', isOwner, permissions: new Set<PermissionCode>(perms) };
}
function makeDeps(user: AuthUser | null): ActionDeps {
  return {
    getCurrentUser: vi.fn(async () => user),
    writeAudit: vi.fn(async () => {}),
    revalidate: vi.fn(async () => {}),
    getRequestMeta: vi.fn(async () => ({ ip: '127.0.0.1', userAgent: 'vitest' })),
  };
}

describe('характеристики через defineAction — guard catalog.write', () => {
  // schema типизируем общим супертипом z.ZodTypeAny: цикл намеренно перебирает
  // РАЗНОРОДНЫЕ схемы (create/update/value), а defineAction ждёт ZodType<I> —
  // без общего супертипа TS пытается свести их к одному shape и падает (TS2322).
  const cases: ReadonlyArray<{ name: string; schema: z.ZodTypeAny; input: unknown }> = [
    { name: 'createAttribute', schema: AttributeCreateSchema, input: { code: 'color', name: 'Цвет' } },
    { name: 'updateAttribute', schema: AttributeUpdateSchema, input: { id: UUID, name: 'Цвет' } },
    { name: 'addAttributeValue', schema: AttributeValueSchema, input: { attributeId: UUID, value: 'Красный' } },
  ];

  for (const c of cases) {
    it(`${c.name}: только catalog.read → forbidden, handler не вызван`, async () => {
      const deps = makeDeps(makeUser(['catalog.read']));
      const handler = vi.fn(async () => ({ result: { id: 'x' } }));
      const action = defineAction({ permission: 'catalog.write', input: c.schema, handler, deps });
      const res = await action(c.input);
      expect(res).toEqual({ ok: false, error: 'forbidden' });
      expect(handler).not.toHaveBeenCalled();
    });

    it(`${c.name}: catalog.write → проходит guard, handler вызван`, async () => {
      const deps = makeDeps(makeUser(['catalog.write']));
      const handler = vi.fn(async () => ({ result: { id: 'x' } }));
      const action = defineAction({ permission: 'catalog.write', input: c.schema, handler, deps });
      const res = await action(c.input);
      expect(res.ok).toBe(true);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it(`${c.name}: не аутентифицирован → unauthorized, handler не вызван`, async () => {
      const deps = makeDeps(null);
      const handler = vi.fn(async () => ({ result: { id: 'x' } }));
      const action = defineAction({ permission: 'catalog.write', input: c.schema, handler, deps });
      const res = await action(c.input);
      expect(res).toEqual({ ok: false, error: 'unauthorized' });
      expect(handler).not.toHaveBeenCalled();
    });
  }

  it('owner проходит без явного права (createAttribute)', async () => {
    const deps = makeDeps(makeUser([], true));
    const handler = vi.fn(async () => ({ result: { id: 'x' } }));
    const action = defineAction({ permission: 'catalog.write', input: AttributeCreateSchema, handler, deps });
    const res = await action({ code: 'color', name: 'Цвет' });
    expect(res.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// HEX справочника «Цвет» (0043): форма нормализует бытовой ввод, схема судит.
//
// ПОЧЕМУ ЭТО РАЗДЕЛЕНИЕ ТЕСТИРУЕТСЯ: человек набирает `FFFFFF` и `#fff`, а
// CHECK в БД и Zod принимают строго '#RRGGBB'. Если нормализации нет, редактор
// получает ошибку формата на совершенно разумном вводе; если нормализация
// «дочинивает» мусор — в БД уедет неверный цвет. Граница ровно здесь.
// ---------------------------------------------------------------------------
describe('buildAttributeValuePayload: colorHex', () => {
  it('#RRGGBB проходит как есть (в верхнем регистре) и валиден по схеме', () => {
    const payload = buildAttributeValuePayload(UUID, { value: 'Белый', colorHex: '#ffffff' });
    expect(payload.colorHex).toBe('#FFFFFF');
    expect(AttributeValueSchema.safeParse(payload).success).toBe(true);
  });

  it('бытовой ввод без решётки и сокращённый #RGB нормализуются', () => {
    expect(buildAttributeValuePayload(UUID, { value: 'X', colorHex: 'ff00aa' }).colorHex).toBe('#FF00AA');
    expect(buildAttributeValuePayload(UUID, { value: 'X', colorHex: '#f0a' }).colorHex).toBe('#FF00AA');
    expect(buildAttributeValuePayload(UUID, { value: 'X', colorHex: ' FFF ' }).colorHex).toBe('#FFFFFF');
  });

  it('поле не показано (не цветной справочник) → colorHex не передаётся вовсе', () => {
    const payload = buildAttributeValuePayload(UUID, { value: 'M' });
    expect(payload.colorHex).toBeUndefined();
    expect(AttributeValueSchema.safeParse(payload).success).toBe(true);
  });

  it('пустое поле HEX → undefined: значение без свотча валидно', () => {
    const payload = buildAttributeValuePayload(UUID, { value: 'Белый', colorHex: '   ' });
    expect(payload.colorHex).toBeUndefined();
    expect(AttributeValueSchema.safeParse(payload).success).toBe(true);
  });

  it('нераспознанный ввод НЕ «дочиняется» — отдаётся схеме и отклоняется ею', () => {
    const payload = buildAttributeValuePayload(UUID, { value: 'X', colorHex: 'красный' });
    expect(payload.colorHex).toBe('красный');
    expect(AttributeValueSchema.safeParse(payload).success).toBe(false);
  });
});

describe('buildAttributeValueUpdatePayload', () => {
  it('правка только hex: остальные поля undefined (сервер их не трогает)', () => {
    const payload = buildAttributeValueUpdatePayload(UUID, { colorHex: '#123abc' });
    expect(payload).toMatchObject({ id: UUID, colorHex: '#123ABC' });
    expect(payload.value).toBeUndefined();
    expect(payload.sort).toBeUndefined();
    expect(AttributeValueUpdateSchema.safeParse(payload).success).toBe(true);
  });

  it('пустая строка HEX → null: это ОСОЗНАННАЯ очистка, а не «не трогать»', () => {
    const payload = buildAttributeValueUpdatePayload(UUID, { colorHex: '' });
    expect(payload.colorHex).toBeNull();
    const res = AttributeValueUpdateSchema.safeParse(payload);
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.colorHex).toBeNull();
    }
  });

  it('мусорный hex доходит до схемы и отклоняется (валидация не только в UI)', () => {
    const payload = buildAttributeValueUpdatePayload(UUID, { colorHex: '#12345' });
    expect(AttributeValueUpdateSchema.safeParse(payload).success).toBe(false);
  });

  it('невалидный id отклоняется схемой', () => {
    expect(
      AttributeValueUpdateSchema.safeParse(
        buildAttributeValueUpdatePayload('nope', { colorHex: '#FFFFFF' }),
      ).success,
    ).toBe(false);
  });
});
