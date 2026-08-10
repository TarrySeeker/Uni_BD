import Link from 'next/link';

import { requireUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { buildReadinessReport, type ReadinessItem, type ReadinessLevel } from '@/lib/admin/readiness';
import { collectReadinessInput } from '@/lib/admin/readiness-collect';

import { Forbidden } from '../_components/Forbidden';
import { PageHeader } from '../_components/PageHeader';

/**
 * «Готовность магазина» — экран диагностики конфигурации и данных инстанса.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ РАЗДЕЛ. Раздел «Аудит» отвечает на вопрос «кто что менял»,
 * дашборд — «сколько чего есть». Ни один из них не отвечает на вопрос, из-за
 * которого магазины реально простаивали: «почему всё выглядит настроенным, а
 * доставка/оплата/каталог не работают». Ключи, оставшиеся пустыми, и мёртвые
 * фоновые задачи не видны нигде — их не показывает ни один экран и не ловит ни
 * один тест, потому что они живут в `.env` конкретного сервера.
 *
 * Логика вердиктов — в чистом `lib/admin/readiness.ts` (17 юнит-тестов без БД),
 * здесь только сбор фактов и отрисовка.
 *
 * force-dynamic: отчёт зависит от текущего состояния БД и окружения —
 * кешировать его нельзя, иначе экран будет показывать вчерашнюю правду.
 */
export const dynamic = 'force-dynamic';

/** Оформление уровня: цвет, подпись, иконка-символ (без внешних зависимостей). */
const LEVEL_STYLE: Record<ReadinessLevel, { label: string; cls: string; mark: string }> = {
  blocker: { label: 'Мешает работе', cls: 'border-red-200 bg-red-50 text-red-800', mark: '✕' },
  warning: { label: 'Стоит поправить', cls: 'border-amber-200 bg-amber-50 text-amber-800', mark: '!' },
  ok: { label: 'В порядке', cls: 'border-green-200 bg-green-50 text-green-800', mark: '✓' },
  skipped: { label: 'Не применимо', cls: 'border-gray-200 bg-gray-50 text-gray-500', mark: '–' },
  unknown: { label: 'Не удалось проверить', cls: 'border-gray-300 bg-gray-100 text-gray-700', mark: '?' },
};

function ItemRow({ item }: { item: ReadinessItem }) {
  const style = LEVEL_STYLE[item.level];
  return (
    <li className={`rounded-lg border p-4 ${style.cls}`}>
      <div className="flex items-start gap-3">
        <span aria-hidden className="mt-0.5 font-bold">
          {style.mark}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{item.title}</h3>
            <span className="rounded-full border border-current/20 px-2 py-0.5 text-xs opacity-80">
              {style.label}
            </span>
          </div>
          <p className="mt-1 text-sm">{item.detail}</p>
          {item.action ? (
            <p className="mt-2 text-sm font-medium">
              Что сделать: <span className="font-normal">{item.action}</span>
            </p>
          ) : null}
          {item.href ? (
            <Link href={item.href} className="mt-2 inline-block text-sm font-medium underline">
              Перейти к настройке
            </Link>
          ) : null}
        </div>
      </div>
    </li>
  );
}

export default async function ReadinessPage() {
  const user = await requireUser();
  // Право settings.manage: диагностика показывает состояние ключей и модулей —
  // это часть настройки магазина, а не общедоступная сводка.
  if (!can(user, 'settings.manage')) {
    return <Forbidden permission="settings.manage" />;
  }

  const report = buildReadinessReport(await collectReadinessInput());

  const headline =
    report.status === 'blocked'
      ? {
          text: `Магазин не готов к работе: ${report.blockers.length} ${
            report.blockers.length === 1 ? 'препятствие' : 'препятствий'
          }.`,
          cls: 'border-red-200 bg-red-50 text-red-800',
        }
      : report.status === 'attention'
        ? { text: 'Магазин работает, но есть на что обратить внимание.', cls: 'border-amber-200 bg-amber-50 text-amber-800' }
        : { text: 'Всё проверенное в порядке — магазин готов к работе.', cls: 'border-green-200 bg-green-50 text-green-800' };

  // Порядок групп фиксирован: интеграции (чаще всего ломаются молча) → витрина → каталог.
  const groups: ReadinessItem['group'][] = ['Интеграции', 'Витрина', 'Каталог'];

  return (
    <div>
      <PageHeader
        title="Готовность магазина"
        subtitle="Проверка настроек и данных: то, что не видят тесты, — пустые ключи, выключенные фоновые задачи, товары без цены."
        breadcrumbs={[{ label: 'Готовность' }]}
      />

      <div role="status" className={`mt-4 rounded-lg border p-4 text-sm font-medium ${headline.cls}`}>
        {headline.text}
      </div>

      {report.blockers.length > 0 ? (
        <section aria-label="Требует немедленного внимания" className="mt-6">
          <h2 className="text-sm font-semibold text-gray-800">Сначала это</h2>
          <ul className="mt-3 space-y-3">
            {report.blockers.map((item) => (
              <ItemRow key={item.id} item={item} />
            ))}
          </ul>
        </section>
      ) : null}

      {groups.map((group) => {
        const items = report.items.filter((i) => i.group === group);
        if (items.length === 0) return null;
        return (
          <section key={group} aria-label={group} className="mt-8">
            <h2 className="text-sm font-semibold text-gray-800">{group}</h2>
            <ul className="mt-3 space-y-3">
              {items.map((item) => (
                <ItemRow key={item.id} item={item} />
              ))}
            </ul>
          </section>
        );
      })}

      <p className="mt-8 text-xs text-gray-500">
        Проверка выполняется при каждом открытии страницы. Пункты, относящиеся к
        выключенным модулям, помечены как «не применимо» и не считаются ошибками:
        магазин без онлайн-оплаты или без службы доставки — рабочая конфигурация.
      </p>
    </div>
  );
}
