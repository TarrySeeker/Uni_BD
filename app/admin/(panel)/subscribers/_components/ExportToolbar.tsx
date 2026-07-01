'use client';

import { useState } from 'react';

import { subscribersToCsv } from '@/lib/newsletter/csv';

/**
 * Тулбар экспорта адресов раздела «Подписчики» (устранение тупика владельца).
 *
 * Данные уже на странице (адреса отрисованы под правом orders.read) — экспорт
 * целиком клиентский, без отдельного авторизуемого роута: это операция ЧТЕНИЯ
 * того, что владелец уже видит. Два действия:
 *  • «Скопировать адреса» — все email через запятую в буфер обмена (вставить в
 *    поле «Кому» почтового сервиса / рассыльщика);
 *  • «Скачать CSV» — файл email,status,created_at (RFC 4180 + анти-инъекция),
 *    переиспользуя серверный чистый хелпер subscribersToCsv (единый формат).
 */
export interface ExportRow {
  email: string;
  status: string;
  /** ISO-строка (Date не сериализуется из Server Component в Client как Date). */
  createdAtIso: string;
}

export function ExportToolbar({ rows }: { rows: ExportRow[] }) {
  const [copied, setCopied] = useState(false);

  const emails = rows.map((r) => r.email);

  async function copyEmails() {
    try {
      await navigator.clipboard.writeText(emails.join(', '));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Фолбэк для окружений без Clipboard API (старый браузер / http).
      window.prompt('Скопируйте адреса вручную:', emails.join(', '));
    }
  }

  function downloadCsv() {
    const csv = subscribersToCsv(
      rows.map((r) => ({
        email: r.email,
        status: r.status,
        created_at: new Date(r.createdAtIso),
      })),
    );
    // BOM (﻿) — чтобы Excel корректно открыл UTF-8 (кириллица не «крякозябрит»).
    const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const date = new Date().toISOString().slice(0, 10);
    a.download = `subscribers-${date}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  if (rows.length === 0) return null;

  return (
    <div className="flex gap-2">
      <button
        type="button"
        onClick={copyEmails}
        className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
      >
        {copied ? 'Скопировано' : 'Скопировать адреса'}
      </button>
      <button
        type="button"
        onClick={downloadCsv}
        className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
      >
        Скачать CSV
      </button>
    </div>
  );
}
