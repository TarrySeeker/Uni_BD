'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { ActionResult } from '@/lib/server/action';
import type { EffectiveSettings } from '@/lib/config/settings';
import type { TranslationsMap } from '@/lib/i18n';

import { updateHomeContentAction } from './form-actions';
import { errorMessage } from './action-result';
import { ImageUploadButton } from './ImageUploadButton';
import { SettingsTranslationTabs } from './SettingsTranslationTabs';
import { buildHomeTrFieldDefs } from './content-i18n-form-state';

/**
 * Форма «Главная страница» (ADR-018, закрывает G-02/G-03): редактируемый контент
 * главной витрины — hero (CTA/фон), «О бренде», «Качество ткани», «Доставка и
 * оплата». Мутация — updateHomeContentAction (settings.manage). Пустые поля →
 * не отправляем (падают на дефолт витрины). Изображения пока задаются S3-ключом
 * (как og в SEO); полноценный загрузчик файлов — отдельным шагом.
 */
type Fail = Extract<ActionResult<unknown>, { ok: false }>;

/** Текст по строкам → массив непустых строк. */
function linesToArr(text: string): string[] {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** «title | text» по строкам → массив пар (обе части обязательны). */
function pairsToArr(text: string): { title: string; text: string }[] {
  return text
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('|');
      if (idx < 0) return null;
      const title = line.slice(0, idx).trim();
      const t = line.slice(idx + 1).trim();
      return title && t ? { title, text: t } : null;
    })
    .filter((x): x is { title: string; text: string } => x !== null);
}

export function HomeContentForm({
  home,
  i18n,
  translations,
}: {
  home: EffectiveSettings['home'];
  i18n: { defaultLocale: string; locales: string[] };
  translations?: TranslationsMap;
}) {
  const router = useRouter();
  const t = useTranslations();
  // Дескрипторы переводимых полей разворачиваются по фактической длине базовых
  // массивов «главной» (read-path мержит перевод по индексу).
  const trFields = buildHomeTrFieldDefs(home as unknown as Record<string, unknown>);
  const [error, setError] = useState<Fail | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // hero
  const [heroTitle, setHeroTitle] = useState(home.hero.title ?? '');
  const [heroSubtitle, setHeroSubtitle] = useState(home.hero.subtitle ?? '');
  const [heroCtaLabel, setHeroCtaLabel] = useState(home.hero.ctaLabel ?? '');
  const [heroCtaHref, setHeroCtaHref] = useState(home.hero.ctaHref ?? '');
  const [heroImageKey, setHeroImageKey] = useState(home.hero.imageKey ?? '');
  // about
  const [aboutTitle, setAboutTitle] = useState(home.about.title ?? '');
  const [aboutParagraphs, setAboutParagraphs] = useState((home.about.paragraphs ?? []).join('\n'));
  const [aboutValues, setAboutValues] = useState((home.about.values ?? []).join('\n'));
  const [aboutImageKeys, setAboutImageKeys] = useState((home.about.imageKeys ?? []).join('\n'));
  // quality
  const [qualityTitle, setQualityTitle] = useState(home.quality.title ?? '');
  const [qualityItems, setQualityItems] = useState((home.quality.items ?? []).join('\n'));
  // delivery
  const [deliveryItems, setDeliveryItems] = useState(
    (home.delivery.items ?? []).map((i) => `${i.title} | ${i.text}`).join('\n'),
  );
  // valuesStrip (B1) — лента ценностей: показ + список пар title/text.
  const [valuesStripEnabled, setValuesStripEnabled] = useState(home.valuesStrip.enabled);
  const [valuesStripItems, setValuesStripItems] = useState(
    (home.valuesStrip.items ?? []).map((i) => `${i.title} | ${i.text}`).join('\n'),
  );
  // philosophy (B3)
  const [philEyebrow, setPhilEyebrow] = useState(home.philosophy.eyebrow ?? '');
  const [philTitle, setPhilTitle] = useState(home.philosophy.title ?? '');
  const [philText, setPhilText] = useState(home.philosophy.text ?? '');
  const [philLinkLabel, setPhilLinkLabel] = useState(home.philosophy.linkLabel ?? '');
  const [philLinkHref, setPhilLinkHref] = useState(home.philosophy.linkHref ?? '');
  // looks v2 — «Образы»: показ + заголовок + репитер ВКЛАДОК-категорий и репитер
  // КАРТОЧЕК (фото образа + аватар автора + имя + принадлежность вкладке).
  // Легаси-поля категории (text/imageKey) в состоянии сохраняем и отправляем
  // обратно нетронутыми: иначе сохранение формы затёрло бы контент, который
  // старая витрина ещё показывает, а карточки-миграции — потеряли бы источник.
  const [looksEnabled, setLooksEnabled] = useState(home.looks.enabled);
  const [looksTitle, setLooksTitle] = useState(home.looks.title ?? '');
  const [looksCategories, setLooksCategories] = useState<
    { id: string; title: string; text: string; imageKey: string }[]
  >(() => (home.looks.categories ?? []).map((c) => ({ ...c })));
  const [looksItems, setLooksItems] = useState<
    { categoryId: string; imageKey: string; authorName: string; authorAvatarKey: string }[]
  >(() => (home.looks.items ?? []).map((i) => ({ ...i })));

  function setLookCategory(i: number, field: 'id' | 'title', value: string) {
    setLooksCategories((prev) => prev.map((c, idx) => (idx === i ? { ...c, [field]: value } : c)));
  }
  function addLookCategory() {
    // id генерируем от позиции — тот же принцип, что в normalizeLooks на сервере.
    setLooksCategories((prev) => [
      ...prev,
      { id: `cat-${prev.length}-${Date.now()}`, title: '', text: '', imageKey: '' },
    ]);
  }
  function removeLookCategory(i: number) {
    setLooksCategories((prev) => {
      const removed = prev[i];
      // Вместе со вкладкой убираем её карточки — иначе они станут сиротами и
      // сервер их всё равно отбросит, а владелец решит, что фото «пропали молча».
      if (removed) setLooksItems((items) => items.filter((it) => it.categoryId !== removed.id));
      return prev.filter((_, idx) => idx !== i);
    });
  }

  function setLookItem(
    i: number,
    field: 'categoryId' | 'imageKey' | 'authorName' | 'authorAvatarKey',
    value: string,
  ) {
    setLooksItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, [field]: value } : it)));
  }
  function addLookItem() {
    setLooksItems((prev) => [
      ...prev,
      {
        categoryId: looksCategories[0]?.id ?? '',
        imageKey: '',
        authorName: '',
        authorAvatarKey: '',
      },
    ]);
  }
  function removeLookItem(i: number) {
    setLooksItems((prev) => prev.filter((_, idx) => idx !== i));
  }

  // tiles (M4) — «Плитки категорий»: показ + репитер плиток (заголовок/ссылка/фото).
  const [tilesEnabled, setTilesEnabled] = useState(home.tiles.enabled);
  const [tilesItems, setTilesItems] = useState<
    { title: string; href: string; imageKey: string }[]
  >(() => (home.tiles.items ?? []).map((t) => ({ ...t })));

  function setTile(i: number, field: 'title' | 'href' | 'imageKey', value: string) {
    setTilesItems((prev) => prev.map((t, idx) => (idx === i ? { ...t, [field]: value } : t)));
  }
  function addTile() {
    setTilesItems((prev) => [...prev, { title: '', href: '', imageKey: '' }]);
  }
  function removeTile(i: number) {
    setTilesItems((prev) => prev.filter((_, idx) => idx !== i));
  }

  // video (M4) — «Видео»: показ + один https-embed URL (Vimeo/YouTube-embed).
  const [videoEnabled, setVideoEnabled] = useState(home.video.enabled);
  const [videoEmbedUrl, setVideoEmbedUrl] = useState(home.video.embedUrl ?? '');

  // designers (M4) — «Дизайнеры»: показ + заголовок + репитер записей (имя/ссылка/
  // аватар/работа + позиции фото avatarTop/workTop 0..100). Числа держим строками
  // для контролируемых input'ов; на сабмите приводим к числу (num), пусто → дефолт merge.
  const [designersEnabled, setDesignersEnabled] = useState(home.designers.enabled);
  const [designersTitle, setDesignersTitle] = useState(home.designers.title ?? '');
  const [designersItems, setDesignersItems] = useState<
    {
      name: string;
      href: string;
      avatarImageKey: string;
      workImageKey: string;
      avatarTop: string;
      workTop: string;
    }[]
  >(() =>
    (home.designers.items ?? []).map((d) => ({
      name: d.name,
      href: d.href,
      avatarImageKey: d.avatarImageKey,
      workImageKey: d.workImageKey,
      avatarTop: String(d.avatarTop),
      workTop: String(d.workTop),
    })),
  );

  function setDesigner(
    i: number,
    field: 'name' | 'href' | 'avatarImageKey' | 'workImageKey' | 'avatarTop' | 'workTop',
    value: string,
  ) {
    setDesignersItems((prev) => prev.map((d, idx) => (idx === i ? { ...d, [field]: value } : d)));
  }
  function addDesigner() {
    setDesignersItems((prev) => [
      ...prev,
      { name: '', href: '', avatarImageKey: '', workImageKey: '', avatarTop: '', workTop: '' },
    ]);
  }
  function removeDesigner(i: number) {
    setDesignersItems((prev) => prev.filter((_, idx) => idx !== i));
  }

  // slider (M5) — «Промо-слайдер»: показ + репитер слайдов (фон/ссылка/имя/подпись).
  const [sliderEnabled, setSliderEnabled] = useState(home.slider.enabled);
  const [sliderSlides, setSliderSlides] = useState<
    { imageKey: string; href: string; name: string; caption: string }[]
  >(() => (home.slider.slides ?? []).map((sl) => ({ ...sl })));

  function setSlide(
    i: number,
    field: 'imageKey' | 'href' | 'name' | 'caption',
    value: string,
  ) {
    setSliderSlides((prev) => prev.map((sl, idx) => (idx === i ? { ...sl, [field]: value } : sl)));
  }
  function addSlide() {
    setSliderSlides((prev) => [...prev, { imageKey: '', href: '', name: '', caption: '' }]);
  }
  function removeSlide(i: number) {
    setSliderSlides((prev) => prev.filter((_, idx) => idx !== i));
  }

  // corpCert (M5) — «Корпоративным / сертификаты»: показ + репитер плиток (фото/ссылка/заголовок).
  const [corpCertEnabled, setCorpCertEnabled] = useState(home.corpCert.enabled);
  const [corpCertTiles, setCorpCertTiles] = useState<
    { imageKey: string; href: string; title: string }[]
  >(() => (home.corpCert.tiles ?? []).map((t) => ({ ...t })));

  function setCorpCertTile(i: number, field: 'imageKey' | 'href' | 'title', value: string) {
    setCorpCertTiles((prev) => prev.map((t, idx) => (idx === i ? { ...t, [field]: value } : t)));
  }
  function addCorpCertTile() {
    setCorpCertTiles((prev) => [...prev, { imageKey: '', href: '', title: '' }]);
  }
  function removeCorpCertTile(i: number) {
    setCorpCertTiles((prev) => prev.filter((_, idx) => idx !== i));
  }

  function s(v: string): string | undefined {
    const t = v.trim();
    return t.length > 0 ? t : undefined;
  }

  /** Строка → число (или undefined, если пусто). Пусто → merge добьёт дефолт (50). */
  function num(v: string): number | undefined {
    const t = v.trim();
    if (t.length === 0) return undefined;
    const n = Number(t);
    // Округляем: позиции avatarTop/workTop — целые (Zod .int()); дробный ввод
    // (напр. 50.5) иначе завалил бы валидацию всей формы.
    return Number.isFinite(n) ? Math.round(n) : undefined;
  }

  async function save() {
    setPending(true);
    setError(null);
    setSuccess(null);
    const result = await updateHomeContentAction({
      home: {
        hero: {
          title: s(heroTitle),
          subtitle: s(heroSubtitle),
          ctaLabel: s(heroCtaLabel),
          ctaHref: s(heroCtaHref),
          imageKey: s(heroImageKey),
        },
        about: {
          title: s(aboutTitle),
          paragraphs: linesToArr(aboutParagraphs),
          values: linesToArr(aboutValues),
          imageKeys: linesToArr(aboutImageKeys),
        },
        quality: {
          title: s(qualityTitle),
          items: linesToArr(qualityItems),
        },
        delivery: {
          items: pairsToArr(deliveryItems),
        },
        valuesStrip: {
          enabled: valuesStripEnabled,
          items: pairsToArr(valuesStripItems),
        },
        philosophy: {
          eyebrow: s(philEyebrow),
          title: s(philTitle),
          text: s(philText),
          linkLabel: s(philLinkLabel),
          linkHref: s(philLinkHref),
        },
        looks: {
          enabled: looksEnabled,
          title: s(looksTitle),
          // Вкладке достаточно непустого заголовка. Легаси-поля (text/imageKey)
          // отправляем ТОЛЬКО если непусты: пустая строка не пройдёт Zod (nonEmpty),
          // а сохранять их обязательно — иначе правка блока обнулила бы контент v1.
          categories: looksCategories
            .map((c) => {
              const cat: { id?: string; title: string; text?: string; imageKey?: string } = {
                title: c.title.trim(),
              };
              const id = c.id.trim();
              if (id) cat.id = id;
              const text = c.text.trim();
              if (text) cat.text = text;
              const imageKey = c.imageKey.trim();
              if (imageKey) cat.imageKey = imageKey;
              return cat;
            })
            .filter((c) => c.title),
          // Карточка едет, только если заполнены вкладка + фото + имя автора;
          // неполные отбрасываем (как делали looks-категории v1), иначе Zod-отказ.
          items: looksItems
            .map((it) => {
              const card: {
                categoryId: string;
                imageKey: string;
                authorName: string;
                authorAvatarKey?: string;
              } = {
                categoryId: it.categoryId.trim(),
                imageKey: it.imageKey.trim(),
                authorName: it.authorName.trim(),
              };
              const avatar = it.authorAvatarKey.trim();
              if (avatar) card.authorAvatarKey = avatar;
              return card;
            })
            .filter((it) => it.categoryId && it.imageKey && it.authorName),
        },
        tiles: {
          enabled: tilesEnabled,
          // Только полностью заполненные плитки (все три поля) — как looks-категории.
          items: tilesItems
            .map((t) => ({ title: t.title.trim(), href: t.href.trim(), imageKey: t.imageKey.trim() }))
            .filter((t) => t.title && t.href && t.imageKey),
        },
        video: {
          enabled: videoEnabled,
          // Пусто → не отправляем (падает на дефолт витрины); иначе Zod проверит https.
          embedUrl: s(videoEmbedUrl),
        },
        designers: {
          enabled: designersEnabled,
          title: s(designersTitle),
          // Только полностью заполненные записи (имя/ссылка/оба фото). Позиции —
          // опциональны: пусто → опускаем, merge добьёт 50.
          items: designersItems
            .map((d) => {
              const item: {
                name: string;
                href: string;
                avatarImageKey: string;
                workImageKey: string;
                avatarTop?: number;
                workTop?: number;
              } = {
                name: d.name.trim(),
                href: d.href.trim(),
                avatarImageKey: d.avatarImageKey.trim(),
                workImageKey: d.workImageKey.trim(),
              };
              const at = num(d.avatarTop);
              const wt = num(d.workTop);
              if (at !== undefined) item.avatarTop = at;
              if (wt !== undefined) item.workTop = wt;
              return item;
            })
            .filter((d) => d.name && d.href && d.avatarImageKey && d.workImageKey),
        },
        slider: {
          enabled: sliderEnabled,
          // Обязательны фон и ссылка; name/caption опциональны (пусто → опускаем,
          // merge добьёт ''). Слайды без фото/ссылки отбрасываем (иначе Zod-отказ).
          slides: sliderSlides
            .map((sl) => {
              const slide: {
                imageKey: string;
                href: string;
                name?: string;
                caption?: string;
              } = { imageKey: sl.imageKey.trim(), href: sl.href.trim() };
              const nm = sl.name.trim();
              const cap = sl.caption.trim();
              if (nm) slide.name = nm;
              if (cap) slide.caption = cap;
              return slide;
            })
            .filter((sl) => sl.imageKey && sl.href),
        },
        corpCert: {
          enabled: corpCertEnabled,
          // Только полностью заполненные плитки (фото/ссылка/заголовок) — как looks/tiles.
          tiles: corpCertTiles
            .map((t) => ({ imageKey: t.imageKey.trim(), href: t.href.trim(), title: t.title.trim() }))
            .filter((t) => t.imageKey && t.href && t.title),
        },
      },
    });
    setPending(false);
    if (result.ok) {
      setSuccess(t('settings.homeContentForm.savedToast'));
      router.refresh();
    } else {
      setError(result);
    }
  }

  const inputCls = 'mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm';
  const labelCls = 'block text-sm font-medium text-gray-700';
  const hintCls = 'mt-1 text-xs text-gray-500';

  return (
    <SettingsTranslationTabs
      section="home"
      fields={trFields}
      locales={i18n.locales}
      defaultLocale={i18n.defaultLocale}
      translations={translations}
    >
    <div>
      {error ? (
        <div role="alert" className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {errorMessage(error, t)}
        </div>
      ) : null}
      {success ? (
        <div role="status" className="mb-4 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700">
          {success}
        </div>
      ) : null}

      <p className="mb-5 text-sm text-gray-600">
        {t('settings.homeContentForm.intro')}
      </p>

      {/* Hero / обложка */}
      <fieldset className="mb-6 rounded border border-gray-200 p-4">
        <legend className="px-1 text-sm font-semibold text-gray-800">{t('settings.homeContentForm.hero.legend')}</legend>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div>
            <label htmlFor="home-hero-cta" className={labelCls}>{t('settings.homeContentForm.hero.ctaLabel')}</label>
            <input id="home-hero-cta" value={heroCtaLabel} onChange={(e) => setHeroCtaLabel(e.target.value)}
              placeholder={t('settings.homeContentForm.hero.ctaPlaceholder')} className={inputCls} />
          </div>
          <div>
            <label htmlFor="home-hero-href" className={labelCls}>{t('settings.homeContentForm.hero.hrefLabel')}</label>
            <input id="home-hero-href" value={heroCtaHref} onChange={(e) => setHeroCtaHref(e.target.value)}
              placeholder="/catalog" className={inputCls} />
          </div>
          <div>
            <label htmlFor="home-hero-title" className={labelCls}>{t('settings.homeContentForm.hero.titleLabel')}</label>
            <input id="home-hero-title" value={heroTitle} onChange={(e) => setHeroTitle(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label htmlFor="home-hero-sub" className={labelCls}>{t('settings.homeContentForm.hero.subtitleLabel')}</label>
            <input id="home-hero-sub" value={heroSubtitle} onChange={(e) => setHeroSubtitle(e.target.value)} className={inputCls} />
          </div>
          <div className="lg:col-span-2">
            <label htmlFor="home-hero-img" className={labelCls}>{t('settings.homeContentForm.hero.imageLabel')}</label>
            <input id="home-hero-img" value={heroImageKey} onChange={(e) => setHeroImageKey(e.target.value)}
              placeholder="home/hero.webp" className={inputCls} />
            <ImageUploadButton label={t('settings.homeContentForm.hero.uploadBg')} onUploaded={(key) => setHeroImageKey(key)} />
            <p className={hintCls}>{t('settings.homeContentForm.hero.imageHint')}</p>
          </div>
        </div>
      </fieldset>

      {/* О бренде */}
      <fieldset className="mb-6 rounded border border-gray-200 p-4">
        <legend className="px-1 text-sm font-semibold text-gray-800">{t('settings.homeContentForm.about.legend')}</legend>
        <div className="grid grid-cols-1 gap-4">
          <div>
            <label htmlFor="home-about-title" className={labelCls}>{t('fields.title')}</label>
            <input id="home-about-title" value={aboutTitle} onChange={(e) => setAboutTitle(e.target.value)}
              placeholder={t('settings.homeContentForm.about.titlePlaceholder')} className={inputCls} />
          </div>
          <div>
            <label htmlFor="home-about-p" className={labelCls}>{t('settings.homeContentForm.about.paragraphsLabel')}</label>
            <textarea id="home-about-p" value={aboutParagraphs} onChange={(e) => setAboutParagraphs(e.target.value)}
              rows={4} className={inputCls} />
          </div>
          <div>
            <label htmlFor="home-about-v" className={labelCls}>{t('settings.homeContentForm.about.valuesLabel')}</label>
            <textarea id="home-about-v" value={aboutValues} onChange={(e) => setAboutValues(e.target.value)}
              rows={3} className={inputCls} />
          </div>
          <div>
            <label htmlFor="home-about-img" className={labelCls}>{t('settings.homeContentForm.about.imagesLabel')}</label>
            <textarea id="home-about-img" value={aboutImageKeys} onChange={(e) => setAboutImageKeys(e.target.value)}
              rows={2} className={inputCls} />
            <ImageUploadButton label={t('settings.homeContentForm.about.uploadPhoto')} onUploaded={(key) => setAboutImageKeys((p) => (p ? `${p}\n${key}` : key))} />
          </div>
        </div>
      </fieldset>

      {/* Качество ткани */}
      <fieldset className="mb-6 rounded border border-gray-200 p-4">
        <legend className="px-1 text-sm font-semibold text-gray-800">{t('settings.homeContentForm.quality.legend')}</legend>
        <div className="grid grid-cols-1 gap-4">
          <div>
            <label htmlFor="home-q-title" className={labelCls}>{t('fields.title')}</label>
            <input id="home-q-title" value={qualityTitle} onChange={(e) => setQualityTitle(e.target.value)}
              placeholder={t('settings.homeContentForm.quality.titlePlaceholder')} className={inputCls} />
          </div>
          <div>
            <label htmlFor="home-q-items" className={labelCls}>{t('settings.homeContentForm.quality.itemsLabel')}</label>
            <textarea id="home-q-items" value={qualityItems} onChange={(e) => setQualityItems(e.target.value)}
              rows={4} className={inputCls} />
          </div>
        </div>
      </fieldset>

      {/* Доставка и оплата */}
      <fieldset className="mb-6 rounded border border-gray-200 p-4">
        <legend className="px-1 text-sm font-semibold text-gray-800">{t('settings.homeContentForm.delivery.legend')}</legend>
        <div>
          <label htmlFor="home-delivery" className={labelCls}>{t('settings.homeContentForm.delivery.itemsLabel')}</label>
          <textarea id="home-delivery" value={deliveryItems} onChange={(e) => setDeliveryItems(e.target.value)}
            rows={4} className={inputCls} placeholder={t('settings.homeContentForm.delivery.itemsPlaceholder')} />
          <p className={hintCls}>{t.rich('settings.homeContentForm.delivery.hint', { code: (chunks) => <code>{chunks}</code> })}</p>
        </div>
      </fieldset>

      {/* Лента ценностей (B1) */}
      <fieldset className="mb-6 rounded border border-gray-200 p-4">
        <legend className="px-1 text-sm font-semibold text-gray-800">{t('settings.homeContentForm.valuesStrip.legend')}</legend>
        <div className="grid grid-cols-1 gap-4">
          <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
            <input
              type="checkbox"
              checked={valuesStripEnabled}
              onChange={(e) => setValuesStripEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            {t('settings.homeContentForm.valuesStrip.showToggle')}
          </label>
          <div>
            <label htmlFor="home-values-strip" className={labelCls}>
              {t('settings.homeContentForm.delivery.itemsLabel')}
            </label>
            <textarea id="home-values-strip" value={valuesStripItems} onChange={(e) => setValuesStripItems(e.target.value)}
              rows={4} className={inputCls} placeholder={t('settings.homeContentForm.valuesStrip.itemsPlaceholder')} />
            <p className={hintCls}>{t('settings.homeContentForm.valuesStrip.hint')}</p>
          </div>
        </div>
      </fieldset>

      {/* Философия (B3) */}
      <fieldset className="mb-6 rounded border border-gray-200 p-4">
        <legend className="px-1 text-sm font-semibold text-gray-800">{t('settings.homeContentForm.philosophy.legend')}</legend>
        <div className="grid grid-cols-1 gap-4">
          <div>
            <label htmlFor="home-phil-eyebrow" className={labelCls}>{t('settings.homeContentForm.philosophy.eyebrowLabel')}</label>
            <input id="home-phil-eyebrow" value={philEyebrow} onChange={(e) => setPhilEyebrow(e.target.value)}
              placeholder={t('settings.homeContentForm.philosophy.eyebrowPlaceholder')} className={inputCls} />
          </div>
          <div>
            <label htmlFor="home-phil-title" className={labelCls}>{t('fields.title')}</label>
            <input id="home-phil-title" value={philTitle} onChange={(e) => setPhilTitle(e.target.value)}
              placeholder={t('settings.homeContentForm.philosophy.titlePlaceholder')} className={inputCls} />
          </div>
          <div>
            <label htmlFor="home-phil-text" className={labelCls}>{t('settings.homeContentForm.philosophy.textLabel')}</label>
            <textarea id="home-phil-text" value={philText} onChange={(e) => setPhilText(e.target.value)}
              rows={3} className={inputCls} />
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div>
              <label htmlFor="home-phil-link-label" className={labelCls}>{t('settings.homeContentForm.philosophy.linkTextLabel')}</label>
              <input id="home-phil-link-label" value={philLinkLabel} onChange={(e) => setPhilLinkLabel(e.target.value)}
                placeholder={t('settings.homeContentForm.about.titlePlaceholder')} className={inputCls} />
            </div>
            <div>
              <label htmlFor="home-phil-link-href" className={labelCls}>{t('settings.homeContentForm.philosophy.linkHrefLabel')}</label>
              <input id="home-phil-link-href" value={philLinkHref} onChange={(e) => setPhilLinkHref(e.target.value)}
                placeholder="/#about" className={inputCls} />
            </div>
          </div>
        </div>
      </fieldset>

      {/* Образы (lookbook, ТЗ_2) */}
      <fieldset className="mb-6 rounded border border-gray-200 p-4">
        <legend className="px-1 text-sm font-semibold text-gray-800">{t('settings.homeContentForm.looks.legend')}</legend>
        <div className="grid grid-cols-1 gap-4">
          <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
            <input
              type="checkbox"
              checked={looksEnabled}
              onChange={(e) => setLooksEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            {t('settings.homeContentForm.looks.showToggle')}
          </label>
          <div>
            <label htmlFor="home-looks-title" className={labelCls}>{t('settings.homeContentForm.blockTitleOptional')}</label>
            <input id="home-looks-title" value={looksTitle} onChange={(e) => setLooksTitle(e.target.value)}
              placeholder={t('settings.homeContentForm.looks.titlePlaceholder')} className={inputCls} />
          </div>

          {/* Репитер ВКЛАДОК-категорий: у вкладки только заголовок (id машинный). */}
          <div className="grid grid-cols-1 gap-4">
            {looksCategories.map((cat, i) => (
              <div key={cat.id || i} className="rounded border border-gray-200 bg-gray-50 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-600">{t('settings.homeContentForm.looks.categoryN', { n: i + 1 })}</span>
                  <button type="button" onClick={() => removeLookCategory(i)}
                    className="rounded border border-gray-300 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50">
                    {t('common.actions.delete')}
                  </button>
                </div>
                <div>
                  <label htmlFor={`home-looks-title-${i}`} className={labelCls}>{t('fields.title')}</label>
                  <input id={`home-looks-title-${i}`} value={cat.title}
                    onChange={(e) => setLookCategory(i, 'title', e.target.value)}
                    placeholder={t('settings.homeContentForm.looks.catTitlePlaceholder')} className={inputCls} />
                </div>
              </div>
            ))}
          </div>

          <div>
            <button type="button" onClick={addLookCategory}
              className="rounded border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
              {t('settings.homeContentForm.looks.addCategory')}
            </button>
            <p className={hintCls}>{t('settings.homeContentForm.looks.hint')}</p>
          </div>

          {/* Репитер КАРТОЧЕК карусели: вкладка + фото образа + автор (имя+аватар). */}
          <div className="grid grid-cols-1 gap-4">
            {looksItems.map((card, i) => (
              <div key={i} className="rounded border border-gray-200 bg-gray-50 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-600">{t('settings.homeContentForm.looks.cardN', { n: i + 1 })}</span>
                  <button type="button" onClick={() => removeLookItem(i)}
                    className="rounded border border-gray-300 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50">
                    {t('common.actions.delete')}
                  </button>
                </div>
                <div className="grid grid-cols-1 gap-3">
                  <div>
                    <label htmlFor={`home-looks-item-cat-${i}`} className={labelCls}>{t('settings.homeContentForm.looks.cardCategoryLabel')}</label>
                    <select id={`home-looks-item-cat-${i}`} value={card.categoryId}
                      onChange={(e) => setLookItem(i, 'categoryId', e.target.value)}
                      className={inputCls}>
                      <option value="">—</option>
                      {looksCategories.map((c) => (
                        <option key={c.id} value={c.id}>{c.title || c.id}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor={`home-looks-item-name-${i}`} className={labelCls}>{t('settings.homeContentForm.looks.authorNameLabel')}</label>
                    <input id={`home-looks-item-name-${i}`} value={card.authorName}
                      onChange={(e) => setLookItem(i, 'authorName', e.target.value)}
                      placeholder={t('settings.homeContentForm.looks.authorNamePlaceholder')} className={inputCls} />
                  </div>
                  <div>
                    <label htmlFor={`home-looks-item-img-${i}`} className={labelCls}>{t('settings.homeContentForm.looks.cardPhotoLabel')}</label>
                    <input id={`home-looks-item-img-${i}`} value={card.imageKey}
                      onChange={(e) => setLookItem(i, 'imageKey', e.target.value)}
                      placeholder="home/looks/card-1.webp" className={inputCls} />
                    <ImageUploadButton label={t('settings.homeContentForm.looks.uploadPhoto')} onUploaded={(key) => setLookItem(i, 'imageKey', key)} />
                  </div>
                  <div>
                    <label htmlFor={`home-looks-item-avatar-${i}`} className={labelCls}>{t('settings.homeContentForm.looks.avatarLabel')}</label>
                    <input id={`home-looks-item-avatar-${i}`} value={card.authorAvatarKey}
                      onChange={(e) => setLookItem(i, 'authorAvatarKey', e.target.value)}
                      placeholder="home/looks/avatar-1.webp" className={inputCls} />
                    <ImageUploadButton label={t('settings.homeContentForm.looks.uploadAvatar')} onUploaded={(key) => setLookItem(i, 'authorAvatarKey', key)} />
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div>
            <button type="button" onClick={addLookItem}
              className="rounded border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
              {t('settings.homeContentForm.looks.addCard')}
            </button>
            <p className={hintCls}>{t('settings.homeContentForm.looks.cardsHint')}</p>
          </div>
        </div>
      </fieldset>

      {/* Плитки категорий (M4) */}
      <fieldset className="mb-6 rounded border border-gray-200 p-4">
        <legend className="px-1 text-sm font-semibold text-gray-800">{t('settings.homeContentForm.tiles.legend')}</legend>
        <div className="grid grid-cols-1 gap-4">
          <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
            <input
              type="checkbox"
              checked={tilesEnabled}
              onChange={(e) => setTilesEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            {t('settings.homeContentForm.tiles.showToggle')}
          </label>

          <div className="grid grid-cols-1 gap-4">
            {tilesItems.map((tile, i) => (
              <div key={i} className="rounded border border-gray-200 bg-gray-50 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-600">{t('settings.homeContentForm.tileN', { n: i + 1 })}</span>
                  <button type="button" onClick={() => removeTile(i)}
                    className="rounded border border-gray-300 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50">
                    {t('common.actions.delete')}
                  </button>
                </div>
                <div className="grid grid-cols-1 gap-3">
                  <div>
                    <label htmlFor={`home-tiles-title-${i}`} className={labelCls}>{t('fields.title')}</label>
                    <input id={`home-tiles-title-${i}`} value={tile.title}
                      onChange={(e) => setTile(i, 'title', e.target.value)}
                      placeholder={t('settings.homeContentForm.tiles.titlePlaceholder')} className={inputCls} />
                  </div>
                  <div>
                    <label htmlFor={`home-tiles-href-${i}`} className={labelCls}>{t('settings.homeContentForm.linkLabel')}</label>
                    <input id={`home-tiles-href-${i}`} value={tile.href}
                      onChange={(e) => setTile(i, 'href', e.target.value)}
                      placeholder="/catalog/scarves" className={inputCls} />
                  </div>
                  <div>
                    <label htmlFor={`home-tiles-img-${i}`} className={labelCls}>{t('settings.homeContentForm.photoLabel')}</label>
                    <input id={`home-tiles-img-${i}`} value={tile.imageKey}
                      onChange={(e) => setTile(i, 'imageKey', e.target.value)}
                      placeholder="home/tiles/1.webp" className={inputCls} />
                    <ImageUploadButton label={t('settings.homeContentForm.uploadTilePhoto')} onUploaded={(key) => setTile(i, 'imageKey', key)} />
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div>
            <button type="button" onClick={addTile}
              className="rounded border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
              {t('settings.homeContentForm.addTile')}
            </button>
            <p className={hintCls}>{t('settings.homeContentForm.tiles.hint')}</p>
          </div>
        </div>
      </fieldset>

      {/* Видео (M4) */}
      <fieldset className="mb-6 rounded border border-gray-200 p-4">
        <legend className="px-1 text-sm font-semibold text-gray-800">{t('settings.homeContentForm.video.legend')}</legend>
        <div className="grid grid-cols-1 gap-4">
          <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
            <input
              type="checkbox"
              checked={videoEnabled}
              onChange={(e) => setVideoEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            {t('settings.homeContentForm.video.showToggle')}
          </label>
          <div>
            <label htmlFor="home-video-embed" className={labelCls}>{t('settings.homeContentForm.video.embedLabel')}</label>
            <input id="home-video-embed" type="url" value={videoEmbedUrl}
              onChange={(e) => setVideoEmbedUrl(e.target.value)}
              placeholder="https://player.vimeo.com/video/12345" className={inputCls} />
            <p className={hintCls}>
              {t.rich('settings.homeContentForm.video.hint', { code: (chunks) => <code>{chunks}</code> })}
            </p>
          </div>
        </div>
      </fieldset>

      {/* Дизайнеры (M4) */}
      <fieldset className="mb-6 rounded border border-gray-200 p-4">
        <legend className="px-1 text-sm font-semibold text-gray-800">{t('settings.homeContentForm.designers.legend')}</legend>
        <div className="grid grid-cols-1 gap-4">
          <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
            <input
              type="checkbox"
              checked={designersEnabled}
              onChange={(e) => setDesignersEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            {t('settings.homeContentForm.designers.showToggle')}
          </label>
          <div>
            <label htmlFor="home-designers-title" className={labelCls}>{t('settings.homeContentForm.blockTitleOptional')}</label>
            <input id="home-designers-title" value={designersTitle} onChange={(e) => setDesignersTitle(e.target.value)}
              placeholder={t('settings.homeContentForm.designers.titlePlaceholder')} className={inputCls} />
          </div>

          <div className="grid grid-cols-1 gap-4">
            {designersItems.map((d, i) => (
              <div key={i} className="rounded border border-gray-200 bg-gray-50 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-600">{t('settings.homeContentForm.designers.designerN', { n: i + 1 })}</span>
                  <button type="button" onClick={() => removeDesigner(i)}
                    className="rounded border border-gray-300 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50">
                    {t('common.actions.delete')}
                  </button>
                </div>
                <div className="grid grid-cols-1 gap-3">
                  <div>
                    <label htmlFor={`home-designers-name-${i}`} className={labelCls}>{t('fields.name')}</label>
                    <input id={`home-designers-name-${i}`} value={d.name}
                      onChange={(e) => setDesigner(i, 'name', e.target.value)}
                      placeholder={t('settings.homeContentForm.designers.namePlaceholder')} className={inputCls} />
                  </div>
                  <div>
                    <label htmlFor={`home-designers-href-${i}`} className={labelCls}>{t('settings.homeContentForm.linkLabel')}</label>
                    <input id={`home-designers-href-${i}`} value={d.href}
                      onChange={(e) => setDesigner(i, 'href', e.target.value)}
                      placeholder="/designers/ivanov" className={inputCls} />
                  </div>
                  <div>
                    <label htmlFor={`home-designers-avatar-${i}`} className={labelCls}>{t('settings.homeContentForm.designers.avatarLabel')}</label>
                    <input id={`home-designers-avatar-${i}`} value={d.avatarImageKey}
                      onChange={(e) => setDesigner(i, 'avatarImageKey', e.target.value)}
                      placeholder="home/designers/1-avatar.webp" className={inputCls} />
                    <ImageUploadButton label={t('settings.homeContentForm.designers.uploadAvatar')} onUploaded={(key) => setDesigner(i, 'avatarImageKey', key)} />
                  </div>
                  <div>
                    <label htmlFor={`home-designers-work-${i}`} className={labelCls}>{t('settings.homeContentForm.designers.workLabel')}</label>
                    <input id={`home-designers-work-${i}`} value={d.workImageKey}
                      onChange={(e) => setDesigner(i, 'workImageKey', e.target.value)}
                      placeholder="home/designers/1-work.webp" className={inputCls} />
                    <ImageUploadButton label={t('settings.homeContentForm.designers.uploadWork')} onUploaded={(key) => setDesigner(i, 'workImageKey', key)} />
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label htmlFor={`home-designers-avatartop-${i}`} className={labelCls}>{t('settings.homeContentForm.designers.avatarTopLabel')}</label>
                      <input id={`home-designers-avatartop-${i}`} type="number" min={0} max={100} value={d.avatarTop}
                        onChange={(e) => setDesigner(i, 'avatarTop', e.target.value)}
                        placeholder="50" className={inputCls} />
                    </div>
                    <div>
                      <label htmlFor={`home-designers-worktop-${i}`} className={labelCls}>{t('settings.homeContentForm.designers.workTopLabel')}</label>
                      <input id={`home-designers-worktop-${i}`} type="number" min={0} max={100} value={d.workTop}
                        onChange={(e) => setDesigner(i, 'workTop', e.target.value)}
                        placeholder="50" className={inputCls} />
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div>
            <button type="button" onClick={addDesigner}
              className="rounded border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
              {t('settings.homeContentForm.designers.addDesigner')}
            </button>
            <p className={hintCls}>
              {t('settings.homeContentForm.designers.hint')}
            </p>
          </div>
        </div>
      </fieldset>

      {/* Промо-слайдер (M5) */}
      <fieldset className="mb-6 rounded border border-gray-200 p-4">
        <legend className="px-1 text-sm font-semibold text-gray-800">{t('settings.homeContentForm.slider.legend')}</legend>
        <div className="grid grid-cols-1 gap-4">
          <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
            <input
              type="checkbox"
              checked={sliderEnabled}
              onChange={(e) => setSliderEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            {t('settings.homeContentForm.slider.showToggle')}
          </label>

          <div className="grid grid-cols-1 gap-4">
            {sliderSlides.map((sl, i) => (
              <div key={i} className="rounded border border-gray-200 bg-gray-50 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-600">{t('settings.homeContentForm.slider.slideN', { n: i + 1 })}</span>
                  <button type="button" onClick={() => removeSlide(i)}
                    className="rounded border border-gray-300 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50">
                    {t('common.actions.delete')}
                  </button>
                </div>
                <div className="grid grid-cols-1 gap-3">
                  <div>
                    <label htmlFor={`home-slider-img-${i}`} className={labelCls}>{t('settings.homeContentForm.slider.imageLabel')}</label>
                    <input id={`home-slider-img-${i}`} value={sl.imageKey}
                      onChange={(e) => setSlide(i, 'imageKey', e.target.value)}
                      placeholder="home/slider/1.webp" className={inputCls} />
                    <ImageUploadButton label={t('settings.homeContentForm.slider.uploadBg')} onUploaded={(key) => setSlide(i, 'imageKey', key)} />
                  </div>
                  <div>
                    <label htmlFor={`home-slider-href-${i}`} className={labelCls}>{t('settings.homeContentForm.linkLabel')}</label>
                    <input id={`home-slider-href-${i}`} value={sl.href}
                      onChange={(e) => setSlide(i, 'href', e.target.value)}
                      placeholder="/search?q=caviar" className={inputCls} />
                  </div>
                  <div>
                    <label htmlFor={`home-slider-name-${i}`} className={labelCls}>{t('settings.homeContentForm.slider.nameLabel')}</label>
                    <input id={`home-slider-name-${i}`} value={sl.name}
                      onChange={(e) => setSlide(i, 'name', e.target.value)}
                      placeholder="" className={inputCls} />
                  </div>
                  <div>
                    <label htmlFor={`home-slider-caption-${i}`} className={labelCls}>{t('settings.homeContentForm.slider.captionLabel')}</label>
                    <input id={`home-slider-caption-${i}`} value={sl.caption}
                      onChange={(e) => setSlide(i, 'caption', e.target.value)}
                      placeholder={t('settings.homeContentForm.slider.captionPlaceholder')} className={inputCls} />
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div>
            <button type="button" onClick={addSlide}
              className="rounded border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
              {t('settings.homeContentForm.slider.addSlide')}
            </button>
            <p className={hintCls}>
              {t('settings.homeContentForm.slider.hint')}
            </p>
          </div>
        </div>
      </fieldset>

      {/* Корпоративным / сертификаты (M5) */}
      <fieldset className="mb-6 rounded border border-gray-200 p-4">
        <legend className="px-1 text-sm font-semibold text-gray-800">{t('settings.homeContentForm.corpCert.legend')}</legend>
        <div className="grid grid-cols-1 gap-4">
          <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
            <input
              type="checkbox"
              checked={corpCertEnabled}
              onChange={(e) => setCorpCertEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            {t('settings.homeContentForm.corpCert.showToggle')}
          </label>

          <div className="grid grid-cols-1 gap-4">
            {corpCertTiles.map((tile, i) => (
              <div key={i} className="rounded border border-gray-200 bg-gray-50 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-600">{t('settings.homeContentForm.tileN', { n: i + 1 })}</span>
                  <button type="button" onClick={() => removeCorpCertTile(i)}
                    className="rounded border border-gray-300 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50">
                    {t('common.actions.delete')}
                  </button>
                </div>
                <div className="grid grid-cols-1 gap-3">
                  <div>
                    <label htmlFor={`home-corpcert-title-${i}`} className={labelCls}>{t('fields.title')}</label>
                    <input id={`home-corpcert-title-${i}`} value={tile.title}
                      onChange={(e) => setCorpCertTile(i, 'title', e.target.value)}
                      placeholder={t('settings.homeContentForm.corpCert.titlePlaceholder')} className={inputCls} />
                  </div>
                  <div>
                    <label htmlFor={`home-corpcert-href-${i}`} className={labelCls}>{t('settings.homeContentForm.linkLabel')}</label>
                    <input id={`home-corpcert-href-${i}`} value={tile.href}
                      onChange={(e) => setCorpCertTile(i, 'href', e.target.value)}
                      placeholder="/corporate" className={inputCls} />
                  </div>
                  <div>
                    <label htmlFor={`home-corpcert-img-${i}`} className={labelCls}>{t('settings.homeContentForm.photoLabel')}</label>
                    <input id={`home-corpcert-img-${i}`} value={tile.imageKey}
                      onChange={(e) => setCorpCertTile(i, 'imageKey', e.target.value)}
                      placeholder="home/corpcert/1.webp" className={inputCls} />
                    <ImageUploadButton label={t('settings.homeContentForm.uploadTilePhoto')} onUploaded={(key) => setCorpCertTile(i, 'imageKey', key)} />
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div>
            <button type="button" onClick={addCorpCertTile}
              className="rounded border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
              {t('settings.homeContentForm.addTile')}
            </button>
            <p className={hintCls}>
              {t('settings.homeContentForm.corpCert.hint')}
            </p>
          </div>
        </div>
      </fieldset>

      <div className="flex items-center gap-3 border-t border-gray-200 pt-4">
        <button type="button" onClick={save} disabled={pending}
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50">
          {pending ? t('common.form.saving') : t('settings.homeContentForm.saveButton')}
        </button>
      </div>
    </div>
    </SettingsTranslationTabs>
  );
}
