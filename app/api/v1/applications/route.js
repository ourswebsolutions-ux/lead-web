import { listApplications, notFound } from '../../../../lib/admin-api.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export { listApplications as GET, notFound as POST, notFound as PUT, notFound as PATCH, notFound as DELETE };
