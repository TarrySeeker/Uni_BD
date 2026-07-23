import Link from 'next/link';

import { can } from '@/lib/auth/rbac';
import { listGiftCertificates, countGiftCertificates } from '@/lib/gift-certificates';
import { formatDateTime } from '@/lib/admin/order-format';
import { listTruncationNotice } from '@/lib/admin/list-truncation';

import { Forbidden } from '../_components/Forbidden';
import { PageHeader } from '../_components/PageHeader';
import { guardGift } from './_components/guard';
import { GiftStatusBadge } from './_components/GiftStatusBadge';
import { GiftRowActions } from './_components/GiftRowActions';

/**
 * Раздел «Подарочные сертификаты» (docs/24 §5): балансовые сертификаты (номинал
 * списывается частично по нескольким заказам, хранится остаток). Доступ —
 * guardGift (право gift.read; выпуск/деактивация — gift.write). Списание —
 * только из чекаута (4b), в админке не вручную.
 *
 * force-dynamic: читает БД/cookies.
 */
export const dynamic = 'force-dynamic';

const LIST_LIMIT = 200;

/** Снимок стороны сделки одной строкой (имя, иначе email/телефон, иначе прочерк). */
function partyLabel(party: { name: string | null; email: string | null; phone: string | null }): string {
  return party.name ?? party.email ?? party.phone ?? '—';
}

export default async function GiftCertificatesPage() {
  const guard = await guardGift('gift.read');
  if (!guard.ok) {
    if (guard.reason === 'module_disabled') {
      return <Forbidden permission="orders (модуль выключен)" />;
    }
    return <Forbidden permission={guard.permission} />;
  }

  const canWrite = can(guard.user, 'gift.write');
  const [certs, total] = await Promise.all([listGiftCertificates(LIST_LIMIT), countGiftCertificates()]);
  const truncation = listTruncationNotice(certs.length, total, LIST_LIMIT);

  return (
    <div className="max-w-6xl">
      <PageHeader
        title="Подарочные сертификаты"
        subtitle={`Балансовые сертификаты: номинал списывается частично по нескольким заказам, хранится остаток. Всего: ${total}.`}
        breadcrumbs={[{ label: 'Сертификаты' }]}
        action={
          canWrite ? (
            <Link
              href="/admin/gift-certificates/new"
              className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
            >
              Выпустить
            </Link>
          ) : undefined
        }
      />

      {truncation ? (
        <p role="status" className="mt-4 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {truncation}.
        </p>
      ) : null}

      {certs.length === 0 ? (
        <p className="mt-6 text-sm text-gray-600">Пока нет сертификатов.</p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-gray-500">
                <th className="px-4 py-2 font-medium">Код</th>
                <th className="px-4 py-2 font-medium">Наименование</th>
                <th className="px-4 py-2 font-medium">Кто купил</th>
                <th className="px-4 py-2 font-medium">На чьё имя</th>
                <th className="px-4 py-2 font-medium">Номинал</th>
                <th className="px-4 py-2 font-medium">Потрачено</th>
                <th className="px-4 py-2 font-medium">Остаток</th>
                <th className="px-4 py-2 font-medium">Действует до</th>
                <th className="px-4 py-2 font-medium">Статус</th>
                <th className="px-4 py-2 font-medium">Действия</th>
              </tr>
            </thead>
            <tbody>
              {certs.map((c) => (
                <tr key={c.id} className="border-t border-gray-100 align-top">
                  <td className="px-4 py-2 font-mono text-gray-900">
                    <Link href={`/admin/gift-certificates/${c.id}`} className="text-blue-700 hover:underline">
                      {c.code}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-gray-700">{c.name || '—'}</td>
                  <td className="px-4 py-2 text-gray-700">
                    {partyLabel(c.purchaser)}
                    {c.issuedOrderId ? (
                      <div className="text-xs text-gray-400">по заказу</div>
                    ) : null}
                  </td>
                  <td className="px-4 py-2 text-gray-700">{partyLabel(c.recipient)}</td>
                  <td className="whitespace-nowrap px-4 py-2 text-gray-900">{c.initialAmount}</td>
                  <td className="whitespace-nowrap px-4 py-2 text-gray-600">{c.spentTotal}</td>
                  <td className="whitespace-nowrap px-4 py-2 font-medium text-gray-900">{c.remaining}</td>
                  <td className="whitespace-nowrap px-4 py-2 text-gray-600">
                    {c.validUntil ? formatDateTime(c.validUntil) : 'бессрочно'}
                  </td>
                  <td className="px-4 py-2">
                    <GiftStatusBadge status={c.status} />
                  </td>
                  <td className="px-4 py-2">
                    <GiftRowActions id={c.id} status={c.status} canWrite={canWrite} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
