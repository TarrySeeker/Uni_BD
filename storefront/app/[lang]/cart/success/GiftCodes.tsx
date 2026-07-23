'use client';

/**
 * Блок «Ваш подарочный сертификат» на странице успеха (ТЗ владельца п.11).
 *
 * КЛИЕНТСКИЙ и только клиентский: код сертификата приходит отдельным запросом к
 * GET /orders/:number/gift-codes по токену заказа, ответ помечен no-store и не
 * должен попадать ни в SSR-разметку, ни в кеш страницы.
 *
 * 🔴 Никаких серверных импортов здесь быть не может (границу сторожит guard-тест):
 * только React, строки словаря (обычный объект, приходит пропсом) и fetch.
 *
 * Три состояния (см. state ответа):
 *  - none    — блок не рендерится вовсе;
 *  - pending — «оплата подтверждается, код появится автоматически» + опрос;
 *  - ready   — код(ы) моноширинным шрифтом, номинал, срок, кнопка «Скопировать».
 */

import { useCallback, useEffect, useState } from 'react';

/** Пауза между опросами (оплата подтверждается асинхронным вебхуком банка). */
export const GIFT_CODES_POLL_INTERVAL_MS = 5000;
/** Максимум попыток: 24 × 5 c ≈ 2 минуты, дальше — честное «задерживается». */
export const GIFT_CODES_POLL_MAX_ATTEMPTS = 24;

interface GiftCodeView {
  code: string;
  amount: string;
  remaining: string;
  currency: string;
  validUntil: string | null;
}

interface GiftCodesPayload {
  state: 'none' | 'pending' | 'ready';
  codes: GiftCodeView[];
}

/** Строки блока (plain-объект из словаря; функций в пропсах быть не должно). */
export interface GiftCodesStrings {
  giftTitle: string;
  giftPending: string;
  giftRefresh: string;
  giftTimeout: string;
  giftAmount: string;
  giftRemaining: string;
  giftValidUntil: string;
  giftForever: string;
  giftCopy: string;
  giftCopied: string;
  giftWarning: string;
}

const API_BASE = (process.env.NEXT_PUBLIC_ADMIK_API_URL ?? '').replace(/\/$/, '');

async function fetchGiftCodes(
  number: string,
  token: string,
): Promise<GiftCodesPayload | null> {
  try {
    const res = await fetch(
      `${API_BASE}/api/storefront/v1/orders/${encodeURIComponent(number)}/gift-codes` +
        `?token=${encodeURIComponent(token)}`,
      { headers: { Accept: 'application/json' }, cache: 'no-store' },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: GiftCodesPayload };
    return body?.data ?? null;
  } catch {
    return null;
  }
}

/**
 * Стили блока держим ЛОКАЛЬНО (inline + один <style> с keyframes), а не в общем
 * public/storefront.css: правка общего файла витрины принадлежит другим трекам,
 * а блок должен выглядеть законченно сам по себе. Переиспользуем существующие
 * классы витрины (sf-success__text, sf-summary-row, sf-btn-secondary).
 */
const BLOCK_STYLE: React.CSSProperties = {
  marginTop: 28,
  padding: '18px 20px',
  border: '1px solid #000',
};
const TITLE_STYLE: React.CSSProperties = {
  fontSize: 16,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  margin: '0 0 14px',
};
const CARD_STYLE: React.CSSProperties = { marginBottom: 14 };
const CODE_STYLE: React.CSSProperties = {
  display: 'block',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 22,
  letterSpacing: '0.14em',
  wordBreak: 'break-all',
  padding: '10px 12px',
  background: '#f4f4f4',
  marginBottom: 10,
};
const PULSE_KEYFRAMES = '@keyframes sf-gift-pulse{0%,100%{opacity:.25}50%{opacity:1}}';

function formatAmount(value: string, currency: string): string {
  const n = Number(value);
  const amount = Number.isFinite(n) ? n.toLocaleString('ru-RU') : value;
  return `${amount} ${currency}`;
}

export default function GiftCodes({
  number,
  token,
  strings,
  locale,
}: {
  number: string;
  token: string;
  strings: GiftCodesStrings;
  locale: string;
}) {
  const [payload, setPayload] = useState<GiftCodesPayload | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  // Ручное «Обновить» перезапускает цикл опроса (новый round → новый эффект).
  const [round, setRound] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;

    async function tick(): Promise<void> {
      setBusy(true);
      const data = await fetchGiftCodes(number, token);
      if (cancelled) return;
      setBusy(false);
      if (data) setPayload(data);
      // Сетевой сбой трактуем как «ещё не готово» — но он тоже расходует попытки.
      if (data && data.state !== 'pending') return;
      attempts += 1;
      if (attempts >= GIFT_CODES_POLL_MAX_ATTEMPTS) {
        setTimedOut(true);
        return;
      }
      timer = setTimeout(() => void tick(), GIFT_CODES_POLL_INTERVAL_MS);
    }

    setTimedOut(false);
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [number, token, round]);

  const copy = useCallback((code: string) => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(code);
    });
  }, []);

  // Состояние 3: сертификатов в заказе нет (или заказ отменён) — блока нет вовсе.
  if (!payload || payload.state === 'none') return null;

  if (payload.state === 'ready' && payload.codes.length > 0) {
    return (
      <div className="sf-success__gift" style={BLOCK_STYLE}>
        <h2 className="sf-success__gift-title" style={TITLE_STYLE}>
          {strings.giftTitle}
        </h2>
        {payload.codes.map((c) => (
          <div className="sf-success__gift-card" key={c.code} style={CARD_STYLE}>
            <code className="sf-success__gift-code" style={CODE_STYLE}>
              {c.code}
            </code>
            <button
              type="button"
              className="sf-btn-secondary sf-success__gift-copy"
              onClick={() => copy(c.code)}
            >
              {copied === c.code ? strings.giftCopied : strings.giftCopy}
            </button>
            <div className="sf-summary-row">
              <span>{strings.giftAmount}</span>
              <span>{formatAmount(c.amount, c.currency)}</span>
            </div>
            {c.remaining !== c.amount ? (
              <div className="sf-summary-row">
                <span>{strings.giftRemaining}</span>
                <span>{formatAmount(c.remaining, c.currency)}</span>
              </div>
            ) : null}
            <div className="sf-summary-row">
              <span>{strings.giftValidUntil}</span>
              <span>
                {c.validUntil
                  ? new Date(c.validUntil).toLocaleDateString(locale)
                  : strings.giftForever}
              </span>
            </div>
          </div>
        ))}
        <p className="sf-field__hint sf-success__gift-warning">{strings.giftWarning}</p>
      </div>
    );
  }

  // Состояние 1: сертификат куплен, код ещё не подтверждён.
  return (
    <div className="sf-success__gift" style={BLOCK_STYLE}>
      <style>{PULSE_KEYFRAMES}</style>
      <h2 className="sf-success__gift-title" style={TITLE_STYLE}>
        {strings.giftTitle}
      </h2>
      <p className="sf-success__text" aria-live="polite">
        {timedOut ? strings.giftTimeout : strings.giftPending}
        {!timedOut ? (
          <span
            className="sf-success__gift-spinner"
            aria-hidden="true"
            style={{
              display: 'inline-block',
              marginLeft: 8,
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: 'currentColor',
              animation: busy ? 'sf-gift-pulse 1s ease-in-out infinite' : 'none',
              opacity: busy ? 1 : 0.3,
            }}
          />
        ) : null}
      </p>
      <button
        type="button"
        className="sf-btn-secondary"
        onClick={() => setRound((r) => r + 1)}
        disabled={busy}
      >
        {strings.giftRefresh}
      </button>
    </div>
  );
}
