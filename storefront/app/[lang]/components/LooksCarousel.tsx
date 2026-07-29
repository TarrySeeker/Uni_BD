'use client';

import { useMemo, useRef, useState } from 'react';

/**
 * Блок «Образы» v2 — горизонтальные вкладки-категории + карусель карточек.
 *
 * Карточка: круглый аватар автора + имя + мелкая подпись «категория», ниже —
 * большое вертикальное фото образа (3:4).
 *
 * Почему без библиотек каруселей: в проекте их нет, а строгий CSP и вес бандла
 * важнее «богатого» слайдера. Прокрутка — нативная (CSS scroll-snap на треке),
 * кнопка «вперёд» лишь дергает `scrollBy` — работает и без JS (свайп/тачпад),
 * и с клавиатуры (трек фокусируем браузером как скролл-контейнер).
 *
 * SSR-дружественность (SEO): компонент рендерит карточки СРАЗУ, на сервере —
 * никаких `mounted`-гейтов. В HTML первой отрисовки есть фото (`img src`), имена
 * авторов и названия категорий; JS нужен только для переключения вкладки и
 * листания. Неактивные вкладки скрываются через `hidden` (панель остаётся в
 * разметке — контент всех категорий индексируется).
 *
 * Мультитенантность: вкладки и карточки приходят из настроек магазина
 * (`home.looks`), подписи интерфейса — из словаря витрины пропом `labels`.
 */

export interface LooksCategory {
  id: string;
  title: string;
}

export interface LooksItem {
  categoryId: string;
  imageUrl: string;
  authorName: string;
  authorAvatarUrl: string | null;
}

export interface LooksLabels {
  /** aria-label кнопки листания вперёд. */
  next: string;
  /** aria-label списка вкладок. */
  tabs: string;
}

/** На сколько листает кнопка, если ширину карточки измерить не удалось. */
const FALLBACK_STEP_PX = 320;

export function LooksCarousel({
  title,
  categories,
  items,
  labels,
}: {
  title: string;
  categories: LooksCategory[];
  items: LooksItem[];
  labels: LooksLabels;
}) {
  // Вкладки без карточек не показываем: пустая вкладка — тупик для покупателя.
  const tabs = useMemo(() => {
    const list = categories ?? [];
    const all = items ?? [];
    return list.filter((c) => all.some((i) => i.categoryId === c.id));
  }, [categories, items]);

  const [activeId, setActiveId] = useState<string>(() => {
    const list = categories ?? [];
    const all = items ?? [];
    const first = list.find((c) => all.some((i) => i.categoryId === c.id));
    return first?.id ?? '';
  });

  // По одному треку на вкладку — храним ссылки в мапе, чтобы кнопка листала
  // именно активный трек (панели остаются в DOM ради SEO).
  const trackRefs = useRef<Record<string, HTMLDivElement | null>>({});

  if (tabs.length === 0) return null;

  const active = tabs.some((t) => t.id === activeId) ? activeId : tabs[0]!.id;

  function scrollForward() {
    const track = trackRefs.current[active];
    if (!track) return;
    // Шаг = ширина первой карточки (+ гэп): не «полэкрана», а ровно карточка.
    const card = track.querySelector<HTMLElement>('[data-look-card]');
    const step = card ? card.getBoundingClientRect().width + 16 : FALLBACK_STEP_PX;
    // Если доехали до конца — возвращаемся в начало (карусель по кругу).
    const atEnd = track.scrollLeft + track.clientWidth >= track.scrollWidth - 2;
    track.scrollBy({ left: atEnd ? -track.scrollLeft : step, behavior: 'smooth' });
  }

  return (
    <section className="sf-looks" aria-labelledby="sf-looks-title">
      <div className="sf-looks__head">
        <h2 className="sf-looks__title" id="sf-looks-title">
          {title} <span aria-hidden="true">›</span>
        </h2>
        <button
          type="button"
          className="sf-looks__next"
          aria-label={labels.next}
          onClick={scrollForward}
        >
          <span aria-hidden="true">›</span>
        </button>
      </div>

      <div className="sf-looks__tabs" role="tablist" aria-label={labels.tabs}>
        {tabs.map((c) => {
          const selected = c.id === active;
          return (
            <button
              key={c.id}
              type="button"
              role="tab"
              id={`sf-looks-tab-${c.id}`}
              aria-selected={selected}
              aria-controls={`sf-looks-panel-${c.id}`}
              tabIndex={selected ? 0 : -1}
              className={`sf-looks__tab${selected ? ' is-active' : ''}`}
              onClick={() => setActiveId(c.id)}
            >
              {c.title}
            </button>
          );
        })}
      </div>

      {tabs.map((c) => {
        const selected = c.id === active;
        const cards = (items ?? []).filter((i) => i.categoryId === c.id);
        return (
          <div
            key={c.id}
            role="tabpanel"
            id={`sf-looks-panel-${c.id}`}
            aria-labelledby={`sf-looks-tab-${c.id}`}
            hidden={!selected}
          >
            <div
              className="sf-looks__track"
              ref={(el) => {
                trackRefs.current[c.id] = el;
              }}
            >
              {cards.map((card, i) => (
                <article
                  className="sf-look-card2"
                  data-look-card=""
                  key={`${card.imageUrl}-${i}`}
                >
                  <div className="sf-look-card2__author">
                    {card.authorAvatarUrl ? (
                      <img
                        className="sf-look-card2__avatar"
                        src={card.authorAvatarUrl}
                        alt={card.authorName}
                        loading="lazy"
                      />
                    ) : (
                      <span className="sf-look-card2__avatar sf-look-card2__avatar--empty" />
                    )}
                    <span className="sf-look-card2__meta">
                      <span className="sf-look-card2__name">{card.authorName}</span>
                      <span className="sf-look-card2__cat">{c.title}</span>
                    </span>
                  </div>
                  <img
                    className="sf-look-card2__photo"
                    src={card.imageUrl}
                    alt={`${c.title} — ${card.authorName}`}
                    loading="lazy"
                  />
                </article>
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}
