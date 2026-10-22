// The subscription website's users and subscriptions, as the licence system
// sees them. Same operations and results as the former standalone licence
// server's HTTP client for this site (server/src/axora.js), but called in
// process: no admin token and no network hop. The desktop app's Device ID
// (case-sensitive) is the user ID.

import { ID_RE, EMAIL_RE } from '../validation.js';

class WebsiteUnavailable extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

class Website {
  constructor(users) {
    this.users = users;
  }

  async call(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof WebsiteUnavailable || err?.code === 'P2002') throw err;
      throw new WebsiteUnavailable(`subscription database unavailable (${err?.code || err?.errorCode || 'error'})`, 'unavailable');
    }
  }

  // The user's subscription, or null when the Device ID is not registered.
  // Only an exact (case-sensitive) ID counts.
  async subscription(deviceId) {
    const user = await this.call(() => this.users.get(deviceId));
    if (!user || user.id !== deviceId) return null;
    const s = user.subscription;
    return { effectiveStatus: s.effectiveStatus, expiresAt: s.expiresAt ?? null, email: user.email };
  }

  // Adds the device as a user, 'inactive' like every new user; nothing here
  // activates it, deletes or changes an existing user. Result state:
  //   registered    created now (user: the new, inactive user)
  //   exists        this Device ID is already registered
  //   email_in_use  the email belongs to another Device ID (left untouched)
  //   invalid       the ID or email is not acceptable
  async register(deviceId, email) {
    const addr = String(email || '').trim().toLowerCase();
    const errors = [];
    if (!ID_RE.test(deviceId)) errors.push('User ID must be 3–64 characters: letters, digits, "-" or "_".');
    if (!EMAIL_RE.test(addr) || addr.length > 254) errors.push('Enter a valid email address.');
    if (errors.length) return { state: 'invalid', message: errors.join(' ') };
    try {
      return { state: 'registered', user: await this.call(() => this.users.create({ id: deviceId, email: addr })) };
    } catch (err) {
      if (err?.code !== 'P2002') throw err;
      if (/email/.test(String(err.meta?.target))) return { state: 'email_in_use', message: `A user with the email ${addr} already exists.` };
      return { state: 'exists', message: `A user with the ID ${deviceId} already exists.` };
    }
  }

  // An administrator's approval: registers the device if needed, then
  // activates it until expiresAt (ISO string, or null = lifetime).
  async activate(deviceId, email, expiresAt) {
    const reg = await this.register(deviceId, email);
    if (reg.state === 'email_in_use' || reg.state === 'invalid') return { error: { code: reg.state === 'invalid' ? 'validation_failed' : 'email_exists', message: reg.message } };
    const user = await this.call(() => this.users.activate(deviceId, expiresAt === null ? null : new Date(expiresAt)));
    if (!user) return { error: { code: 'user_not_found', message: `No user with the ID ${deviceId}.` } };
    return { user, status: user.subscription.effectiveStatus };
  }
}

export { Website, WebsiteUnavailable };
