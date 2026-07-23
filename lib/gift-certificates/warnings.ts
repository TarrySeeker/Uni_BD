/**
 * Предупреждения менеджеру о возврате заказа с выпущенными сертификатами
 * (ТЗ владельца п.11).
 *
 * ЗАЧЕМ. Возврат заказа гасит выпущенные по нему коды (revokeIssuedGiftsTx:
 * status → 'disabled' для active/depleted). Но потраченная с кода часть номинала
 * уже ушла в другие заказы — вернуть её погашением нельзя. Менеджер должен
 * узнать об этом ДО возврата, а не после.
 *
 * Модуль чистый: без БД, Next и React — считается на сервере и передаётся в UI
 * готовыми строками. Деньги суммируются в целых копейках (lib/orders/money),
 * раздельно по валютам: складывать 100 ₽ и 20 € нельзя.
 */

import { formatPrice } from '@/lib/admin/format';
import { toMinor, fromMinor } from '@/lib/orders/money';

import type { GiftCertificateStatus } from './types';

/** Минимум данных о выпущенном сертификате, нужный для предупреждения. */
export interface IssuedGiftWarningInput {
  code: string;
  /** Потрачено (NUMERIC(14,2) строкой). */
  spentTotal: string;
  currency: string;
  status: GiftCertificateStatus;
}

export interface GiftRefundWarningOptions {
  /**
   * Какие предупреждения нужны: превентивные (до возврата), постфактумные
   * (код уже погашен) или все. По умолчанию — все.
   */
  kind?: 'preventive' | 'revoked' | 'all';
  /**
   * Печатать код целиком. По умолчанию НЕТ: сообщение может попасть в лог, а
   * код сертификата — предъявительский платёжный инструмент. В UI админки
   * раскрытие включается явно.
   */
  revealCode?: boolean;
}

/**
 * Статусы, которые реально погасит возврат — тот же набор, что в UPDATE
 * revokeIssuedGiftsTx. Истёкший/уже отключённый код возврат не трогает, поэтому
 * превентивно о нём не предупреждаем.
 */
const REVOCABLE: readonly GiftCertificateStatus[] = ['active', 'depleted'];

/** Маскирует код до хвоста из 4 символов: '•••1234'. Короткий код — целиком. */
export function maskGiftCode(code: string): string {
  const raw = (code ?? '').trim();
  if (raw.length <= 4) return '••••';
  return `•••${raw.slice(-4)}`;
}

function codeLabel(code: string, revealCode: boolean): string {
  return revealCode ? code : maskGiftCode(code);
}

/** Потраченное в копейках; битое значение → 0 (подсказка UI не должна падать). */
function spentMinor(value: string): number {
  try {
    return toMinor(value);
  } catch {
    return 0;
  }
}

/**
 * Суммы по валютам в порядке первого появления → «1 000 ₽ и 20 €».
 * Пустая карта → пустая строка (сигнал «потраченного нет»).
 */
function formatTotals(totals: Map<string, number>): string {
  return [...totals.entries()]
    .map(([currency, minor]) => formatPrice(fromMinor(minor), currency))
    .join(' и ');
}

/**
 * Строки предупреждений для карточки заказа.
 *
 * Инвариант: при нулевом потраченном ни одна строка не говорит о потраченном —
 * иначе менеджер видит пугающий текст на пустом месте.
 */
export function giftRefundWarnings(
  issued: readonly IssuedGiftWarningInput[],
  options: GiftRefundWarningOptions = {},
): string[] {
  const kind = options.kind ?? 'all';
  const reveal = options.revealCode === true;
  const list = (issued ?? []).filter((c): c is IssuedGiftWarningInput => Boolean(c));

  const out: string[] = [];

  if (kind === 'all' || kind === 'preventive') {
    const live = list.filter((c) => REVOCABLE.includes(c.status));
    if (live.length > 0) {
      const totals = new Map<string, number>();
      for (const c of live) {
        const minor = spentMinor(c.spentTotal);
        if (minor <= 0) continue;
        totals.set(c.currency, (totals.get(c.currency) ?? 0) + minor);
      }
      const spent = formatTotals(totals);
      out.push(
        spent
          ? `По выпущенным сертификатам заказа (${live.length} шт.) уже потрачено ${spent} — ` +
              'при возврате коды будут погашены, потраченное не вернётся.'
          : `При возврате заказа выпущенные по нему коды (${live.length} шт.) будут погашены.`,
      );
    }
  }

  if (kind === 'all' || kind === 'revoked') {
    for (const c of list) {
      if (c.status !== 'disabled') continue;
      const minor = spentMinor(c.spentTotal);
      out.push(
        minor > 0
          ? `Код ${codeLabel(c.code, reveal)} погашен, потрачено было ` +
              `${formatPrice(fromMinor(minor), c.currency)}.`
          : `Код ${codeLabel(c.code, reveal)} погашен.`,
      );
    }
  }

  return out;
}
