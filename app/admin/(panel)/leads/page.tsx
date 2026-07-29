import { Forbidden } from '../_components/Forbidden';
import { PageHeader } from '../_components/PageHeader';
import { guardLeads } from './_components/guard';
import { LeadStatusBadge } from './_components/LeadStatusBadge';
import { LeadRowActions } from './_components/LeadRowActions';
import { LeadAnswerForm } from './_components/LeadAnswerForm';
import { ExportToolbar } from './_components/ExportToolbar';
import { listLeads, countLeads } from '@/lib/leads/repository';
import { leadSourceLabel } from '@/lib/leads/schemas';
import { formatDateTime } from '@/lib/admin/order-format';
import { getShopTimeZone } from '@/lib/admin/timezone';
import { listTruncationNotice } from '@/lib/admin/list-truncation';
import { getStorage } from '@/lib/storage';
import { getTranslations } from 'next-intl/server';

/**
 * Раздел «Заявки» (G-09): сообщения с формы обратной связи витрины. Доступ —
 * guardLeads (право orders.read). force-dynamic: читает БД/cookies.
 */
export const dynamic = 'force-dynamic';

/** Сколько заявок показываем (без пагинации). При превышении — плашка усечения. */
const LIST_LIMIT = 200;

/**
 * Шапка липкая: обёртка таблицы прокручивается и по вертикали (max-h), иначе при
 * LIST_LIMIT строк с инлайновой textarea в каждой обёртка вырастает на десятки
 * тысяч px и горизонтальный скроллбар — он всегда у НИЖНЕЙ кромки обёртки —
 * оказывается недостижим. sticky вешаем на <th>: на <thead>/<tr> он не работает.
 *
 * Нижняя линия — инсет-тенью, а не border-b: при border-collapse:collapse (его
 * ставит preflight) границу рисует таблица, а не ячейка, и со sticky-шапкой она
 * не едет — при прокрутке линия пропадает, строки наезжают на шапку.
 */
const TH =
  'sticky top-0 z-10 shadow-[inset_0_-1px_0_theme(colors.gray.200)] bg-white px-4 py-2 font-medium';

export default async function LeadsPage() {
  const t = await getTranslations();
  // Пояс магазина — один на всю админку (аудит major №26).
  const timeZone = await getShopTimeZone();
  const guard = await guardLeads();
  if (!guard.ok) {
    return <Forbidden permission={guard.permission} />;
  }

  // Список + общее число читаем параллельно: total нужен для счётчика в шапке и
  // для плашки усечения, чтобы владелец не считал, что заявок ровно столько,
  // сколько влезло в лимит (C7, паттерн подписчиков).
  const [leads, total] = await Promise.all([listLeads(LIST_LIMIT), countLeads()]);
  const truncation = listTruncationNotice(leads.length, total, LIST_LIMIT);

  // Ключ вложения (§9) → публичный URL для скачивания (как og:image/логотип).
  const storage = getStorage();

  // Строки для клиентского экспорта (копирование/CSV, C8). Date → ISO для
  // сериализации из Server Component в Client Component (Date приходит строкой).
  const exportRows = leads.map((l) => ({
    id: l.id,
    name: l.name,
    contact: l.contact,
    message: l.message,
    status: l.status,
    createdAtIso: l.created_at.toISOString(),
  }));

  // Без max-w-*: девять колонок не помещаются в 1024px, и ограничитель мешал
  // таблице выйти на ширину экрана. Горизонтальный скролл берёт на себя обёртка
  // таблицы ниже — она работает только в паре с min-w-0 у <main> каркаса.
  return (
    <div>
      <PageHeader
        title={t('nav.leads')}
        subtitle={t('leads.page.subtitle', { total })}
        breadcrumbs={[{ label: t('nav.leads') }]}
        action={<ExportToolbar rows={exportRows} />}
      />

      {truncation ? (
        <p
          role="status"
          className="mt-4 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
        >
          {t('leads.page.truncationHint', { notice: truncation })}
        </p>
      ) : null}

      {leads.length === 0 ? (
        <p className="mt-6 text-sm text-gray-600">{t('leads.page.empty')}</p>
      ) : (
        <div className="mt-6 max-h-[70vh] overflow-x-auto overflow-y-auto rounded-lg border border-gray-200 bg-white">
          {/*
            min-w-[72rem] — арифметическая ширина, а не min-w-full: последний
            равен min-width:100% и скролла не даёт. При auto table-layout таблица
            без явного минимума схлопывается по ширине обёртки, сжимая колонки.
          */}
          <table className="w-full min-w-[72rem] text-sm">
            <thead>
              <tr className="text-left text-gray-500">
                <th className={TH}>{t('leads.page.columns.date')}</th>
                <th className={TH}>{t('fields.name')}</th>
                <th className={TH}>{t('leads.page.columns.contact')}</th>
                <th className={TH}>{t('leads.page.columns.source')}</th>
                <th className={TH}>{t('leads.page.columns.details')}</th>
                <th className={TH}>{t('leads.page.columns.message')}</th>
                <th className={TH}>{t('leads.page.columns.answer')}</th>
                <th className={TH}>{t('leads.page.columns.status')}</th>
                <th className={TH}>{t('common.table.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <tr key={l.id} className="border-t border-gray-100 align-top">
                  <td className="whitespace-nowrap px-4 py-2 text-gray-600">{formatDateTime(l.created_at, timeZone)}</td>
                  <td className="px-4 py-2">{l.name}</td>
                  <td className="px-4 py-2">{l.contact}</td>
                  <td className="px-4 py-2 text-gray-600">{leadSourceLabel(l.source)}</td>
                  <td className="px-4 py-2 text-xs text-gray-600">
                    {l.company ? <div>{t('leads.page.details.company', { value: l.company })}</div> : null}
                    {l.city ? <div>{t('leads.page.details.city', { value: l.city })}</div> : null}
                    {l.subject ? <div>{t('leads.page.details.subject', { value: l.subject })}</div> : null}
                    {l.attachment_key ? (
                      <a
                        href={storage.url(l.attachment_key)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        {t('leads.page.downloadAttachment')}
                      </a>
                    ) : null}
                    {!l.company && !l.city && !l.subject && !l.attachment_key ? (
                      <span className="text-gray-400">—</span>
                    ) : null}
                  </td>
                  {/*
                    Ограничитель ширины стоит на блоке ВНУТРИ ячейки: по CSS 2.1
                    действие max-width на <td> не определено, и браузеры при
                    table-layout:auto его игнорируют — длинное сообщение растянуло
                    бы колонку на всю таблицу.
                  */}
                  <td className="px-4 py-2 text-gray-700">
                    <div className="max-w-[28rem] break-words whitespace-pre-line">
                      {l.message}
                    </div>
                  </td>
                  <td className="px-4 py-2">
                    <div className="w-[20rem]">
                      <LeadAnswerForm id={l.id} answer={l.answer} />
                    </div>
                  </td>
                  <td className="px-4 py-2">
                    <LeadStatusBadge status={l.status} />
                  </td>
                  <td className="px-4 py-2">
                    <LeadRowActions id={l.id} status={l.status} />
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
