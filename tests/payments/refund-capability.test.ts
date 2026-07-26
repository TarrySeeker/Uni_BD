import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PROVIDER_REFUND_CAPABILITY,
  REFUND_PROVIDERS,
  isRefundProvider,
  providerRefundCapability,
} from '@/lib/payments/refund-capability';

/**
 * Способность провайдера вернуть деньги САМ (шлюзом) — ЧИСТЫЙ реестр (без сети/БД).
 *
 * Зачем отдельным модулем, а не внутри dispatch.ts: карта нужна ещё и слою
 * представления (карточка заказа рисует разный текст подтверждения возврата),
 * а dispatch.ts тянет за собой сервисы эквайеров → БД/сеть. Guard границы
 * «клиент → сервер» (tests/build/client-server-boundary.guard) такое не пустит.
 *
 * Инвариант мультитенантности: набор провайдеров здесь и в exhaustive switch
 * dispatchRefund — ОДИН И ТОТ ЖЕ (dispatch импортирует его отсюда). Новый эквайер
 * без записи в карте не соберётся типами.
 */

describe('providerRefundCapability — кто возвращает деньги: шлюз или человек', () => {
  it('tbank/alfabank — шлюзовой возврат (реальный reverse реализован)', () => {
    expect(providerRefundCapability('tbank')).toBe('gateway');
    expect(providerRefundCapability('alfabank')).toBe('gateway');
  });

  it('paykeeper — ручной: reverse в адаптере ЗАГЛУШКА (skipped:manual), деньги не двигаются', () => {
    expect(providerRefundCapability('paykeeper')).toBe('manual');
  });

  it('manual/gift — ручной (офлайн-платёж / сертификат: шлюза нет)', () => {
    expect(providerRefundCapability('manual')).toBe('manual');
    expect(providerRefundCapability('gift')).toBe('manual');
  });

  it('NULL (COD/офлайн, провайдер не проставлен) — ручной, НЕ дефолт-шлюз', () => {
    expect(providerRefundCapability(null)).toBe('manual');
  });

  it('неизвестный провайдер — ручной (консервативно: не обещаем автоматический возврат)', () => {
    expect(providerRefundCapability('stripe')).toBe('manual');
  });

  it('isRefundProvider распознаёт ровно реестр REFUND_PROVIDERS', () => {
    for (const p of REFUND_PROVIDERS) expect(isRefundProvider(p)).toBe(true);
    expect(isRefundProvider('stripe')).toBe(false);
    expect(isRefundProvider('')).toBe(false);
  });

  it('у каждого провайдера реестра есть запись способности (нет «дыр»)', () => {
    for (const p of REFUND_PROVIDERS) {
      expect(PROVIDER_REFUND_CAPABILITY[p], `нет способности возврата для «${p}»`).toBeTruthy();
    }
    expect(Object.keys(PROVIDER_REFUND_CAPABILITY).sort()).toEqual([...REFUND_PROVIDERS].sort());
  });

  it('guard: dispatchRefund берёт реестр ОТСЮДА (нет второй копии списка провайдеров)', () => {
    const src = readFileSync(join(process.cwd(), 'lib/payments/dispatch.ts'), 'utf8');
    expect(src).toContain("from '@/lib/payments/refund-capability'");
    // Локальной копии типа/предиката быть не должно — иначе списки разъедутся.
    expect(src).not.toMatch(/type RefundProvider =\s*\n?\s*'tbank'/);
    expect(src).not.toMatch(/function isRefundProvider\s*\(/);
  });
});
