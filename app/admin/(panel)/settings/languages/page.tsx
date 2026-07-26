import { getTranslations } from 'next-intl/server';

import { getLocaleConfig } from '@/lib/i18n/config';

import { Forbidden } from '../../_components/Forbidden';
import { PageHeader } from '../../_components/PageHeader';
import { guardSettings } from '../_components/guard';
import { LanguagesForm } from '../_components/LanguagesForm';
import { ResetSettingButton } from '../_components/ResetSettingButton';
import {
  buildCoverageMatrix,
  coverageTone,
  formatPercent,
  type CoverageRow,
} from '../_components/languages-coverage';
import { localeLabel } from '../_components/languages-form-state';
import { loadTranslationCoverage } from './coverage-data';

/**
 * Раздел «Настройки → Языки» (T3).
 *
 * Управление набором языков магазина (shop_settings.i18n) + матрица покрытия
 * переводов: сколько переводимых полей заполнено по каждому языку. Покрытие
 * считается ТОЛЬКО по не-дефолтным языкам — базовый язык хранится в обычных
 * колонках и заполнен по определению.
 *
 * force-dynamic: читает БД/cookies — не пререндерить статически при build.
 */
export const dynamic = 'force-dynamic';

export default async function LanguagesSettingsPage() {
  const guard = await guardSettings('settings.manage');
  if (!guard.ok) {
    return <Forbidden permission={guard.permission} />;
  }

  const t = await getTranslations();
  const config = await getLocaleConfig();
  const secondary = config.locales.filter((l) => l !== config.defaultLocale);
  const entries = await loadTranslationCoverage(secondary);
  const matrix = buildCoverageMatrix(entries, secondary);

  return (
    <div className="max-w-4xl">
      <PageHeader
        title={t('nav.languages')}
        subtitle={t('settings.languagesPage.subtitle')}
        breadcrumbs={[{ label: t('nav.settings'), href: '/admin/settings' }, { label: t('nav.languages') }]}
        backHref="/admin/settings"
        backLabel={t('settings.languagesPage.backToSettings')}
      />

      <section className="mt-8 rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">{t('settings.languagesPage.shopLanguagesHeading')}</h2>
        <LanguagesForm config={config} />
        <div className="mt-4">
          <ResetSettingButton settingKey="i18n" label={t('settings.languagesPage.resetLanguages')} />
        </div>
      </section>

      <section className="mt-8 rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="mb-1 text-lg font-semibold text-gray-900">{t('settings.languagesPage.coverageHeading')}</h2>
        <p className="mb-4 text-sm text-gray-600">
          {t('settings.languagesPage.coverageIntro', { defaultLocale: localeLabel(config.defaultLocale) })}
        </p>
        <CoverageTable matrix={matrix} locales={secondary} />
      </section>
    </div>
  );
}

/** Таблица «сущность × язык» с процентом заполненности переводов. */
async function CoverageTable({
  matrix,
  locales,
}: {
  matrix: CoverageRow[];
  locales: readonly string[];
}) {
  const t = await getTranslations();
  if (locales.length === 0) {
    return (
      <p className="text-sm text-gray-600">
        {t('settings.languagesPage.coverageNoSecondary')}
      </p>
    );
  }
  if (matrix.length === 0) {
    return <p className="text-sm text-gray-600">{t('settings.languagesPage.coverageNoData')}</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-left text-gray-600">
            <th className="py-2 pr-4 font-medium">{t('settings.languagesPage.colSection')}</th>
            <th className="py-2 pr-4 font-medium">{t('settings.languagesPage.colRecords')}</th>
            {locales.map((locale) => (
              <th key={locale} className="py-2 pr-4 font-medium">
                {localeLabel(locale)} ({locale})
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {matrix.map((row) => (
            <tr key={row.entity} className="border-b border-gray-100">
              <td className="py-2 pr-4 text-gray-800">{t(row.labelKey)}</td>
              <td className="py-2 pr-4 text-gray-500">{row.total}</td>
              {row.cells.map((cell) => (
                <td key={cell.locale} className="py-2 pr-4">
                  <span className={toneClass(coverageTone(cell.ratio))}>
                    {formatPercent(cell.ratio)}
                  </span>
                  <span className="ml-2 text-xs text-gray-500">
                    {t('settings.languagesPage.notTranslated', { missing: cell.missing })}
                  </span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Цвет подписи процента по градации покрытия. */
function toneClass(tone: 'none' | 'low' | 'mid' | 'full'): string {
  switch (tone) {
    case 'full':
      return 'font-medium text-green-700';
    case 'mid':
      return 'font-medium text-amber-700';
    case 'low':
      return 'font-medium text-orange-700';
    default:
      return 'font-medium text-gray-500';
  }
}
