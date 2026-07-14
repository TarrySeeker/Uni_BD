/**
 * DEMO-страница оплаты PayKeeper (ТОЛЬКО mock-режим — стенд без боевых ключей).
 *
 * В боевом режиме (заданы PAYKEEPER_LOGIN/PASSWORD) invoice_url ведёт на реальную
 * форму PayKeeper, и эта страница недоступна (notFound). В mock-режиме initPayment
 * отдаёт сюда абсолютный URL с orderId/invoiceId/amount/returnUrl, и покупатель
 * имитирует оплату:
 *  - «Оплатить (демо)» → confirmMockPayment (строго mock) помечает заказ оплаченным
 *    тем же атомарным путём, что и колбэк, → возврат в магазин (?paid=1);
 *  - «Отмена» → возврат в магазин (?payment=cancelled).
 *
 * Зеркало app/mock/tbank/pay/page.tsx (docs/24 §2).
 */
import { redirect, notFound } from 'next/navigation';
import { getPaykeeperConfig } from '@/lib/payments/paykeeper/config';
import { PaymentService } from '@/lib/payments/paykeeper/service';
import { getStorefrontConfig, normalizeOrigin } from '@/lib/storefront/env';

export const dynamic = 'force-dynamic';

/** mock-режим = не заданы боевые ключи Basic-Auth (эквивалент manager.isMock). */
function isMockMode(): boolean {
  const cfg = getPaykeeperConfig();
  return !cfg.login || !cfg.password;
}

/** Доверенный fallback-URL магазина (первый origin витрины из allowlist). */
export function storefrontFallback(allowed: string[]): string {
  return allowed.length > 0 ? allowed[0]! : '/';
}

/** Безопасно добавляет query-параметр к returnUrl. ANTI-OPEN-REDIRECT. */
export function withParam(url: string, key: string, val: string, allowed: string[]): string {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return storefrontFallback(allowed);
    if (allowed.length > 0 && !allowed.includes(normalizeOrigin(u.origin) ?? '')) {
      return storefrontFallback(allowed);
    }
    u.searchParams.set(key, val);
    return u.toString();
  } catch {
    return storefrontFallback(allowed);
  }
}

function formatRub(amountRub: string): string {
  const n = Number(amountRub);
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 0,
  }).format(Number.isFinite(n) ? n : 0);
}

export default async function MockPayPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  if (!isMockMode()) notFound(); // demo-страница существует только в mock-режиме

  const sp = await searchParams;
  const orderId = sp.orderId ?? '';
  const invoiceId = sp.invoiceId ?? '';
  const amountRub = sp.amount ?? '0';
  const returnUrl = sp.returnUrl ?? '';
  const allowed = getStorefrontConfig().allowedOrigins;

  async function pay() {
    'use server';
    const res = await new PaymentService().confirmMockPayment(orderId, invoiceId);
    if (!returnUrl) redirect(storefrontFallback(allowed));
    redirect(
      res.ok ? withParam(returnUrl, 'paid', '1', allowed) : withParam(returnUrl, 'payment', 'failed', allowed),
    );
  }

  async function cancel() {
    'use server';
    redirect(returnUrl ? withParam(returnUrl, 'payment', 'cancelled', allowed) : storefrontFallback(allowed));
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-neutral-100 p-4">
      <div className="w-full max-w-md bg-white rounded-xl shadow-sm border border-neutral-200 p-8">
        <div className="mb-6">
          <p className="text-xs uppercase tracking-widest text-amber-600 font-medium">Демо-оплата · тестовый режим</p>
          <h1 className="text-xl font-semibold text-neutral-900 mt-2">Оплата заказа</h1>
          <p className="text-sm text-neutral-500 mt-1">
            Боевые ключи PayKeeper не подключены — это имитация платёжной страницы для демонстрации.
          </p>
        </div>

        <div className="rounded-lg bg-neutral-50 border border-neutral-200 p-4 space-y-2 mb-6">
          <div className="flex justify-between text-sm">
            <span className="text-neutral-500">Заказ</span>
            <span className="font-medium text-neutral-900">{orderId || '—'}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-neutral-500">К оплате</span>
            <span className="font-semibold text-neutral-900">{formatRub(amountRub)}</span>
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

        {storefrontFallback(allowed) !== '/' ? (
          <p className="text-center mt-4">
            <a
              href={storefrontFallback(allowed)}
              className="text-xs text-neutral-500 underline hover:text-neutral-700"
            >
              Вернуться в магазин
            </a>
          </p>
        ) : null}

        <p className="text-[11px] text-neutral-400 mt-6 text-center">
          После подключения боевых ключей PayKeeper оплата пойдёт через настоящий платёжный шлюз.
        </p>
      </div>
    </main>
  );
}
