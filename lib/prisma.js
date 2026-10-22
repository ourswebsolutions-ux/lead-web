// One Prisma client per server process (also across dev hot reloads).

import { PrismaClient } from '@prisma/client';

const g = globalThis;
export const prisma = g.__axoraPrisma || (g.__axoraPrisma = new PrismaClient());
