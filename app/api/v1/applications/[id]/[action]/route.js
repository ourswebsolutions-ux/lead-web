import { decideApplication, notFound } from '../../../../../../lib/admin-api.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const approve = decideApplication('approve');
const cancel = decideApplication('cancel');

export async function POST(request, ctx) {
  const { action } = await ctx.params;
  if (action === 'approve') return approve(request, ctx);
  if (action === 'cancel') return cancel(request, ctx);
  return notFound();
}
export { notFound as GET, notFound as PUT, notFound as PATCH, notFound as DELETE };
