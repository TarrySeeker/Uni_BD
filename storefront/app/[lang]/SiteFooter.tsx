/**
 * Футер витрины carre (порт из frontend/views/misc_blocks/footer.twig).
 * Колонка «Каталог» — из реальных категорий API; соцсети — из settings.contacts.
 * i18n: заголовки/ссылки из словаря + localizedHref(path, locale) (сохраняет локаль).
 */

import type { CategoryDto, PublicSettingsDto } from '@/lib/types';
import { localizedHref, type Locale } from '@/lib/i18n';
import type { Dictionary } from '@/lib/dictionaries';

interface Props {
  categories: CategoryDto[];
  settings: PublicSettingsDto | null;
  locale: Locale;
  dict: Dictionary;
}

export default function SiteFooter({ categories, settings, locale, dict }: Props) {
  const socials = settings?.contacts.socials ?? [];
  const href = (path: string) => localizedHref(path, locale);
  const f = dict.footer;
  return (
    <footer className="footer">
      <div className="content content--fw">
        <div className="footer-threads">
          <div className="footer-threads__col">
            <h3 className="footer-threads__title">{f.catalog}</h3>
            {categories.map((ct) => (
              <div className="footer__p" key={ct.slug}>
                <a
                  className="link--lined link--lined-left"
                  href={href(`/catalog/${ct.slug}`)}
                >
                  {ct.name}
                </a>
              </div>
            ))}
          </div>
          <div className="footer-threads__col">
            <h3 className="footer-threads__title">{f.information}</h3>
            <div className="footer__p">
              <a className="link--lined link--lined-left" href={href('/about')}>
                {f.aboutUs}
              </a>
            </div>
            <div className="footer__p">
              <a className="link--lined link--lined-left" href={href('/contacts')}>
                {f.contacts}
              </a>
            </div>
            <div className="footer__p">
              <a className="link--lined link--lined-left" href={href('/corporate')}>
                {f.corporate}
              </a>
            </div>
          </div>
          <div className="footer-threads__col">
            <h3 className="footer-threads__title">{f.services}</h3>
            <div className="footer__p">
              <a className="link--lined link--lined-left" href={href('/certificates')}>
                {f.certificates}
              </a>
            </div>
          </div>
          <div className="footer-threads__col">
            <h3 className="footer-threads__title">&nbsp;</h3>
            <div className="footer__p">
              <a className="link--lined link--lined-left" href={href('/doc-delivery')}>
                {f.delivery}
              </a>
            </div>
            <div className="footer__p">
              <a className="link--lined link--lined-left" href={href('/doc-policy')}>
                {f.returns}
              </a>
            </div>
            <div className="footer__p">
              <a className="link--lined link--lined-left" href={href('/doc-offer')}>
                {f.offer}
              </a>
            </div>
            <div className="footer__p">
              <a
                className="link--lined link--lined-left"
                href={href('/doc-user-contract')}
              >
                {f.userContract}
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
