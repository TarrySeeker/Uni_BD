/**
 * Соцсети футера: сопоставление `type` из админки (settings.contacts.socials) с
 * SVG-иконкой в /images/social. Порт логики боевого carrerusse.com
 * (misc_blocks/footer_new.twig: soc_fb→facebook, soc_inst→instagram, soc_od→pin,
 * soc_vimeo→youtube). Неизвестный тип → иконки нет (витрина покажет текст-фолбэк),
 * чтобы новый магазин не падал на незнакомой сети.
 */

/** Файлы иконок, реально лежащие в storefront/public/images/social. */
const ICONS: Record<string, string> = {
  facebook: 'facebook.svg',
  fb: 'facebook.svg',
  instagram: 'instagram.svg',
  inst: 'instagram.svg',
  youtube: 'youtube.svg',
  vimeo: 'youtube.svg',
  pinterest: 'pin.svg',
  pin: 'pin.svg',
  ok: 'pin.svg',
  od: 'pin.svg',
};

/** Путь к иконке соцсети по её типу, или null если иконки для типа нет. */
export function socialIcon(type: string): string | null {
  const key = type.trim().toLowerCase();
  const file = ICONS[key];
  return file ? `/images/social/${file}` : null;
}
