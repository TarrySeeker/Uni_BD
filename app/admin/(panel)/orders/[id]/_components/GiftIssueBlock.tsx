'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import type { ActionResult } from '@/lib/server/action';

import { errorMessage } from '../../_components/action-result';
import { GiftStatusBadge } from '../../../gift-certificates/_components/GiftStatusBadge';
import { issueGiftFromOrderAction } from './gift-actions';

type Fail = Extract<ActionResult<unknown>, { ok: false }>;

/** Позиция заказа, по которой можно выпустить сертификат (данные посчитаны сервером). */
export interface GiftIssueItemView {
  id: string;
  name: string;
  /** Номинал = фактически уплаченная сумма позиции (снимок order_items). */
  faceValue: string;
  quantity: number;
  /** Насколько уверенно позиция выглядит сертификатом: маркер снимка / имя / нет. */
  hint: 'marked' | 'name' | 'none';
}

/** Уже выпущенный по заказу сертификат. */
export interface IssuedCertificateView {
  id: string;
  code: string;
  initialAmount: string;
  orderItemId: string | null;
  recipient: string;
  /** Потрачено с кода (уже с валютой) — менеджеру важно ДО возврата (ТЗ п.11). */
  spentLabel: string;
  status: string;
}

/**
 * Блок «Подарочные сертификаты» в карточке заказа (ТЗ владельца п.7).
 *
 * Что делает: показывает уже выпущенные по заказу коды и даёт кнопку «Выпустить
 * сертификат по заказу» для позиции. Номинал НЕ вводится — сервер берёт его из
 * ценового снимка позиции (сколько покупатель фактически заплатил).
 *
 * Почему кнопка доступна для ЛЮБОЙ позиции, а «сертификатность» — лишь подсказка:
 * надёжного признака «товар — сертификат», общего для всех магазинов платформы,
 * в каталоге нет (категория переименуема, ETL пересобираем). Признак берётся из
 * НЕИЗМЕННОГО снимка позиции (маркер в attributes_snapshot, вторично — имя), а
 * решение остаётся за администратором. Повторный выпуск по позиции невозможен —
 * его блокирует частичный UNIQUE (issued_order_item_id) миграции 0054.
 */
export function GiftIssueBlock({
  orderId,
  items,
  issued,
  canWrite,
  warnings = [],
}: {
  orderId: string;
  items: readonly GiftIssueItemView[];
  issued: readonly IssuedCertificateView[];
  canWrite: boolean;
  /** Готовые строки giftRefundWarnings (считает сервер, kind='revoked'). */
  warnings?: readonly string[];
}) {
  const router = useRouter();
  const t = useTranslations();
  const [error, setError] = useState<Fail | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pendingItemId, setPendingItemId] = useState<string | null>(null);
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [recipientName, setRecipientName] = useState('');
  const [recipientEmail, setRecipientEmail] = useState('');

  const issuedItemIds = new Set(issued.map((c) => c.orderItemId).filter(Boolean));

  async function issue(itemId: string) {
    setPendingItemId(itemId);
    setError(null);
    setSuccess(null);
    const result = await issueGiftFromOrderAction({
      orderId,
      orderItemId: itemId,
      recipient: { name: recipientName, email: recipientEmail },
    });
    setPendingItemId(null);
    if (result.ok) {
      setSuccess(
        t('orders.detailGiftIssueBlock.issuedSuccess', {
          code: result.data.code,
          amount: result.data.initialAmount,
        }),
      );
      setOpenItemId(null);
      setRecipientName('');
      setRecipientEmail('');
      router.refresh();
    } else {
      setError(result);
    }
  }

  return (
    <section className="mt-6 rounded-lg border border-gray-200 bg-white">
      <h2 className="border-b border-gray-200 px-4 py-3 text-sm font-semibold text-gray-800">
        {t('orders.detailGiftIssueBlock.heading')}
      </h2>

      <div className="px-4 py-3">
        {error ? (
          <div role="alert" className="mb-3 rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
            {errorMessage(error)}
          </div>
        ) : null}
        {success ? (
          <div role="status" className="mb-3 rounded border border-green-200 bg-green-50 p-2 text-sm text-green-700">
            {success}
          </div>
        ) : null}

        {warnings.length > 0 ? (
          <div
            role="alert"
            className="mb-3 rounded border border-amber-200 bg-amber-50 p-2 text-sm text-amber-800"
          >
            <ul className="list-disc pl-5">
              {warnings.map((msg) => (
                <li key={msg}>{msg}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {issued.length > 0 ? (
          <ul className="mb-3 space-y-1 text-sm">
            {issued.map((c) => (
              <li key={c.id}>
                <Link href={`/admin/gift-certificates/${c.id}`} className="font-mono text-blue-700 hover:underline">
                  {c.code}
                </Link>{' '}
                <span className="text-gray-600">{t('orders.detailGiftIssueBlock.forAmount', { amount: c.initialAmount })}</span>
                <span className="text-gray-500"> · {t('orders.detailGiftIssueBlock.recipientLine', { recipient: c.recipient })}</span>
                <span className="text-gray-500"> · {t('orders.detailGiftIssueBlock.spentLine', { spent: c.spentLabel })}</span>{' '}
                <GiftStatusBadge status={c.status} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="mb-3 text-sm text-gray-500">{t('orders.detailGiftIssueBlock.noneIssued')}</p>
        )}

        {!canWrite ? (
          <p className="text-xs text-gray-500">{t('orders.detailGiftIssueBlock.needWritePermission')}</p>
        ) : (
          <ul className="divide-y divide-gray-100 text-sm">
            {items.map((it) => {
              const already = issuedItemIds.has(it.id);
              return (
                <li key={it.id} className="py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-gray-800">
                      {it.name}
                      {it.hint !== 'none' ? (
                        <span className="ml-2 rounded bg-violet-100 px-1.5 py-0.5 text-xs text-violet-700">
                          {t('orders.detailGiftIssueBlock.looksLikeCertificate')}
                        </span>
                      ) : null}
                      <span className="ml-2 text-xs text-gray-500">{t('orders.detailGiftIssueBlock.faceValue', { value: it.faceValue })}</span>
                    </span>
                    {already ? (
                      <span className="text-xs text-gray-500">{t('orders.detailGiftIssueBlock.alreadyIssued')}</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setOpenItemId(openItemId === it.id ? null : it.id)}
                        className="rounded border border-gray-300 px-3 py-1 text-xs font-medium text-gray-800 hover:bg-gray-50"
                      >
                        {t('orders.detailGiftIssueBlock.issueButton')}
                      </button>
                    )}
                  </div>

                  {openItemId === it.id && !already ? (
                    <div className="mt-2 rounded border border-gray-200 bg-gray-50 p-3">
                      <p className="text-xs text-gray-600">
                        {t('orders.detailGiftIssueBlock.faceValueHint', { value: it.faceValue })}
                      </p>
                      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <div>
                          <label htmlFor={`rc-name-${it.id}`} className="block text-xs text-gray-500">
                            {t('orders.detailGiftIssueBlock.recipientNameLabel')}
                          </label>
                          <input
                            id={`rc-name-${it.id}`}
                            value={recipientName}
                            onChange={(e) => setRecipientName(e.target.value)}
                            className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm"
                          />
                        </div>
                        <div>
                          <label htmlFor={`rc-mail-${it.id}`} className="block text-xs text-gray-500">
                            {t('orders.detailGiftIssueBlock.recipientEmailLabel')}
                          </label>
                          <input
                            id={`rc-mail-${it.id}`}
                            value={recipientEmail}
                            onChange={(e) => setRecipientEmail(e.target.value)}
                            className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm"
                          />
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => issue(it.id)}
                        disabled={pendingItemId === it.id}
                        className="mt-3 rounded-md bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700 disabled:opacity-50"
                      >
                        {pendingItemId === it.id ? t('orders.detailGiftIssueBlock.issuing') : t('orders.detailGiftIssueBlock.issueConfirm')}
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
