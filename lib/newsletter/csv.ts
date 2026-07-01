/**
 * Формирование CSV для экспорта адресов подписчиков (раздел «Подписчики»).
 *
 * Чистый модуль (без БД/Next) — тестируется юнит-тестом. Используется CSV-роутом
 * экспорта (app/admin/(panel)/subscribers/export/route.ts).
 *
 * RFC 4180-квотирование и анти-CSV-инъекция вынесены в общий escapeField
 * (lib/admin/csv.ts) — единый с экспортом заявок, без дублирования защиты.
 */
import { escapeField } from '@/lib/admin/csv';

export { CSV_MIME } from '@/lib/admin/csv';

/**
 * Поля строки CSV (только то, что нужно владельцу для рассылки/учёта). Тип
 * самодостаточен (не импортирует repository), чтобы модуль можно было безопасно
 * использовать и на клиенте (кнопка «Скачать CSV») без затягивания серверного sql.
 */
export interface CsvSubscriber {
  email: string;
  status: string;
  created_at: Date;
}

/**
 * Формирует CSV-текст: заголовок + строки. Дата — ISO-8601 (UTC) для
 * однозначности и совместимости с любыми таблицами/CRM.
 */
export function subscribersToCsv(rows: CsvSubscriber[]): string {
  const header = 'email,status,created_at';
  const lines = rows.map((r) =>
    [
      escapeField(r.email),
      escapeField(r.status),
      escapeField(r.created_at.toISOString()),
    ].join(','),
  );
  return [header, ...lines].join('\r\n');
}
