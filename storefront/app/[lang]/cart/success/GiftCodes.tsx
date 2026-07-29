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
 *
 * 🔴 СБОЙ ЗАПРОСА — ЧЕТВЁРТОЕ СОСТОЯНИЕ, А НЕ ПУСТОТА (находка аудита №12).
 * Раньше fetchGiftCodes глушил и !res.ok, и исключение в один и тот же null, а
 * ранний выход «нет payload → return null» стоял до обеих веток рендера. При
 * первом же 429 (собственное ведро эндпоинта — 40 запросов/мин на IP) покупатель
 * не видел НИЧЕГО: ни кода, ни объяснения, ни таймаута — блок бесследно исчезал,
 * хотя деньги за сертификат уже уплачены. Теперь запрос возвращает размеченное
 * объединение, а блок остаётся на экране и объясняет происходящее.
 */

import { useCallback, useEffect, useState } from 'react';
import { formatPrice, type NumberFormatOpts } from '@/lib/format';

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
  /** Сработало ведро rate-limit эндпоинта (429) — надо просто подождать. */
  giftRateLimited: string;
  /** Прочий сбой запроса (сеть/5xx) — код не потерян, попробуйте обновить. */
  giftError: string;
}

/** Почему запрос не дал данных. Различаем, потому что советы покупателю разные. */
export type GiftCodesFailure = 'rate_limited' | 'error';

/**
 * Результат обращения к эндпоинту — РАЗМЕЧЕННОЕ объединение.
 * Прежний `Payload | null` не давал отличить «кодов нет» от «нас не пустили»,
 * из-за чего 429 выглядел как отсутствие сертификата (находка №12).
 */
type FetchResult =
  | { kind: 'ok'; payload: GiftCodesPayload }
  | { kind: 'rate_limited' }
  | { kind: 'error' };

const API_BASE = (process.env.NEXT_PUBLIC_ADMIK_API_URL ?? '').replace(/\/$/, '');

async function fetchGiftCodes(number: string, token: string): Promise<FetchResult> {
  try {
    const res = await fetch(
      `${API_BASE}/api/storefront/v1/orders/${encodeURIComponent(number)}/gift-codes` +
        `?token=${encodeURIComponent(token)}`,
      { headers: { Accept: 'application/json' }, cache: 'no-store' },
    );
    // 429 — своё ведро эндпоинта (40/мин на IP). Это НЕ ошибка покупателя и не
    // отсутствие кода: надо подождать, а не прятать блок.
    if (res.status === 429) return { kind: 'rate_limited' };
    if (!res.ok) return { kind: 'error' };
    const body = (await res.json()) as { data?: GiftCodesPayload };
    if (!body?.data) return { kind: 'error' };
    return { kind: 'ok', payload: body.data };
  } catch {
    // Сеть/парсинг — тоже сбой, а не «сертификата нет».
    return { kind: 'error' };
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

/**
 * 🔴 Аудит minor №9. Раньше здесь склеивалось `${n.toLocaleString('ru-RU')} ${currency}`:
 * формат чисел был зашит русским, знаки после запятой не управлялись настройками, а
 * рядом с валютой печатался КОД ('RUB'), а не символ магазина — три разных правила
 * показа денег на одной витрине. Теперь номинал идёт через общий formatPrice, который
 * знает и локаль формата, и знаки после запятой из настроек магазина.
 */
function formatAmount(
  value: string,
  currency: string,
  fmt: NumberFormatOpts | undefined,
  symbol: string | null,
): string {
  const n = Number(value);
  // Нечисловой номинал (сервер прислал мусор) показываем как есть — не выдумываем.
  if (!Number.isFinite(n)) return `${value} ${symbol ?? currency}`.trim();
  return formatPrice(n, currency, symbol, fmt);
}

export default function GiftCodes({
  number,
  token,
  strings,
  locale,
  numberFormat,
  currencySymbol = null,
}: {
  number: string;
  token: string;
  strings: GiftCodesStrings;
  locale: string;
  /**
   * 🔴 №9 — формат чисел МАГАЗИНА (currency.locale/fractionDigits из настроек).
   * Опционально: без него formatPrice отдаёт исторический вид (ru-RU, 0 знаков),
   * поэтому старый вызов блока не ломается.
   */
  numberFormat?: NumberFormatOpts;
  /** Символ валюты магазина (₽/€/$); null → показываем код валюты, как раньше. */
  currencySymbol?: string | null;
}) {
  const [payload, setPayload] = useState<GiftCodesPayload | null>(null);
  /** Последний сбой запроса; null — сбоя нет (находка №12). */
  const [failure, setFailure] = useState<GiftCodesFailure | null>(null);
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
      const res = await fetchGiftCodes(number, token);
      if (cancelled) return;
      setBusy(false);

      if (res.kind === 'rate_limited') {
        // Останавливаем опрос: продолжать долбить ведро значит никогда его не
        // разгрузить. Покупателю объясняем и оставляем кнопку «Обновить».
        setFailure('rate_limited');
        return;
      }
      if (res.kind === 'error') {
        // Разовый сбой не должен гасить уже показанный код: payload не трогаем,
        // но ошибку показываем и продолжаем опрос до исчерпания попыток.
        setFailure('error');
      } else {
        setFailure(null);
        setPayload(res.payload);
        if (res.payload.state !== 'pending') return;
      }

      attempts += 1;
      if (attempts >= GIFT_CODES_POLL_MAX_ATTEMPTS) {
        setTimedOut(true);
        return;
      }
      timer = setTimeout(() => void tick(), GIFT_CODES_POLL_INTERVAL_MS);
    }

    setTimedOut(false);
    setFailure(null);
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

  /**
   * Состояние 3: сертификатов в заказе нет (или заказ отменён) — блока нет вовсе.
   *
   * 🔴 Находка №12: проверка на СБОЙ обязана стоять ПЕРЕД этим выходом. Раньше
   * ранний `return null` срабатывал и когда данных нет из-за ошибки запроса —
   * покупатель, уплативший за сертификат, не видел ни кода, ни причины.
   */
  if (!failure && (!payload || payload.state === 'none')) return null;

  /*
    Код уже получен — показываем его, даже если ПОСЛЕДУЮЩИЙ опрос сорвался:
    сертификат никуда не делся, а прятать выданный код из-за сетевой икоты
    хуже, чем не показать сообщение об ошибке. Проверка `payload &&` здесь
    обязательна: при сбое до первого успешного ответа payload ещё null, и
    именно этот путь раньше уводил в ранний return (находка №12).
  */
  if (payload && payload.state === 'ready' && payload.codes.length > 0) {
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
              <span>{formatAmount(c.amount, c.currency, numberFormat, currencySymbol)}</span>
            </div>
            {c.remaining !== c.amount ? (
              <div className="sf-summary-row">
                <span>{strings.giftRemaining}</span>
                <span>{formatAmount(c.remaining, c.currency, numberFormat, currencySymbol)}</span>
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

  /**
   * Состояние 1: сертификат куплен, код ещё не подтверждён — ИЛИ запрос сорвался.
   * Текст выбирается по приоритету: сбой > таймаут > обычное ожидание. Сбой
   * приоритетнее, потому что он объясняет, почему опрос остановился.
   */
  const message =
    failure === 'rate_limited'
      ? strings.giftRateLimited
      : failure === 'error'
        ? strings.giftError
        : timedOut
          ? strings.giftTimeout
          : strings.giftPending;
  const stalled = failure !== null || timedOut;

  return (
    <div className="sf-success__gift" style={BLOCK_STYLE}>
      <style>{PULSE_KEYFRAMES}</style>
      <h2 className="sf-success__gift-title" style={TITLE_STYLE}>
        {strings.giftTitle}
      </h2>
      <p className="sf-success__text" aria-live="polite" role={failure ? 'alert' : undefined}>
        {message}
        {!stalled ? (
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
