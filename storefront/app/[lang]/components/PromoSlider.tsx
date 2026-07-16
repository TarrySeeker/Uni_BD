'use client';

/**
 * Промо-слайдер главной (.mainpage--slider) — порт из frontend b_slide carre.
 * Классы 1:1 с легаси. Каждый слайд: кликабельный фон (div .mainpage--slider-img
 * с background-image + переход по клику) + ссылка-подпись (name/caption).
 *
 * Клиентский компонент, потому что фоновый div навигирует по клику
 * (window.location.href) — обработчик события нельзя навесить из серверного
 * компонента (страница главной — async server component). href уже провалидирован
 * схемой (internalHrefSchema: только относит. путь или https) и повторно на
 * рендере в page.tsx (isSafeHref) — анти-XSS/анти-open-redirect.
 */

export interface PromoSlide {
  imageUrl: string;
  href: string;
  name: string;
  caption: string;
}

export function PromoSlider({ slides }: { slides: PromoSlide[] }) {
  return (
    <div className="mainpage--slider">
      <div className="mainpage--slider-ul">
        {slides.map((s, i) => (
          <div className="mainpage--slider-ul-li" key={`${s.href}-${i}`}>
            <div
              className="mainpage--slider-img"
              onClick={() => {
                window.location.href = s.href;
              }}
              style={{ backgroundImage: `url('${s.imageUrl}')` }}
            />
            <a href={s.href} className="mainpage--slider-links">
              <div className="mainpage--slider-links--name">{s.name}</div>
              <div className="mainpage--slider-links--group">{s.caption} →</div>
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}
