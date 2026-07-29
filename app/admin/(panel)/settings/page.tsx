import { getTranslations } from 'next-intl/server';

import { getEffectiveSettings } from '@/lib/config/settings';
import { getShopTimeZone } from '@/lib/admin/timezone';
import { getSetting } from '@/lib/settings/repository';
import { getEnabledModules } from '@/lib/config/modules';
import { parseSettingValue, type ModuleOverrides } from '@/lib/settings/schemas';

import { Forbidden } from '../_components/Forbidden';
import { PageHeader } from '../_components/PageHeader';
import { guardSettings } from './_components/guard';
import { BrandingForm } from './_components/BrandingForm';
import { HomeContentForm } from './_components/HomeContentForm';
import { CurrencyUnitsForm } from './_components/CurrencyUnitsForm';
import { LegalContactsForm } from './_components/LegalContactsForm';
import { CatalogOrdersForm } from './_components/CatalogOrdersForm';
import { ModulesForm } from './_components/ModulesForm';
import { NavigationForm } from './_components/NavigationForm';
import { AccessForm } from './_components/AccessForm';
import { ResetSettingButton } from './_components/ResetSettingButton';
import type { SettingKey } from '@/lib/settings/schemas';

/**
 * Раздел «Настройки магазина» (docs/11 §5.4.5).
 *
 * Серверная страница: guard settings.manage (core, без модуля — не гейтится
 * ADMIK_MODULES, иначе self-lock). Рендерит формы по разделам, передавая текущие
 * эффективные значения (env ⊕ БД). Каждая форма мутирует свой ключ через
 * Server Action settings.manage.
 *
 * force-dynamic: читает БД/cookies — не пререндерить статически при build.
 */
export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const t = await getTranslations();
  const guard = await guardSettings('settings.manage');
  if (!guard.ok) {
    return <Forbidden permission={guard.permission} />;
  }

  const eff = await getEffectiveSettings();
  // Часовой пояс магазина (аудит major №26) резолвится отдельно от EffectiveSettings:
  // приоритет «настройка branding.timeZone → env SHOP_TIMEZONE → дефолт платформы»
  // живёт в lib/admin/timezone.ts, чтобы им пользовались все экраны админки.
  const timeZone = await getShopTimeZone();
  // Сырой module_overrides для формы (что именно переопределено vs наследуется env).
  const rawOverrides = await getSetting('module_overrides');
  const overrides: ModuleOverrides =
    parseSettingValue('module_overrides', rawOverrides?.value) ?? {};
  const envEnabled = getEnabledModules();

  // Разделы настроек. Якоря в боковой колонке → СЕО больше не «спрятан» внизу
  // (Prevki.md): он виден в навигации сразу, наравне с остальными разделами.
  const sections = [
    { id: 'branding', title: t('settings.page.sections.branding') },
    { id: 'home', title: t('settings.page.sections.home') },
    { id: 'currency', title: t('settings.page.sections.currency') },
    { id: 'contacts', title: t('settings.page.sections.contacts') },
    { id: 'catalog', title: t('settings.page.sections.catalog') },
    { id: 'gift', title: t('nav.giftCertificates') },
    { id: 'modules', title: t('settings.page.sections.modules') },
    { id: 'navigation', title: t('settings.page.sections.navigation') },
    { id: 'access', title: t('settings.page.sections.access') },
    { id: 'languages', title: t('nav.languages') },
    { id: 'seo', title: t('settings.page.sections.seo') },
  ];

  return (
    <div className="max-w-6xl">
      <PageHeader
        title={t('settings.page.header.title')}
        subtitle={t('settings.page.header.subtitle')}
        breadcrumbs={[{ label: t('nav.settings') }]}
      />

      <div className="mt-6 grid grid-cols-1 gap-8 lg:grid-cols-[220px_1fr]">
        {/* Боковая колонка-оглавление (sticky на десктопе). */}
        <nav aria-label={t('settings.page.tocAriaLabel')} className="lg:sticky lg:top-6 lg:self-start">
          <ul className="flex flex-wrap gap-2 lg:flex-col lg:gap-1">
            {sections.map((s) => (
              <li key={s.id}>
                <a
                  href={`#${s.id}`}
                  className="block rounded-md px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                >
                  {s.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {/* Контент разделов. */}
        <div className="min-w-0">
          <Section id="branding" title={t('settings.page.sections.branding')}>
            <BrandingForm branding={eff.branding} timeZone={timeZone} i18n={eff.i18n} translations={eff.contentI18n} />
            <ResetRow keys={[{ key: 'branding', label: t('settings.page.reset.branding') }]} />
          </Section>

          <Section id="home" title={t('settings.page.sections.home')}>
            <HomeContentForm home={eff.home} i18n={eff.i18n} translations={eff.contentI18n} />
            <ResetRow keys={[{ key: 'home', label: t('settings.page.reset.homeContent') }]} />
          </Section>

          <Section id="currency" title={t('settings.page.sections.currency')}>
            <CurrencyUnitsForm
              currency={eff.currency}
              exchange={eff.exchange}
              units={eff.units}
            />
            <ResetRow
              keys={[
                { key: 'currency', label: t('settings.page.reset.currency') },
                { key: 'exchange', label: t('settings.page.reset.exchange') },
                { key: 'units', label: t('settings.page.reset.units') },
              ]}
            />
          </Section>

          <Section id="contacts" title={t('settings.page.sections.contacts')}>
            <LegalContactsForm
              legalEntity={eff.legalEntity}
              contacts={eff.contacts}
              i18n={eff.i18n}
              translations={eff.contentI18n}
            />
            <ResetRow
              keys={[
                { key: 'contacts', label: t('settings.page.reset.contacts') },
                { key: 'legal_entity', label: t('settings.page.reset.legalEntity') },
              ]}
            />
          </Section>

          <Section id="catalog" title={t('settings.page.sections.catalog')}>
            <CatalogOrdersForm
              catalog={eff.catalog}
              delivery={eff.delivery}
              orders={eff.orders}
              i18n={eff.i18n}
              translations={eff.contentI18n}
            />
            <ResetRow
              keys={[
                { key: 'catalog', label: t('settings.page.reset.catalog') },
                { key: 'delivery', label: t('settings.page.reset.delivery') },
                { key: 'orders', label: t('settings.page.reset.orders') },
              ]}
            />
          </Section>

          <Section id="gift" title={t('nav.giftCertificates')}>
            <p className="text-sm text-gray-600">
              {t('settings.page.gift.description')}
            </p>
            <a
              href="/admin/settings/gift"
              className="mt-3 inline-flex items-center rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
            >
              {t('settings.page.gift.openLink')}
            </a>
            <ResetRow keys={[{ key: 'gift', label: t('settings.page.reset.giftSettings') }]} />
          </Section>

          <Section id="modules" title={t('settings.page.sections.modules')}>
            <ModulesForm overrides={overrides} envEnabled={envEnabled} />
            <ResetRow keys={[{ key: 'module_overrides', label: t('settings.page.reset.modules') }]} />
          </Section>

          <Section id="navigation" title={t('settings.page.sections.navigation')}>
            <NavigationForm navigation={eff.navigation} i18n={eff.i18n} translations={eff.contentI18n} />
          </Section>

          <Section id="access" title={t('settings.page.sections.access')}>
            <AccessForm singleUserMode={eff.access.singleUserMode} />
            <ResetRow keys={[{ key: 'access', label: t('settings.page.reset.access') }]} />
          </Section>

          <Section id="languages" title={t('nav.languages')}>
            <p className="text-sm text-gray-600">
              {t('settings.page.languages.description')}
            </p>
            <a
              href="/admin/settings/languages"
              className="mt-3 inline-flex items-center rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
            >
              {t('settings.page.languages.openLink')}
            </a>
            <ResetRow keys={[{ key: 'i18n', label: t('settings.page.reset.languages') }]} />
          </Section>

          <Section id="seo" title={t('settings.page.sections.seo')}>
            <p className="text-sm text-gray-600">
              {t('settings.page.seo.description')}
            </p>
            <a
              href="/admin/settings/seo"
              className="mt-3 inline-flex items-center rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
            >
              {t('settings.page.seo.openLink')}
            </a>
            <ResetRow keys={[{ key: 'seo', label: t('settings.page.reset.seo') }]} />
          </Section>
        </div>
      </div>
    </div>
  );
}

/**
 * Ряд кнопок «Сбросить раздел к умолчаниям» под формой (C27). Одна кнопка на
 * логический ключ настроек (форма может владеть несколькими ключами). Действие
 * resetSettingAction защищено settings.manage и аудируется на сервере.
 */
function ResetRow({ keys }: { keys: { key: SettingKey; label: string }[] }) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-3">
      {keys.map((k) => (
        <ResetSettingButton key={k.key} settingKey={k.key} label={k.label} />
      ))}
    </div>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      // scroll-mt — чтобы якорь не уезжал под шапку при переходе из оглавления.
      className="mt-8 scroll-mt-6 rounded-lg border border-gray-200 bg-white p-6 shadow-sm first:mt-0"
    >
      <h2 className="mb-4 text-lg font-semibold text-gray-900">{title}</h2>
      {children}
    </section>
  );
}
