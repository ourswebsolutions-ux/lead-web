import { listUsers, createUser, notFound } from '../../../../lib/admin-api.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export { listUsers as GET, createUser as POST, notFound as PUT, notFound as PATCH, notFound as DELETE };
