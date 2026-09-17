import { getEffectiveSettings } from '@/lib/config/settings';

import { Forbidden } from '../../_components/Forbidden';
import { PageHeader } from '../../_components/PageHeader';
import { guardSettings } from '../_components/guard';
import { SizeChartsForm } from '../_components/SizeChartsForm';

/**
 * Раздел «Настройки → Размерные сетки» (ключ настроек size_charts).
 *
 * Серверная страница: guard settings.manage (core, БЕЗ гейта по модулю
 * 'catalog' — раздел настроек должен оставаться self-lock-safe). Рендерит
 * редактор сеток, передавая эффективное значение (env ⊕ БД). Мутация —
 * updateSizeChartsAction.
 *
 * force-dynamic: читает БД/cookies — не пререндерить статически при build.
 */
export const dynamic = 'force-dynamic';

export default async function SizeChartsSettingsPage() {
  const guard = await guardSettings('settings.manage');
  if (!guard.ok) {
    return <Forbidden permission={guard.permission} />;
  }

  const eff = await getEffectiveSettings();

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Размерные сетки"
        subtitle="Таблицы размеров на карточке товара: свои колонки и строки для каждой сетки."
        breadcrumbs={[
          { label: 'Настройки', href: '/admin/settings' },
          { label: 'Размерные сетки' },
        ]}
        backHref="/admin/settings"
        backLabel="К настройкам"
      />

      <section className="mt-8 rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <SizeChartsForm sizeCharts={eff.sizeCharts} />
      </section>
    </div>
  );
}
