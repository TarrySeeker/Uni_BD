/**
 * DEMO-страница оплаты Т-Банк (ТОЛЬКО mock-режим — стенд без боевых ключей).
 *
 * В боевом режиме (заданы TBANK_*) PaymentURL ведёт на реальный шлюз Т-Банк, и эта
 * страница недоступна (notFound). В mock-режиме `initPayment` отдаёт сюда абсолютный
 * URL с orderId/paymentId/amount/returnUrl, и покупатель имитирует оплату:
 *  - «Оплатить (демо)» → confirmMockPayment (строго mock) помечает заказ оплаченным
 *    тем же атомарным путём, что и webhook, → возврат в магазин (?paid=1);
 *  - «Отмена» → возврат в магазин (?payment=cancelled).
 *
 * Назначение — сделать демо онлайн-оплаты сквозным без боевых ключей. С боевыми
 * ключами весь путь идёт через настоящий Т-Банк, эта страница не задействуется.
 */
import { redirect, notFound } from 'next/navigation';
import { getTbankConfig } from '@/lib/payments/tbank/config';
import { PaymentService } from '@/lib/payments/tbank/service';
import { getStorefrontConfig, normalizeOrigin } from '@/lib/storefront/env';

export const dynamic = 'force-dynamic';

/** mock-режим = не заданы боевые ключи (эквивалент manager.isMock). */
function isMockMode(): boolean {
  const cfg = getTbankConfig();
  return !cfg.terminalKey || !cfg.password;
}

/** Безопасно добавляет query-параметр к returnUrl. ANTI-OPEN-REDIRECT: origin
 *  returnUrl должен быть в allowlist витрины (STOREFRONT_ALLOWED_ORIGINS) — иначе
 *  '/'. Не-http(s)/битый URL → тоже '/'. (Страница публична → returnUrl из query
 *  нельзя слепо использовать для редиректа.) */
function withParam(url: string, key: string, val: string, allowed: string[]): string {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '/';
    // Allowlist применяем ТОЛЬКО когда он задан. Пустой STOREFRONT_ALLOWED_ORIGINS —
    // это режим «demo без секретов» (auth.ts: доступ открыт всем); жёсткая проверка
    // тогда отправляла бы ЛЮБОЙ легитимный возврат в '/' и ломала demo-оплату.
    if (allowed.length > 0 && !allowed.includes(normalizeOrigin(u.origin) ?? '')) return '/';
    u.searchParams.set(key, val);
    return u.toString();
  } catch {
    return '/';
  }
}

function formatRub(amountKop: number): string {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(
    amountKop / 100,
  );
}

export default async function MockPayPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  if (!isMockMode()) notFound(); // demo-страница существует только в mock-режиме

  const sp = await searchParams;
  const orderId = sp.orderId ?? '';
  const paymentId = sp.paymentId ?? '';
  const amountKop = Number(sp.amount ?? 0);
  const returnUrl = sp.returnUrl ?? '';
  const allowed = getStorefrontConfig().allowedOrigins;

  async function pay() {
    'use server';
    // Подтверждаем платёж; paid=1 ставим ТОЛЬКО при успехе confirmMockPayment
    // (иначе ?payment=failed — не выдаём неуспех за оплату).
    const res = await new PaymentService().confirmMockPayment(orderId, paymentId);
    if (!returnUrl) redirect('/');
    redirect(res.ok ? withParam(returnUrl, 'paid', '1', allowed) : withParam(returnUrl, 'payment', 'failed', allowed));
  }

  async function cancel() {
    'use server';
    redirect(returnUrl ? withParam(returnUrl, 'payment', 'cancelled', allowed) : '/');
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-neutral-100 p-4">
      <div className="w-full max-w-md bg-white rounded-xl shadow-sm border border-neutral-200 p-8">
        <div className="mb-6">
          <p className="text-xs uppercase tracking-widest text-amber-600 font-medium">Демо-оплата · тестовый режим</p>
          <h1 className="text-xl font-semibold text-neutral-900 mt-2">Оплата заказа</h1>
          <p className="text-sm text-neutral-500 mt-1">
            Боевые ключи Т-Банк не подключены — это имитация платёжной страницы для демонстрации.
          </p>
        </div>

        <div className="rounded-lg bg-neutral-50 border border-neutral-200 p-4 space-y-2 mb-6">
          <div className="flex justify-between text-sm">
            <span className="text-neutral-500">Заказ</span>
            <span className="font-medium text-neutral-900">{orderId || '—'}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-neutral-500">К оплате</span>
            <span className="font-semibold text-neutral-900">{formatRub(amountKop)}</span>
          </div>
        </div>

        <div className="space-y-3">
          <form action={pay}>
            <button
              type="submit"
              className="w-full rounded-lg bg-neutral-900 text-white py-3 text-sm font-medium hover:bg-neutral-800 transition-colors"
            >
              Оплатить (демо)
            </button>
          </form>
          <form action={cancel}>
            <button
              type="submit"
              className="w-full rounded-lg border border-neutral-300 text-neutral-700 py-3 text-sm hover:bg-neutral-50 transition-colors"
            >
              Отмена
            </button>
          </form>
        </div>

        <p className="text-[11px] text-neutral-400 mt-6 text-center">
          После подключения боевых ключей Т-Банк оплата пойдёт через настоящий платёжный шлюз.
        </p>
      </div>
    </main>
  );
}
