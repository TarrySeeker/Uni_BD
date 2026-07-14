/**
 * Футер витрины carre (порт из frontend/views/misc_blocks/footer.twig).
 * Колонка «Каталог» — из реальных категорий API; соцсети — из settings.contacts.
 */

import type { CategoryDto, PublicSettingsDto } from '@/lib/types';

interface Props {
  categories: CategoryDto[];
  settings: PublicSettingsDto | null;
}

export default function SiteFooter({ categories, settings }: Props) {
  const socials = settings?.contacts.socials ?? [];
  return (
    <footer className="footer">
      <div className="content content--fw">
        <div className="footer-threads">
          <div className="footer-threads__col">
            <h3 className="footer-threads__title">Каталог</h3>
            {categories.map((ct) => (
              <div className="footer__p" key={ct.slug}>
                <a className="link--lined link--lined-left" href={`/catalog/${ct.slug}`}>
                  {ct.name}
                </a>
              </div>
            ))}
          </div>
          <div className="footer-threads__col">
            <h3 className="footer-threads__title">Информация</h3>
            <div className="footer__p">
              <a className="link--lined link--lined-left" href="/about">О нас</a>
            </div>
            <div className="footer__p">
              <a className="link--lined link--lined-left" href="/contacts">Контакты</a>
            </div>
            <div className="footer__p">
              <a className="link--lined link--lined-left" href="/corporate">
                Корпоративным клиентам
              </a>
            </div>
          </div>
          <div className="footer-threads__col">
            <h3 className="footer-threads__title">Услуги</h3>
            <div className="footer__p">
              <a className="link--lined link--lined-left" href="/certificates">
                Подарочные сертификаты
              </a>
            </div>
          </div>
          <div className="footer-threads__col">
            <h3 className="footer-threads__title">&nbsp;</h3>
            <div className="footer__p">
              <a className="link--lined link--lined-left" href="/doc-delivery">
                Способы оплаты и Доставки
              </a>
            </div>
            <div className="footer__p">
              <a className="link--lined link--lined-left" href="/doc-policy">
                Политика возвратов
              </a>
            </div>
            <div className="footer__p">
              <a className="link--lined link--lined-left" href="/doc-offer">Оферта</a>
            </div>
            <div className="footer__p">
              <a className="link--lined link--lined-left" href="/doc-user-contract">
                Пользовательское соглашение
              </a>
            </div>
          </div>
        </div>
        <div className="footer-foot">
          <div>MANNER &amp; MATTER</div>
          <div className="footer-foot__soc">
            {socials.map((s) => (
              <a key={s.url} href={s.url} target="_blank" rel="noreferrer">
                {s.type}
              </a>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}
