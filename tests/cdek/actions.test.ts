import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';

/**
 * Тесты Server Actions модуля cdek (docs/08 §10.1, Пакет F).
 *
 * Проверяем единый пайплайн defineAction для cdek-действий БЕЗ БД/сети:
 *   • guard: пользователь без cdek.manage → error:'forbidden', сервис не вызван;
 *   • owner (с cdek.manage) проходит → вызывается нужный сервис (замокан);
 *   • аудит пишется с правильным action ('cdek.*') и entityId;
 *   • revalidate карточки заказа вызывается;
 *   • выключенный модуль cdek → ошибка (handler бросает CdekError → 'internal').
 *
 * Сервисы (OrderService/TrackingService/PrintService) мокаются целиком — мы
 * проверяем оркестрацию пайплайна, а не их внутреннюю логику (она в пакете D).
 */

// --- Моки сервисов СДЭК (до импорта actions). --------------------------------
const createShipmentMock = vi.fn(async () => ({
  id: 'sh-1',
  cdekUuid: 'mock-uuid',
  cdekNumber: '1234567890',
  isMock: true,
}));
const cancelShipmentMock = vi.fn(async () => undefined);
const refreshStatusMock = vi.fn(async () => ({
  statusCode: 'DELIVERED',
  appliedDeliveryStatus: 'delivered',
  transitioned: true,
}));
const getShipmentLabelMock = vi.fn(async () => ({ url: 'https://example.invalid/mock.pdf' }));

vi.mock('@/lib/cdek/services/order', () => ({
  OrderService: class {
    createShipment = createShipmentMock;
    cancelShipment = cancelShipmentMock;
  },
}));
vi.mock('@/lib/cdek/services/tracking', () => ({
  TrackingService: class {
    refreshStatus = refreshStatusMock;
  },
}));
vi.mock('@/lib/cdek/services/print', () => ({
  PrintService: class {
    getShipmentLabel = getShipmentLabelMock;
  },
}));

// --- Модуль cdek включён по умолчанию; отдельный тест выключит его. -----------
// Гейт теперь авторитетный (env ⊕ БД) и живёт в @/lib/config/settings.
const isModuleEnabledMock = vi.fn(async () => true);
vi.mock('@/lib/config/settings', () => ({
  isModuleEffectivelyEnabled: (...a: unknown[]) => isModuleEnabledMock(...(a as [])),
}));

// --- Пайплайн defineAction: подменяем auth/audit/cache/headers. --------------
let currentUser: AuthUser | null = null;
const getCurrentUserMock = vi.fn(async () => currentUser);
vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: (...a: unknown[]) => getCurrentUserMock(...(a as [])),
}));

const writeAuditMock = vi.fn(async (_entry: Record<string, unknown>, _ctx: unknown) => undefined);
vi.mock('@/lib/audit/log', () => ({
  writeAudit: (entry: Record<string, unknown>, ctx: unknown) => writeAuditMock(entry, ctx),
}));

const revalidatePathMock = vi.fn();
vi.mock('next/cache', () => ({
  revalidatePath: (...a: unknown[]) => revalidatePathMock(...(a as [])),
}));

vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (name: string) =>
      name === 'x-forwarded-for' ? '203.0.113.5' : name === 'user-agent' ? 'UA-test' : null,
  }),
}));

import {
  createCdekShipment,
  cancelCdekShipment,
  refreshCdekStatus,
  getCdekLabel,
} from '@/lib/cdek/actions';
import { CdekError } from '@/lib/cdek/errors';

function makeUser(perms: PermissionCode[]): AuthUser {
  return {
    id: 'user-1',
    email: 'admin@admik.test',
    roles: [],
    permissions: new Set<PermissionCode>(perms),
  } as unknown as AuthUser;
}

const ORDER_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  createShipmentMock.mockClear();
  cancelShipmentMock.mockClear();
  refreshStatusMock.mockClear();
  getShipmentLabelMock.mockClear();
  writeAuditMock.mockClear();
  revalidatePathMock.mockClear();
  isModuleEnabledMock.mockResolvedValue(true);
  currentUser = makeUser(['cdek.manage']);
});

// =============================================================================
// Guard — право cdek.manage.
// =============================================================================

describe('cdek actions — guard cdek.manage', () => {
  it('нет права cdek.manage → forbidden, сервис не вызван', async () => {
    currentUser = makeUser([]);
    const res = await createCdekShipment({ orderId: ORDER_ID });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('forbidden');
    expect(createShipmentMock).not.toHaveBeenCalled();
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it('не аутентифицирован → unauthorized', async () => {
    currentUser = null;
    const res = await refreshCdekStatus({ orderId: ORDER_ID });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('unauthorized');
    expect(refreshStatusMock).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Owner (cdek.manage) — успешный путь + аудит + revalidate.
// =============================================================================

describe('cdek actions — успешный путь (cdek.manage)', () => {
  it('createCdekShipment → вызывает OrderService.createShipment, audit cdek.shipment.create, revalidate', async () => {
    const res = await createCdekShipment({ orderId: ORDER_ID });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toMatchObject({ id: 'sh-1', cdekUuid: 'mock-uuid' });
    expect(createShipmentMock).toHaveBeenCalledWith(ORDER_ID, { force: undefined });
    expect(writeAuditMock).toHaveBeenCalledOnce();
    expect(writeAuditMock.mock.calls[0]![0]).toMatchObject({
      action: 'cdek.shipment.create',
      entityType: 'cdek_shipment',
      entityId: 'sh-1',
    });
    expect(revalidatePathMock).toHaveBeenCalledWith(`/admin/orders/${ORDER_ID}`);
  });

  it('cancelCdekShipment → вызывает cancelShipment, audit cdek.shipment.cancel', async () => {
    const res = await cancelCdekShipment({ orderId: ORDER_ID });
    expect(res.ok).toBe(true);
    expect(cancelShipmentMock).toHaveBeenCalledWith(ORDER_ID);
    expect(writeAuditMock.mock.calls[0]![0]).toMatchObject({ action: 'cdek.shipment.cancel' });
  });

  it('refreshCdekStatus → вызывает refreshStatus, audit cdek.status.sync с результатом', async () => {
    const res = await refreshCdekStatus({ orderId: ORDER_ID });
    expect(res.ok).toBe(true);
    expect(refreshStatusMock).toHaveBeenCalledWith(ORDER_ID);
    expect(writeAuditMock.mock.calls[0]![0]).toMatchObject({
      action: 'cdek.status.sync',
      after: { statusCode: 'DELIVERED', deliveryStatus: 'delivered', transitioned: true },
    });
  });

  it('getCdekLabel → вызывает getShipmentLabel, возвращает url, audit cdek.print.label', async () => {
    const res = await getCdekLabel({ orderId: ORDER_ID, kind: 'waybill' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.url).toBe('https://example.invalid/mock.pdf');
    expect(getShipmentLabelMock).toHaveBeenCalledWith(ORDER_ID, { kind: 'waybill' });
    expect(writeAuditMock.mock.calls[0]![0]).toMatchObject({ action: 'cdek.print.label' });
  });
});

// =============================================================================
// Валидация и module-gate.
// =============================================================================

describe('cdek actions — валидация и module-gate', () => {
  it('невалидный orderId (не uuid) → validation, сервис не вызван', async () => {
    const res = await createCdekShipment({ orderId: 'not-a-uuid' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('validation');
    expect(createShipmentMock).not.toHaveBeenCalled();
  });

  it('модуль cdek выключен → internal (handler бросает CdekError), сервис не вызван', async () => {
    isModuleEnabledMock.mockResolvedValue(false);
    const res = await createCdekShipment({ orderId: ORDER_ID });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('internal');
    expect(createShipmentMock).not.toHaveBeenCalled();
  });

  it('заказ не оплачен (CdekError precondition) → validation с понятным сообщением (FF.md)', async () => {
    // Сервис отклоняет создание накладной до оплаты — оператор должен увидеть
    // ПОНЯТНЫЙ текст в форме, а не безликий «internal» (см. withUserFacingCdekError).
    createShipmentMock.mockRejectedValueOnce(
      new CdekError('cdek_precondition_failed', 'Заказ ещё не оплачен. Накладная создаётся только после оплаты.'),
    );
    const res = await createCdekShipment({ orderId: ORDER_ID });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('validation');
      expect(res.message).toMatch(/не оплач/i);
    }
  });

  it('неожиданная ошибка СДЭК (не из белого списка) → internal без утечки текста', async () => {
    createShipmentMock.mockRejectedValueOnce(
      new CdekError('cdek_http_500', 'СДЭК 500: internal details'),
    );
    const res = await createCdekShipment({ orderId: ORDER_ID });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('internal');
      expect((res as { message?: string }).message).toBeUndefined();
    }
  });
});
