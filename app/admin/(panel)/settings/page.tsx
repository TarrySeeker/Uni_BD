import { getEffectiveSettings } from '@/lib/config/settings';
import { getSetting } from '@/lib/settings/repository';
import { getEnabledModules } from '@/lib/config/modules';
import { parseSettingValue, type ModuleOverrides } from '@/lib/settings/schemas';

import { Forbidden } from '../_components/Forbidden';
import { PageHeader } from '../_components/PageHeader';
import { guardSettings } from './_components/guard';
import { BrandingForm } from './_components/BrandingForm';
import { HomeContentForm } from './_components/HomeContentForm';
import { NavigationForm } from './_components/NavigationForm';
import { CurrencyUnitsForm } from './_components/CurrencyUnitsForm';
import { LegalContactsForm } from './_components/LegalContactsForm';
import { CatalogOrdersForm } from './_components/CatalogOrdersForm';
import { ModulesForm } from './_components/ModulesForm';

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
  const guard = await guardSettings('settings.manage');
  if (!guard.ok) {
    return <Forbidden permission={guard.permission} />;
  }

  const eff = await getEffectiveSettings();
  // Сырой module_overrides для формы (что именно переопределено vs наследуется env).
  const rawOverrides = await getSetting('module_overrides');
  const overrides: ModuleOverrides =
    parseSettingValue('module_overrides', rawOverrides?.value) ?? {};
  const envEnabled = getEnabledModules();

  // Разделы настроек. Якоря в боковой колонке → СЕО больше не «спрятан» внизу
  // (Prevki.md): он виден в навигации сразу, наравне с остальными разделами.
  const sections = [
    { id: 'branding', title: 'Брендинг' },
    { id: 'home', title: 'Главная страница' },
    { id: 'navigation', title: 'Навигация и футер' },
    { id: 'currency', title: 'Валюта и единицы измерения' },
    { id: 'contacts', title: 'Реквизиты и контакты' },
    { id: 'catalog', title: 'Каталог, доставка, заказы' },
    { id: 'modules', title: 'Модули' },
    { id: 'seo', title: 'SEO и поиск' },
  ];

  return (
    <div className="max-w-6xl">
      <PageHeader
        title="Настройки магазина"
        subtitle="Название, валюта, контакты, доставка и другие параметры магазина."
        breadcrumbs={[{ label: 'Настройки' }]}
      />

      <div className="mt-6 grid grid-cols-1 gap-8 lg:grid-cols-[220px_1fr]">
        {/* Боковая колонка-оглавление (sticky на десктопе). */}
        <nav aria-label="Разделы настроек" className="lg:sticky lg:top-6 lg:self-start">
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
          <Section id="branding" title="Брендинг">
            <BrandingForm branding={eff.branding} />
          </Section>

          <Section id="home" title="Главная страница">
            <HomeContentForm home={eff.home} />
          </Section>

          <Section id="navigation" title="Навигация и футер">
            <NavigationForm navigation={eff.navigation} />
          </Section>

          <Section id="currency" title="Валюта и единицы измерения">
            <CurrencyUnitsForm currency={eff.currency} units={eff.units} />
          </Section>

          <Section id="contacts" title="Реквизиты и контакты">
            <LegalContactsForm legalEntity={eff.legalEntity} contacts={eff.contacts} />
          </Section>

          <Section id="catalog" title="Каталог, доставка, заказы">
            <CatalogOrdersForm catalog={eff.catalog} delivery={eff.delivery} orders={eff.orders} />
          </Section>

          <Section id="modules" title="Модули">
            <ModulesForm overrides={overrides} envEnabled={envEnabled} />
          </Section>

          <Section id="seo" title="SEO и поиск">
            <p className="text-sm text-gray-600">
              Заголовки страниц, описания для поисковиков, адрес сайта, карта сайта
              (sitemap) и robots — в отдельном разделе.
            </p>
            <a
              href="/admin/settings/seo"
              className="mt-3 inline-flex items-center rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
            >
              Открыть SEO-настройки →
            </a>
          </Section>
        </div>
      </div>
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
