import { deleteUser, notFound } from '../../../../../lib/admin-api.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export { deleteUser as DELETE, notFound as GET, notFound as POST, notFound as PUT, notFound as PATCH };
