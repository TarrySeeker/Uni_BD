import { describe, expect, it } from 'vitest';

import {
  DesignerCreateSchema,
  DesignerUpdateSchema,
  DesignerImageUploadSchema,
  DesignerSetActiveSchema,
} from '@/lib/designers/schemas';

/**
 * ЮНИТ — контракт входа дизайнеров (§9). Проверяет форму и дефолты create/update,
 * валидацию соцсетей/slug/uuid, и что аплоад аватара требует Buffer.
 */
describe('designers/schemas', () => {
  it('DesignerCreateSchema: минимум — только name; дефолты проставляются', () => {
    const r = DesignerCreateSchema.safeParse({ name: '  Иван Петров ' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.name).toBe('Иван Петров');
      expect(r.data.description).toBe('');
      expect(r.data.workCount).toBe(0);
      expect(r.data.isActive).toBe(true);
      expect(r.data.sort).toBe(0);
      expect(r.data.slug).toBeUndefined(); // сгенерируется в action
    }
  });

  it('DesignerCreateSchema: пустое имя → ошибка', () => {
    expect(DesignerCreateSchema.safeParse({ name: '   ' }).success).toBe(false);
  });

  it('DesignerCreateSchema: невалидный slug отвергается', () => {
    expect(DesignerCreateSchema.safeParse({ name: 'X', slug: 'Bad Slug' }).success).toBe(false);
    expect(DesignerCreateSchema.safeParse({ name: 'X', slug: 'ok-slug-1' }).success).toBe(true);
  });

  it('DesignerCreateSchema: socials — словарь строк', () => {
    const ok = DesignerCreateSchema.safeParse({
      name: 'X', socials: { instagram: 'https://ig/x', vk: 'https://vk/x' },
    });
    expect(ok.success).toBe(true);
    const bad = DesignerCreateSchema.safeParse({ name: 'X', socials: { instagram: 123 } });
    expect(bad.success).toBe(false);
  });

  // Анти-XSS: videoUrl попадает в <iframe src>, socials — в <a href> публичной
  // страницы дизайнера. Пускаем ТОЛЬКО https:// (или пусто); javascript:/data:/
  // http:// отвергаются (зеркалит гвард home video.embedUrl).
  it('DesignerCreateSchema: videoUrl — только https (анти-XSS iframe)', () => {
    expect(DesignerCreateSchema.safeParse({ name: 'X', videoUrl: 'https://player.vimeo.com/video/1' }).success).toBe(true);
    expect(DesignerCreateSchema.safeParse({ name: 'X', videoUrl: '' }).success).toBe(true); // пусто = не задано
    expect(DesignerCreateSchema.safeParse({ name: 'X', videoUrl: 'javascript:alert(1)' }).success).toBe(false);
    expect(DesignerCreateSchema.safeParse({ name: 'X', videoUrl: 'http://insecure/1' }).success).toBe(false);
    expect(DesignerCreateSchema.safeParse({ name: 'X', videoUrl: 'data:text/html,<script>x</script>' }).success).toBe(false);
  });

  it('DesignerCreateSchema: socials — значение только https (анти-XSS href)', () => {
    expect(DesignerCreateSchema.safeParse({ name: 'X', socials: { ig: 'javascript:alert(document.cookie)' } }).success).toBe(false);
    expect(DesignerCreateSchema.safeParse({ name: 'X', socials: { ig: 'http://insecure' } }).success).toBe(false);
    expect(DesignerCreateSchema.safeParse({ name: 'X', socials: { ig: 'https://instagram.com/x', vk: '' } }).success).toBe(true);
  });

  it('DesignerUpdateSchema: id обязателен; translations принимаются', () => {
    const noId = DesignerUpdateSchema.safeParse({ name: 'X' });
    expect(noId.success).toBe(false);
    const ok = DesignerUpdateSchema.safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'X',
      translations: { en: { name: 'X-en', country: 'France' } },
    });
    expect(ok.success).toBe(true);
  });

  it('DesignerSetActiveSchema: uuid + boolean', () => {
    expect(
      DesignerSetActiveSchema.safeParse({ id: '11111111-1111-4111-8111-111111111111', isActive: false }).success,
    ).toBe(true);
    expect(DesignerSetActiveSchema.safeParse({ id: 'x', isActive: true }).success).toBe(false);
  });

  it('DesignerImageUploadSchema: требует Buffer bytes', () => {
    const ok = DesignerImageUploadSchema.safeParse({
      designerId: '11111111-1111-4111-8111-111111111111',
      bytes: Buffer.from([1, 2, 3]),
    });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.filename).toBe('avatar');
    const bad = DesignerImageUploadSchema.safeParse({
      designerId: '11111111-1111-4111-8111-111111111111',
      bytes: 'not-buffer',
    });
    expect(bad.success).toBe(false);
  });
});
