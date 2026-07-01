import { isLeadStatus, leadStatusLabel, type LeadStatus } from '@/lib/leads/status';

/**
 * Бейдж статуса заявки (new/in_progress/done/spam). Презентационный компонент —
 * образец cms StatusBadge. Неизвестный статус рисуется нейтрально (фолбэк-строка).
 */
const CLASSES: Record<LeadStatus, string> = {
  new: 'bg-blue-100 text-blue-800',
  in_progress: 'bg-amber-100 text-amber-800',
  done: 'bg-green-100 text-green-800',
  spam: 'bg-gray-100 text-gray-600',
};

export function LeadStatusBadge({ status }: { status: string }) {
  const cls = isLeadStatus(status) ? CLASSES[status] : 'bg-gray-100 text-gray-600';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${cls}`}>
      {leadStatusLabel(status)}
    </span>
  );
}
