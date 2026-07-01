import { getEffectiveSettings } from '@/lib/config/settings';
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
    { id: 'currency', title: 'Валюта и единицы измерения' },
    { id: 'contacts', title: 'Реквизиты и контакты' },
    { id: 'catalog', title: 'Каталог, доставка, заказы' },
    { id: 'modules', title: 'Модули' },
    { id: 'navigation', title: 'Навигация (меню и футер)' },
    { id: 'access', title: 'Доступ' },
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
            <ResetRow keys={[{ key: 'branding', label: 'Сбросить брендинг' }]} />
          </Section>

          <Section id="home" title="Главная страница">
            <HomeContentForm home={eff.home} />
            <ResetRow keys={[{ key: 'home', label: 'Сбросить контент главной' }]} />
          </Section>

          <Section id="currency" title="Валюта и единицы измерения">
            <CurrencyUnitsForm currency={eff.currency} units={eff.units} />
            <ResetRow
              keys={[
                { key: 'currency', label: 'Сбросить валюту' },
                { key: 'units', label: 'Сбросить единицы' },
              ]}
            />
          </Section>

          <Section id="contacts" title="Реквизиты и контакты">
            <LegalContactsForm legalEntity={eff.legalEntity} contacts={eff.contacts} />
            <ResetRow
              keys={[
                { key: 'contacts', label: 'Сбросить контакты' },
                { key: 'legal_entity', label: 'Сбросить реквизиты' },
              ]}
            />
          </Section>

          <Section id="catalog" title="Каталог, доставка, заказы">
            <CatalogOrdersForm catalog={eff.catalog} delivery={eff.delivery} orders={eff.orders} />
            <ResetRow
              keys={[
                { key: 'catalog', label: 'Сбросить каталог' },
                { key: 'delivery', label: 'Сбросить доставку' },
                { key: 'orders', label: 'Сбросить заказы' },
              ]}
            />
          </Section>

          <Section id="modules" title="Модули">
            <ModulesForm overrides={overrides} envEnabled={envEnabled} />
            <ResetRow keys={[{ key: 'module_overrides', label: 'Сбросить модули' }]} />
          </Section>

          <Section id="navigation" title="Навигация (меню и футер)">
            <NavigationForm navigation={eff.navigation} />
          </Section>

          <Section id="access" title="Доступ">
            <AccessForm singleUserMode={eff.access.singleUserMode} />
            <ResetRow keys={[{ key: 'access', label: 'Сбросить режим доступа' }]} />
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
            <ResetRow keys={[{ key: 'seo', label: 'Сбросить SEO' }]} />
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
