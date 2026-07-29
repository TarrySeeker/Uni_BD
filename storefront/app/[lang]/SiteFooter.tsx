/**
 * Подвал витрины — разметка 1:1 с эталоном carrerusse.com (docs/41 §1):
 *
 *   footer > footer-top > [ .footer-top__subscriptions (28%)
 *                         , .footer-soc (иконки + телефон)
 *                         , .footer-top__links (50%, N колонок) ]
 *          > footer-foot > [ копирайт , .footer-foot-design ]
 *
 * Классы и адаптив (колонки складываются на планшете/мобильном, телефон
 * переезжает в `.footer-foot`) уже есть в собранном `/dist/app.css` — своих
 * стилей подвал не заводит.
 *
 * 🔴 МУЛЬТИТЕНАНТНОСТЬ: компонент не выбирает содержимое и ничего не хардкодит —
 * всё приходит готовым из чистой `buildFooterModel` (storefront/lib/footer.ts):
 * колонки → settings.navigation.footer, телефон → settings.contacts.phone,
 * тексты/копирайт/кредит → settings.navigation.footerMeta, соцсети →
 * settings.contacts.socials. Настройка пуста → словарный дефолт локали.
 *
 * Подписка — существующий эндпоинт платформы `POST /api/storefront/v1/newsletter`
 * (см. NewsletterForm).
 */

import type { CategoryDto, PublicSettingsDto } from '@/lib/types';
import type { Locale } from '@/lib/i18n';
import { socialIcon } from '@/lib/social';
import type { Dictionary } from '@/lib/dictionaries';
import { buildFooterModel } from '@/lib/footer';
import NewsletterForm from './NewsletterForm';

interface Props {
  /** Категории для колонки каталога в ФОЛБЭКЕ (владелец не задал навигацию). */
  categories: CategoryDto[];
  /** Полное дерево — источник вложенных путей (/catalog/parent/child), как на проде. */
  tree: CategoryDto[];
  settings: PublicSettingsDto | null;
  locale: Locale;
  dict: Dictionary;
}

export default function SiteFooter({ categories, tree, settings, locale, dict }: Props) {
  const model = buildFooterModel({ categories, tree, settings, locale, dict });

  const phoneBlock = model.phone ? (
    <div className="footer-soc-phone">
      <a href={model.phone.href}>{model.phone.display}</a>
    </div>
  ) : null;

  return (
    <footer className="footer">
      <div className="footer-top">
        {/* 1. Подписка (~28%) — заголовок, поле+кнопка на одной линии, приписка. */}
        <div className="footer-top__subscriptions">
          <span className="footer-top__subscriptions-h">{model.subscribe.title}</span>
          <NewsletterForm
            texts={{
              placeholder: model.subscribe.placeholder,
              submitLabel: model.subscribe.submitLabel,
              note: model.subscribe.note,
              successTitle: model.subscribe.successTitle,
              errorText: dict.footer.subscribeError,
              invalidText: dict.footer.subscribeInvalid,
              ariaLabel: dict.footer.subscribeAria,
            }}
          />
        </div>

        {/* 2. Соцсети + телефон. На эталоне блок иконок пуст — у нас он наполняется
            из settings.contacts.socials, а без соцсетей остаётся пустым, как там. */}
        <div className="footer-soc">
          <div className="footer-soc-icons">
            {model.socials.map((s) => {
              const icon = socialIcon(s.type);
              return (
                <a
                  key={s.url}
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={s.type}
                >
                  {icon ? <img src={icon} alt={s.type} width={24} height={24} /> : s.type}
                </a>
              );
            })}
          </div>
          {phoneBlock}
        </div>

        {/* 3. Колонки ссылок (~50%). Число колонок — данные, а не разметка. */}
        <div className="footer-top__links">
          {model.columns.map((col) => (
            <div className="footer-top__links-block" key={col.key}>
              {col.links.map((link) => (
                <a key={`${col.key}:${link.href}:${link.label}`} href={link.href}>
                  {link.label}
                </a>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="footer-foot">
        <div>
          <span>{model.copyright}</span>
        </div>
        {/* На планшете/мобильном CSS эталона показывает телефон именно здесь
            (.footer-foot .footer-soc{display:flex}), а в .footer-top прячет. */}
        <div className="footer-soc">{phoneBlock}</div>
        {model.designedBy ? (
          <div className="footer-foot-design">
            {model.designedBy.href ? (
              <a href={model.designedBy.href} target="_blank" rel="noreferrer">
                {model.designedBy.label}
              </a>
            ) : (
              <span>{model.designedBy.label}</span>
            )}
          </div>
        ) : null}
      </div>
    </footer>
  );
}
