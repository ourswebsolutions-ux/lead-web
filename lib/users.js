// Users and subscriptions through Prisma. Every user has exactly one
// subscription row, created with the user ('inactive' until first activated).

const WITH_SUBSCRIPTION = { subscription: true };
const ORDER = [{ createdAt: 'desc' }, { id: 'asc' }];

const iso = (d) => (d ? new Date(d).toISOString() : null);

// effectiveStatus is what access should be based on: an active subscription
// past its expiry date is reported as 'expired'.
function toUser(user, now = new Date()) {
  const s = user.subscription;
  const expired = s.status === 'active' && s.expiresAt !== null && new Date(s.expiresAt) <= now;
  return {
    id: user.id,
    email: user.email,
    createdAt: iso(user.createdAt),
    updatedAt: iso(user.updatedAt),
    subscription: {
      status: s.status,
      effectiveStatus: expired ? 'expired' : s.status,
      expiresAt: iso(s.expiresAt),
      activatedAt: iso(s.activatedAt),
      suspendedAt: iso(s.suspendedAt),
      plan: s.plan ?? null,
      updatedAt: iso(s.updatedAt),
    },
  };
}

class Users {
  constructor(prisma, { now = () => new Date() } = {}) {
    this.prisma = prisma;
    this.now = now;
  }

  // search matches the user ID exactly or by prefix (case-sensitive: the id
  // column is ascii_bin), or part of the email (case-insensitive).
  // Prisma passes startsWith/contains to LIKE unescaped on MySQL, and device
  // IDs contain "_", so LIKE wildcards are escaped here.
  async list(search = '') {
    const term = search.trim();
    const like = term.replace(/[\\%_]/g, '\\$&');
    const where = term ? { OR: [{ id: { startsWith: like } }, { email: { contains: like.toLowerCase() } }] } : undefined;
    const rows = await this.prisma.user.findMany({ where, include: WITH_SUBSCRIPTION, orderBy: ORDER });
    return rows.map((u) => toUser(u, this.now()));
  }

  async get(id) {
    const user = await this.prisma.user.findUnique({ where: { id }, include: WITH_SUBSCRIPTION });
    return user ? toUser(user, this.now()) : null;
  }

  // Creates the user and their subscription in one transaction. Throws
  // Prisma error P2002 on a duplicate ID or email.
  async create({ id, email }) {
    const user = await this.prisma.user.create({ data: { id, email, subscription: { create: { status: 'inactive' } } }, include: WITH_SUBSCRIPTION });
    return toUser(user, this.now());
  }

  async remove(id) {
    const { count } = await this.prisma.user.deleteMany({ where: { id } });
    return count === 1;
  }

  // Returns the updated user, or null if there is no such user. A given
  // plan is recorded; without one the current plan is kept.
  async activate(id, expiresAt, plan = null) {
    const { count } = await this.prisma.subscription.updateMany({
      where: { userId: id },
      data: { status: 'active', expiresAt, activatedAt: new Date(), suspendedAt: null, ...(plan ? { plan } : {}) },
    });
    return count === 1 ? this.get(id) : null;
  }

  // Revokes a subscription: back to inactive (the Free allowance). Keeps
  // the plan and expiry so the record shows what it was.
  async revoke(id) {
    const { count } = await this.prisma.subscription.updateMany({ where: { userId: id }, data: { status: 'inactive', suspendedAt: null } });
    return count === 1 ? this.get(id) : null;
  }

  // Keeps expiresAt so the record shows what the subscription was. Only a
  // change of status sets suspendedAt, so suspending twice keeps the first time.
  async suspend(id) {
    await this.prisma.subscription.updateMany({
      where: { userId: id, status: { not: 'suspended' } },
      data: { status: 'suspended', suspendedAt: new Date() },
    });
    return this.get(id);
  }
}

export { Users };
