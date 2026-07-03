/**
 * GET /media/<key...> — отдача загруженных медиа в LOCAL-режиме хранилища
 * (деплой без Docker/MinIO). В S3-режиме медиа отдаёт объектное хранилище/Caddy;
 * этот роут универсален — читает через слой storage (ObjectStorage.get()). Путь
 * /media согласован с LocalStorage.publicBase (S3_PUBLIC_URL) и S3 path-style.
 *
 * Ниша-агностично: без бизнес-логики магазина. resolveSafe в LocalStorage
 * защищает от path-traversal.
 */
import { createStorage } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ key: string[] }> },
): Promise<Response> {
  const { key } = await ctx.params;
  const objectKey = (key ?? []).join('/');
  if (!objectKey) return new Response('Not found', { status: 404 });
  try {
    const { body, contentType } = await createStorage().get(objectKey);
    return new Response(new Uint8Array(body), {
      headers: {
        'Content-Type': contentType ?? 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
