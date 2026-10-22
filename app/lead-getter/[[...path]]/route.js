// Lead Getter desktop app API and approval pages (lib/licence/handler.js).
// No admin login here: device requests carry the device's own signature.

import { licence } from '../../../lib/licence/index.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const handle = (request) => licence().handler.handle(request);
export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE, handle as HEAD, handle as OPTIONS };
