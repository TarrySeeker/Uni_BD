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

/**
 * Доверенный fallback-URL магазина (баг #20 аудита тупиков). РАНЬШЕ при returnUrl
 * вне allowlist страница молча редиректила на '/' — корень Admik, а не витрина
 * покупателя (тупик «оплатил и попал не туда»). Теперь fallback — ПЕРВЫЙ
 * доверенный origin витрины из STOREFRONT_ALLOWED_ORIGINS (уже валидирован, без
 * open-redirect-риска). Пустой allowlist = «demo без секретов» → '/' как раньше
 * (отдельной витрины для проверки нет).
 */
export function storefrontFallback(allowed: string[]): string {
  return allowed.length > 0 ? allowed[0]! : '/';
}

/** Безопасно добавляет query-параметр к returnUrl. ANTI-OPEN-REDIRECT: origin
 *  returnUrl должен быть в allowlist витрины (STOREFRONT_ALLOWED_ORIGINS) — иначе
 *  доверенный fallback (storefrontFallback), а НЕ тупиковый '/' домена Admik.
 *  Не-http(s)/битый URL → тоже доверенный fallback. (Страница публична → returnUrl
 *  из query нельзя слепо использовать для редиректа.) */
export function withParam(url: string, key: string, val: string, allowed: string[]): string {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return storefrontFallback(allowed);
    // Allowlist применяем ТОЛЬКО когда он задан. Пустой STOREFRONT_ALLOWED_ORIGINS —
    // это режим «demo без секретов» (auth.ts: доступ открыт всем); жёсткая проверка
    // тогда отправляла бы ЛЮБОЙ легитимный возврат в fallback и ломала demo-оплату.
    if (allowed.length > 0 && !allowed.includes(normalizeOrigin(u.origin) ?? '')) {
      return storefrontFallback(allowed);
    }
    u.searchParams.set(key, val);
    return u.toString();
  } catch {
    return storefrontFallback(allowed);
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
    // Пустой returnUrl → доверенный origin витрины, а не корень Admik (фикс #20
    // ревью Batch 6: '/' — тупик в домене админки для покупателя).
    if (!returnUrl) redirect(storefrontFallback(allowed));
    redirect(res.ok ? withParam(returnUrl, 'paid', '1', allowed) : withParam(returnUrl, 'payment', 'failed', allowed));
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

        {/* Баг #20: явный безопасный путь назад в магазин (на доверенный origin
            витрины), если возврат по returnUrl не сработает. Показываем только при
            заданном allowlist — иначе ссылка вела бы на корень Admik (тупик). */}
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
          После подключения боевых ключей Т-Банк оплата пойдёт через настоящий платёжный шлюз.
        </p>
      </div>
    </main>
  );
}
