'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';

import {
  AUDIT_ACTION_LABELS,
  AUDIT_ENTITY_TYPE_LABELS,
} from '@/lib/admin/audit-labels';

/**
 * Панель фильтров журнала аудита (тупик C1, docs/20). Зеркало OrderFilters:
 * состояние живёт в URL (shareable), сабмит формирует querystring и навигирует —
 * серверная страница перечитывает записи с теми же условиями. Сброс возвращает на
 * первую страницу без фильтров. Словари действий/сущностей — общие AUDIT_*_LABELS
 * (мультитенантно, без хардкода под магазин).
 */
export function AuditFilters() {
  const t = useTranslations();
  const router = useRouter();
  const params = useSearchParams();

  const [dateFrom, setDateFrom] = useState(params.get('dateFrom') ?? '');
  const [dateTo, setDateTo] = useState(params.get('dateTo') ?? '');
  const [action, setAction] = useState(params.get('action') ?? '');
  const [entityType, setEntityType] = useState(params.get('entityType') ?? '');
  const [actor, setActor] = useState(params.get('actor') ?? '');

  function submit(e: FormEvent) {
    e.preventDefault();
    const next = new URLSearchParams();
    if (dateFrom) next.set('dateFrom', dateFrom);
    if (dateTo) next.set('dateTo', dateTo);
    if (action) next.set('action', action);
    if (entityType) next.set('entityType', entityType);
    if (actor.trim()) next.set('actor', actor.trim());
    // page намеренно не переносим — смена фильтров сбрасывает на первую страницу.
    router.push(`/admin/audit${next.toString() ? `?${next.toString()}` : ''}`);
  }

  function reset() {
    setDateFrom('');
    setDateTo('');
    setAction('');
    setEntityType('');
    setActor('');
    router.push('/admin/audit');
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-lg border border-gray-200 bg-gray-50 p-4"
      aria-label={t('audit.auditFilters.ariaLabel')}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <label htmlFor="af-from" className="block text-xs font-medium text-gray-600">
            {t('audit.auditFilters.dateFrom')}
          </label>
          <input
            id="af-from"
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </div>

        <div>
          <label htmlFor="af-to" className="block text-xs font-medium text-gray-600">
            {t('audit.auditFilters.dateTo')}
          </label>
          <input
            id="af-to"
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </div>

        <div>
          <label htmlFor="af-actor" className="block text-xs font-medium text-gray-600">
            {t('audit.auditFilters.actor')}
          </label>
          <input
            id="af-actor"
            type="search"
            value={actor}
            onChange={(e) => setActor(e.target.value)}
            placeholder={t('audit.auditFilters.actorPlaceholder')}
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </div>

        <div>
          <label htmlFor="af-action" className="block text-xs font-medium text-gray-600">
            {t('audit.auditFilters.action')}
          </label>
          <select
            id="af-action"
            value={action}
            onChange={(e) => setAction(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          >
            <option value="">{t('audit.auditFilters.anyAction')}</option>
            {Object.entries(AUDIT_ACTION_LABELS).map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="af-entity" className="block text-xs font-medium text-gray-600">
            {t('audit.auditFilters.entityType')}
          </label>
          <select
            id="af-entity"
            value={entityType}
            onChange={(e) => setEntityType(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          >
            <option value="">{t('audit.auditFilters.anyEntity')}</option>
            {Object.entries(AUDIT_ENTITY_TYPE_LABELS).map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={reset}
          className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
        >
          {t('common.actions.reset')}
        </button>
        <button
          type="submit"
          className="rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700"
        >
          {t('common.actions.apply')}
        </button>
      </div>
    </form>
  );
}
