/**
 * Формирование CSV для экспорта заявок (раздел «Заявки», C8).
 *
 * Чистый модуль (без БД/Next) — тестируется юнит-тестом и безопасно используется
 * на клиенте (кнопка «Скачать CSV»). Экранирование/анти-инъекция — общий хелпер
 * escapeField (lib/admin/csv.ts), единый с экспортом подписчиков.
 *
 * ВАЖНО: name/contact/message приходят из ПУБЛИЧНОЙ формы витрины (недоверенный
 * ввод), поэтому анти-CSV-инъекция (=,+,-,@) здесь критична.
 */
import { escapeField } from '@/lib/admin/csv';

export { CSV_MIME } from '@/lib/admin/csv';

/**
 * Поля строки CSV заявки. Тип самодостаточен (не импортирует repository), чтобы
 * модуль можно было безопасно тянуть на клиент без затягивания серверного sql.
 */
export interface CsvLead {
  id: string;
  name: string;
  contact: string;
  message: string;
  status: string;
  created_at: Date;
}

/**
 * Формирует CSV-текст: заголовок + строки. Дата — ISO-8601 (UTC) для
 * однозначности и совместимости с любыми таблицами/CRM.
 */
export function leadsToCsv(rows: CsvLead[]): string {
  const header = 'id,name,contact,message,status,created_at';
  const lines = rows.map((r) =>
    [
      escapeField(r.id),
      escapeField(r.name),
      escapeField(r.contact),
      escapeField(r.message),
      escapeField(r.status),
      escapeField(r.created_at.toISOString()),
    ].join(','),
  );
  return [header, ...lines].join('\r\n');
}
