// /download/<id>: starts the installer download (redirect to the file).

import { DOWNLOADS } from '../../../lib/downloads.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request, { params }) {
  const { id } = await params;
  const d = Object.hasOwn(DOWNLOADS, id) ? DOWNLOADS[id] : null;
  if (!d) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  return new Response(null, { status: 302, headers: { location: d.url, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
}
