import { describe, it, expect } from 'vitest';

import {
  createMailNotifier,
  type MailNotifierDeps,
  type OrderMailSnapshot,
} from '@/lib/mail/notifications';
import type { MailSendResult, MailMessage } from '@/lib/mail/types';

/**
 * Точки вызова почты: «оплачен заказ» и «сменился статус доставки».
 *
 * 🔴 ГЛАВНОЕ ПРАВИЛО ЭТОГО СЛОЯ — НЕ РОНЯТЬ ДЕНЕЖНЫЙ ПУТЬ. Обе функции вызываются
 * ПОСЛЕ коммита оплаты/статуса; любое исключение отсюда откатило бы факт оплаты
 * или заставило эквайер ретраить вебхук. Поэтому они ловят всё и возвращают отчёт
 * — ровно тот же контракт, что у автовыпуска сертификатов (lib/gift-certificates/
 * auto-issue.ts), рядом с которым они и живут.
 *
 * Второе правило — язык ПОКУПАТЕЛЯ, а не оператора: locale берётся из снимка
 * заказа/покупателя, а не из настроек админки.
 */

const ORDER: OrderMailSnapshot = {
  orderId: 'ord-1',
  orderNumber: '2026-000123',
  customerName: 'Иван',
  customerEmail: 'ivan@example.test',
  locale: 'ru',
  grandTotal: '12500.00',
  currency: 'RUB',
  trackNumber: null,
  items: [{ name: 'Платок', qty: 1, sum: '12500.00' }],
};

interface Sent {
  message: MailMessage;
}

function harness(overrides: Partial<MailNotifierDeps> = {}) {
  const sent: Sent[] = [];
  const logs: string[] = [];
  const deps: MailNotifierDeps = {
    getOrderSnapshot: async () => ORDER,
    getIssuedCertificates: async () => [],
    getShopName: async () => 'Магазин',
    getDefaultLocale: async () => 'ru',
    buildOrderUrl: async () => 'https://shop.test/cart/success?number=2026-000123&token=t',
    sendMail: async (message): Promise<MailSendResult> => {
      sent.push({ message });
      return { ok: true, status: 'sent', attempts: 1, logId: 'log-1' };
    },
    logger: {
      debug: (m) => logs.push(`debug:${m}`),
      info: (m) => logs.push(`info:${m}`),
      warn: (m) => logs.push(`warn:${m}`),
      error: (m) => logs.push(`error:${m}`),
      child: () => deps.logger,
    },
    ...overrides,
  };
  return { deps, sent, logs };
}

describe('mail/notifications — письма по оплаченному заказу', () => {
  it('обычный заказ → одно письмо-подтверждение покупателю', async () => {
    const h = harness();
    const report = await createMailNotifier(h.deps).notifyOrderPaid('ord-1');

    expect(report.ok).toBe(true);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.message.template).toBe('order_confirmation');
    expect(h.sent[0]!.message.to).toBe('ivan@example.test');
  });

  it('🔴 заказ с выпущенным сертификатом → ОТДЕЛЬНОЕ письмо с кодом', async () => {
    const h = harness({
      getIssuedCertificates: async () => [
        { code: 'ABCD-1234', amount: '5000.00', currency: 'RUB', validUntil: null },
      ],
    });
    const report = await createMailNotifier(h.deps).notifyOrderPaid('ord-1');

    const templates = h.sent.map((s) => s.message.template);
    expect(templates).toContain('gift_certificate');
    expect(templates).toContain('order_confirmation');
    expect(report.sent).toBe(2);

    const gift = h.sent.find((s) => s.message.template === 'gift_certificate')!;
    expect(gift.message.html).toContain('ABCD-1234');
  });

  it('письмо уходит на языке ПОКУПАТЕЛЯ (fr), а не магазина (ru)', async () => {
    const h = harness({
      getOrderSnapshot: async () => ({ ...ORDER, locale: 'fr' }),
    });
    await createMailNotifier(h.deps).notifyOrderPaid('ord-1');
    expect(h.sent[0]!.message.locale).toBe('fr');
  });

  it('язык покупателя не задан → язык магазина по умолчанию', async () => {
    const h = harness({
      getOrderSnapshot: async () => ({ ...ORDER, locale: null }),
      getDefaultLocale: async () => 'en',
    });
    await createMailNotifier(h.deps).notifyOrderPaid('ord-1');
    expect(h.sent[0]!.message.locale).toBe('en');
  });

  it('заказ без email → ничего не отправляем, но и не падаем', async () => {
    const h = harness({
      getOrderSnapshot: async () => ({ ...ORDER, customerEmail: '' }),
    });
    const report = await createMailNotifier(h.deps).notifyOrderPaid('ord-1');
    expect(report.ok).toBe(true);
    expect(report.reason).toBe('no_recipient');
    expect(h.sent).toHaveLength(0);
  });

  it('заказ не найден → отчёт, а не исключение', async () => {
    const h = harness({ getOrderSnapshot: async () => null });
    const report = await createMailNotifier(h.deps).notifyOrderPaid('ord-404');
    expect(report.ok).toBe(true);
    expect(report.reason).toBe('order_not_found');
  });

  it('🔴 падение sendMail НЕ выпускает исключение наружу (денежный путь)', async () => {
    const h = harness({
      sendMail: async () => {
        throw new Error('транспорт умер');
      },
    });
    const report = await createMailNotifier(h.deps).notifyOrderPaid('ord-1');
    expect(report.ok).toBe(false);
    expect(report.failed).toBeGreaterThan(0);
  });

  it('🔴 падение ЧТЕНИЯ заказа тоже не выпускает исключение', async () => {
    const h = harness({
      getOrderSnapshot: async () => {
        throw new Error('БД недоступна');
      },
    });
    const report = await createMailNotifier(h.deps).notifyOrderPaid('ord-1');
    expect(report.ok).toBe(false);
    expect(report.reason).toBe('error');
  });

  it('🔴 провал письма о сертификате НЕ отменяет письмо-подтверждение', async () => {
    let call = 0;
    const h = harness({
      getIssuedCertificates: async () => [
        { code: 'X-1', amount: '1.00', currency: 'RUB', validUntil: null },
      ],
      sendMail: async (message): Promise<MailSendResult> => {
        call += 1;
        if (message.template === 'gift_certificate') throw new Error('релей отказал');
        return { ok: true, status: 'sent', attempts: 1, logId: `log-${call}` };
      },
    });
    const report = await createMailNotifier(h.deps).notifyOrderPaid('ord-1');
    expect(report.failed).toBe(1);
    expect(report.sent).toBe(1);
  });

  it('🔴 код сертификата не попадает в отчёт (он уходит в почту, не в логи)', async () => {
    const h = harness({
      getIssuedCertificates: async () => [
        { code: 'SECRET-CODE-42', amount: '1.00', currency: 'RUB', validUntil: null },
      ],
    });
    const report = await createMailNotifier(h.deps).notifyOrderPaid('ord-1');
    expect(JSON.stringify(report)).not.toContain('SECRET-CODE-42');
    expect(JSON.stringify(h.logs)).not.toContain('SECRET-CODE-42');
  });
});

describe('mail/notifications — письма о смене статуса доставки', () => {
  it('статус с шаблоном в STATUS_TO_CLIENT_TEMPLATE → письмо покупателю', async () => {
    const h = harness();
    const report = await createMailNotifier(h.deps).notifyDeliveryStatus('ord-1', 'DELIVERED');
    expect(report.ok).toBe(true);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.message.template).toBe('cdek_delivered');
  });

  it('статус БЕЗ шаблона (CREATED — технический) → письма нет', async () => {
    const h = harness();
    const report = await createMailNotifier(h.deps).notifyDeliveryStatus('ord-1', 'CREATED');
    expect(report.ok).toBe(true);
    expect(report.reason).toBe('no_template');
    expect(h.sent).toHaveLength(0);
  });

  it('неизвестный код статуса → письма нет и нет падения', async () => {
    const h = harness();
    const report = await createMailNotifier(h.deps).notifyDeliveryStatus('ord-1', 'ЧТО_ТО_НОВОЕ');
    expect(report.ok).toBe(true);
    expect(h.sent).toHaveLength(0);
  });

  it('несколько кодов ведут на один шаблон (READY_FOR_PICKUP/ACCEPTED_AT_PICK_UP_POINT)', async () => {
    const a = harness();
    await createMailNotifier(a.deps).notifyDeliveryStatus('ord-1', 'READY_FOR_PICKUP');
    const b = harness();
    await createMailNotifier(b.deps).notifyDeliveryStatus('ord-1', 'ACCEPTED_AT_PICK_UP_POINT');
    expect(a.sent[0]!.message.template).toBe(b.sent[0]!.message.template);
    expect(a.sent[0]!.message.template).toBe('cdek_ready_for_pickup');
  });

  it('трек-номер заказа попадает в письмо', async () => {
    const h = harness({
      getOrderSnapshot: async () => ({ ...ORDER, trackNumber: 'CDEK-777' }),
    });
    await createMailNotifier(h.deps).notifyDeliveryStatus('ord-1', 'ON_THE_WAY');
    // ON_THE_WAY шаблона не имеет — проверяем на статусе, который имеет.
    const h2 = harness({
      getOrderSnapshot: async () => ({ ...ORDER, trackNumber: 'CDEK-777' }),
    });
    await createMailNotifier(h2.deps).notifyDeliveryStatus('ord-1', 'SENT_TO_RECIPIENT_CITY');
    expect(h2.sent[0]!.message.text).toContain('CDEK-777');
  });

  it('🔴 сбой отправки не выпускает исключение (вебхук СДЭК обязан получить 200)', async () => {
    const h = harness({
      sendMail: async () => {
        throw new Error('релей недоступен');
      },
    });
    const report = await createMailNotifier(h.deps).notifyDeliveryStatus('ord-1', 'DELIVERED');
    expect(report.ok).toBe(false);
    expect(report.failed).toBe(1);
  });

  it('язык покупателя соблюдается и в письмах о доставке', async () => {
    const h = harness({ getOrderSnapshot: async () => ({ ...ORDER, locale: 'en' }) });
    await createMailNotifier(h.deps).notifyDeliveryStatus('ord-1', 'DELIVERED');
    expect(h.sent[0]!.message.locale).toBe('en');
  });
});
