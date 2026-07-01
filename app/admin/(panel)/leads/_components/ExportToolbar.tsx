'use client';

import { useState } from 'react';

import { leadsToCsv } from '@/lib/leads/csv';

/**
 * Тулбар экспорта раздела «Заявки» (C8) — копия паттерна подписчиков.
 *
 * Данные уже на странице (заявки отрисованы под правом orders.read) — экспорт
 * целиком клиентский, без отдельного авторизуемого роута: это операция ЧТЕНИЯ
 * того, что владелец уже видит. Два действия:
 *  • «Скопировать контакты» — все контакты через запятую в буфер обмена;
 *  • «Скачать CSV» — файл id,name,contact,message,status,created_at (RFC 4180 +
 *    анти-инъекция), переиспользуя чистый хелпер leadsToCsv (единый формат).
 */
export interface ExportRow {
  id: string;
  name: string;
  contact: string;
  message: string;
  status: string;
  /** ISO-строка (Date не сериализуется из Server Component в Client как Date). */
  createdAtIso: string;
}

export function ExportToolbar({ rows }: { rows: ExportRow[] }) {
  const [copied, setCopied] = useState(false);

  const contacts = rows.map((r) => r.contact);

  async function copyContacts() {
    try {
      await navigator.clipboard.writeText(contacts.join(', '));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Фолбэк для окружений без Clipboard API (старый браузер / http).
      window.prompt('Скопируйте контакты вручную:', contacts.join(', '));
    }
  }

  function downloadCsv() {
    const csv = leadsToCsv(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        contact: r.contact,
        message: r.message,
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
    a.download = `leads-${date}.csv`;
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
        onClick={copyContacts}
        className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
      >
        {copied ? 'Скопировано' : 'Скопировать контакты'}
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
