import Link from 'next/link';

import { requireUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { sql } from '@/lib/db/client';
import { getDashboardSeries } from '@/lib/analytics/repository';
import { isModuleEffectivelyEnabled } from '@/lib/config/settings';
import { MiniBarChart } from './_components/MiniBarChart';

/**
 * Дашборд: приветствие + реальные счётчики каталога/заказов + быстрые ссылки на
 * частые действия. Раньше был пустой заглушкой («—»), и владелец после входа
 * видел экран без действий. Счётчики читаются мягко (ошибка/отсутствие модуля →
 * карточка не показывается), быстрые ссылки фильтруются по правам.
 *
 * force-dynamic: зависит от сессии (cookie) — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

/** Безопасный COUNT: при любой ошибке (нет таблицы/модуля) возвращает null. */
async function safeCount(query: Promise<{ n: string }[]>): Promise<number | null> {
  try {
    const rows = await query;
    return Number(rows[0]?.n ?? 0);
  } catch {
    return null;
  }
}

function MetricCard({ title, value }: { title: string; value: number }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-5">
      <h2 className="text-sm font-medium text-gray-500">{title}</h2>
      <p className="mt-2 text-3xl font-semibold text-gray-900">{value}</p>
    </div>
  );
}

export default async function DashboardPage() {
  const user = await requireUser();

  // Модуль orders может быть выключен для магазина (ADMIK_MODULES). Таблица orders
  // существует всегда (миграции аддитивны и НЕ модуль-зависимы), поэтому без явного
  // гейта дашборд показывал бы счётчики и график заказов даже при выключенном модуле —
  // расходясь с моделью гейтинга (nav.ts / guardOrders) и собственным комментарием
  // карточек. Гейтим чтения orders флагом модуля; «Посещения» от модуля orders не
  // зависят и показываются всегда.
  const ordersOn = await isModuleEffectivelyEnabled('orders');

  const [products, categories, ordersTotal, ordersToday, series] = await Promise.all([
    safeCount(sql<{ n: string }[]>`SELECT count(*)::text AS n FROM products`),
    safeCount(sql<{ n: string }[]>`SELECT count(*)::text AS n FROM categories`),
    ordersOn
      ? safeCount(sql<{ n: string }[]>`SELECT count(*)::text AS n FROM orders`)
      : Promise.resolve(null),
    ordersOn
      ? safeCount(
          sql<{ n: string }[]>`SELECT count(*)::text AS n FROM orders WHERE created_at >= current_date`,
        )
      : Promise.resolve(null),
    // Ряды для графиков (заказы/посещения за 14 дней); null при отсутствии БД.
    getDashboardSeries(14).catch(() => null),
  ]);

  // Быстрые ссылки — только те, на что есть право (owner видит всё).
  const links: { href: string; label: string; show: boolean }[] = [
    { href: '/admin/catalog/products/new', label: '+ Создать товар', show: can(user, 'catalog.write') },
    { href: '/admin/catalog', label: 'Каталог товаров', show: can(user, 'catalog.read') },
    { href: '/admin/catalog/categories', label: 'Категории', show: can(user, 'catalog.read') },
    { href: '/admin/orders', label: 'Заказы', show: can(user, 'orders.read') },
    { href: '/admin/cdek', label: 'Доставка', show: can(user, 'cdek.manage') },
    { href: '/admin/settings', label: 'Настройки', show: can(user, 'settings.manage') },
  ].filter((l) => l.show);

  return (
    <div>
      <h1 className="text-2xl font-semibold text-gray-900">Дашборд</h1>
      <p className="mt-2 text-gray-600">
        Здравствуйте, <span className="font-medium">{user.email}</span>.
      </p>

      <section
        aria-label="Показатели"
        className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4"
      >
        {products !== null ? <MetricCard title="Товаров в каталоге" value={products} /> : null}
        {categories !== null ? <MetricCard title="Категорий" value={categories} /> : null}
        {ordersToday !== null ? <MetricCard title="Заказов сегодня" value={ordersToday} /> : null}
        {ordersTotal !== null ? <MetricCard title="Заказов всего" value={ordersTotal} /> : null}
      </section>

      {series ? (
        <section aria-label="Графики за 14 дней" className="mt-8 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {ordersOn ? (
            <MiniBarChart
              title="Заказы за 14 дней"
              points={series.orders}
              unit="заказов"
              barClassName="fill-gray-800"
            />
          ) : null}
          <MiniBarChart
            title="Посещения сайта за 14 дней"
            points={series.views}
            unit="просмотров"
            barClassName="fill-blue-500"
          />
        </section>
      ) : null}

      {links.length > 0 ? (
        <section aria-label="Быстрые действия" className="mt-8">
          <h2 className="text-sm font-semibold text-gray-700">Быстрые действия</h2>
          <div className="mt-3 flex flex-wrap gap-3">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100"
              >
                {l.label}
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
