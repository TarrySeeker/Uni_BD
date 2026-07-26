import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * GUARD карточки заказа: возврат денег — ОДНА кнопка с ОДНИМ смыслом
 * (аудит 2026-07-26, критичное №7).
 *
 * Тестов React-компонентов в проекте нет (environment: 'node'), поэтому вёрстку
 * сторожим по исходнику. Сторожим ПРИЧИНУ аварии: менеджер видел два одинаковых
 * с виду действия — «Статус заказа → Возврат» (обращалось к платёжному шлюзу) и
 * «Статус оплаты → Возврат» (штамповало «возвращено» без шлюза, без подтверждения
 * и без возможности всё исправить: заказ становился терминальным). Оба входа
 * обязаны вести в один обработчик, а «возврат вне системы» — требовать явного
 * подтверждения оператора.
 */

const PANEL = readFileSync(
  join(process.cwd(), 'app/admin/(panel)/orders/_components/OrderActionsPanel.tsx'),
  'utf8',
);

describe('guard: единственный путь возврата в карточке заказа', () => {
  it('есть один обработчик возврата runRefund, и только он зовёт refundOrderAction', () => {
    expect(PANEL).toContain('async function runRefund(');
    const calls = PANEL.match(/refundOrderAction\(/g) ?? [];
    expect(calls, 'refundOrderAction вызывается больше одного раза — путей возврата снова два').toHaveLength(
      1,
    );
  });

  it('кнопка «Возврат» в статусах ОПЛАТЫ ведёт в тот же runRefund, а не в setPaymentStatusAction', () => {
    expect(PANEL).toMatch(/to === 'refunded'\s*\?\s*runRefund\(false\)/);
  });

  it('оба входа возврата проходят через подтверждение (confirmRefund)', () => {
    expect(PANEL).toContain('orders.orderActionsPanel.confirmRefund');
  });

  it('«деньги возвращены вне системы» требует отдельного явного подтверждения', () => {
    // Блок появляется строго по машиночитаемому коду отказа сервера.
    expect(PANEL).toContain("result.code === 'manual_refund_required'");
    expect(PANEL).toContain('runRefund(true)');
    expect(PANEL).toContain('orders.orderActionsPanel.confirmManualRefund');
    expect(PANEL).toContain('orders.orderActionsPanel.manualRefundButton');
  });

  it('подтверждение отмены честно предупреждает, что деньги НЕ возвращаются', () => {
    const ru = JSON.parse(readFileSync(join(process.cwd(), 'messages/ru.json'), 'utf8')) as {
      orders: { orderActionsPanel: Record<string, string> };
    };
    expect(ru.orders.orderActionsPanel.confirmCancel).toMatch(/НЕ возвращаются|Возврат/);
  });
});
