'use client';

import { useState } from 'react';

import type { ActionResult } from '@/lib/server/action';
import type { WebhookSubscriptionReport } from '@/lib/cdek/services/webhook';

import { ensureCdekWebhookSubscription } from './webhook-actions';

/**
 * Карточка «Подписка на вебхуки СДЭК» раздела /admin/cdek (гэп №2).
 *
 * Кнопка вызывает Server Action ensureCdekWebhookSubscription (идемпотентная
 * проверка/регистрация POST /v2/webhooks) и показывает отчёт: created/kept/
 * deleted/errors. Секрет в URL уже замаскирован на сервере (key=***).
 *
 * Зачем кнопка, а не только cron: СДЭК автоматически удаляет подписку, если
 * эндпоинт не отвечает 200 (24ч) — владелец должен уметь проверить/починить
 * подписку вручную после инцидента, не дожидаясь крона.
 */
export function WebhookSubscriptionCard({ isMock }: { isMock: boolean }) {
  const [report, setReport] = useState<WebhookSubscriptionReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function check() {
    setPending(true);
    setError(null);
    setReport(null);
    const res: ActionResult<WebhookSubscriptionReport> =
      await ensureCdekWebhookSubscription({});
    setPending(false);
    if (res.ok) {
      setReport(res.data);
    } else {
      setError(res.message ?? 'Не удалось проверить подписку (нет доступа или внутренняя ошибка).');
    }
  }

  return (
    <section
      className="mt-6 rounded-lg border border-gray-200 bg-white p-4"
      aria-label="Подписка на вебхуки СДЭК"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-800">Вебхуки СДЭК (push-статусы)</h2>
          <p className="mt-1 text-xs text-gray-500">
            Чтобы статусы доставки приходили автоматически, в СДЭК должна быть
            зарегистрирована подписка ORDER_STATUS на URL этого магазина. Проверка
            идемпотентна: существующая корректная подписка не пересоздаётся.
          </p>
        </div>
        <button
          type="button"
          disabled={pending}
          onClick={check}
          className="rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
        >
          {pending ? 'Проверяем…' : 'Проверить подписку на вебхуки'}
        </button>
      </div>

      {error ? (
        <div role="alert" className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      {report ? (
        report.mock ? (
          <div role="status" className="mt-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            MOCK-режим: боевые ключи СДЭК не заданы — подписка на вебхуки не требуется
            (события эмулируются локально). В боевом режиме проверка выполнит
            регистрацию автоматически.
          </div>
        ) : (
          <div className="mt-3 space-y-2 text-sm">
            {report.targetUrl ? (
              <p className="text-gray-600">
                Целевой URL: <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">{report.targetUrl}</code>
              </p>
            ) : null}
            {report.kept.length > 0 ? (
              <p className="rounded border border-green-200 bg-green-50 p-2 text-green-700">
                Подписка актуальна: {report.kept.map((k) => k.type).join(', ')} — изменения не требуются.
              </p>
            ) : null}
            {report.created.length > 0 ? (
              <p className="rounded border border-green-200 bg-green-50 p-2 text-green-700">
                Создана подписка: {report.created.map((c) => `${c.type} (${c.uuid ?? 'uuid не возвращён'})`).join(', ')}.
              </p>
            ) : null}
            {report.deleted.length > 0 ? (
              <p className="rounded border border-blue-200 bg-blue-50 p-2 text-blue-700">
                Пересоздано (устаревший домен): удалены {report.deleted.map((d) => d.uuid).join(', ')}.
              </p>
            ) : null}
            {report.errors.length > 0 ? (
              <ul className="list-inside list-disc rounded border border-red-200 bg-red-50 p-2 text-red-700">
                {report.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            ) : null}
          </div>
        )
      ) : null}

      {isMock && !report ? (
        <p className="mt-3 text-xs text-amber-700">
          Сейчас модуль в MOCK-режиме — проверка вернёт пояснение без обращения к СДЭК.
        </p>
      ) : null}
    </section>
  );
}
