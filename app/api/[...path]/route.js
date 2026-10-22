// Any other /api path: the same JSON 404 as before.
import { notFound } from '../../../lib/admin-api.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export { notFound as GET, notFound as POST, notFound as PUT, notFound as PATCH, notFound as DELETE };
