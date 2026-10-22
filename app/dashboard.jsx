'use client';

// Admin dashboard. Authorization is handled by the browser (HTTP Basic, sent
// automatically to this same origin); no credentials or secrets live here.

import { useCallback, useEffect, useRef, useState } from 'react';

const STATUS_LABEL = { active: 'Active', expired: 'Expired', suspended: 'Suspended', inactive: 'Inactive' };
const ID_PATTERN = '[A-Za-z0-9_\\-]{3,64}';

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new Error('Could not reach the server. Check your connection and try again.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message || `Request failed (${res.status}).`);
  return data;
}

function fmtDate(isoString) {
  if (!isoString) return '';
  return new Date(isoString).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Calendar-month addition; the 31st becomes the month's last day.
function addMonths(date, months) {
  const d = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(date.getDate(), last));
  return d;
}

// Expiry is the end of the chosen day in this browser's timezone, sent as UTC.
function expiryFor(duration, date) {
  if (duration === 'never') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59).toISOString() : '';
}

function useNotice() {
  const [notice, setNotice] = useState(null);
  const timer = useRef(null);
  const show = useCallback((type, text) => {
    clearTimeout(timer.current);
    setNotice({ type, text });
    if (type === 'success') timer.current = setTimeout(() => setNotice(null), 5000);
  }, []);
  return [notice, show];
}

function ActivateDialog({ user, onClose, onDone }) {
  const ref = useRef(null);
  const [duration, setDuration] = useState('1');
  const [date, setDate] = useState(() => ymd(addMonths(new Date(), 1)));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (user && !ref.current.open) ref.current.showModal();
    if (!user && ref.current.open) ref.current.close();
    if (user) {
      setDuration('1');
      setDate(ymd(addMonths(new Date(), 1)));
      setError('');
    }
  }, [user]);

  const exp = expiryFor(duration, date);
  const preview = exp === null ? 'The subscription will never expire.' : exp ? `Expires ${fmtDate(exp)} (your local time).` : 'Choose an expiry date.';

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (exp === '') return setError('Choose an expiry date.');
    if (exp !== null && Date.parse(exp) <= Date.now()) return setError('The expiry date must be in the future.');
    setBusy(true);
    try {
      const { user: updated } = await api('PATCH', `/users/${encodeURIComponent(user.id)}/subscription`, { status: 'active', expiresAt: exp });
      await onDone(updated);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog id="activate" ref={ref} onClose={onClose}>
      <form id="activate-form" method="dialog" noValidate onSubmit={submit}>
        <h2>Activate subscription</h2>
        <p className="muted" id="activate-user">{user ? `${user.email} · ${user.id}` : ''}</p>
        <label>
          <span>Duration</span>
          <select
            name="duration"
            value={duration}
            onChange={(e) => {
              const v = e.target.value;
              setDuration(v);
              if (Number(v)) setDate(ymd(addMonths(new Date(), Number(v))));
            }}
          >
            <option value="1">1 month</option>
            <option value="6">6 months</option>
            <option value="12">1 year</option>
            <option value="custom">Custom expiry date</option>
            <option value="never">No expiry (lifetime)</option>
          </select>
        </label>
        <label>
          <span>Expiry date</span>
          <input
            name="date"
            type="date"
            required
            min={ymd(new Date())}
            value={date}
            disabled={duration === 'never'}
            onChange={(e) => {
              setDate(e.target.value);
              setDuration('custom');
            }}
          />
        </label>
        <p className="muted small" id="activate-preview">{preview}</p>
        {error && (
          <p className="notice error" id="activate-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" id="activate-cancel" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            Activate
          </button>
        </div>
      </form>
    </dialog>
  );
}

function Applications({ show, onChange, reloadKey }) {
  const [filter, setFilter] = useState('pending');
  const [apps, setApps] = useState([]);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await api('GET', `/applications${filter ? `?status=${filter}` : ''}`);
      setApps(data.applications);
    } catch (err) {
      show('error', err.message);
    }
  }, [filter, show]);

  useEffect(() => {
    load();
  }, [load, reloadKey]);

  async function decide(a, action) {
    const question =
      action === 'approve'
        ? `Approve application ${a.id} (${a.planName}, ${a.priceLabel}) for ${a.email}?\nThe subscription is activated for this device.`
        : `Cancel application ${a.id} for ${a.email}?\nNo subscription is activated.`;
    if (!confirm(question)) return;
    setBusy(a.id);
    try {
      const { application } = await api('POST', `/applications/${encodeURIComponent(a.id)}/${action}`);
      await load();
      await onChange();
      show('success', action === 'approve' ? `Application ${a.id} approved: ${application.user?.subscription.expiresAt ? `active until ${fmtDate(application.user.subscription.expiresAt)}` : 'active with no expiry'}.` : `Application ${a.id} cancelled.`);
    } catch (err) {
      show('error', err.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <section className="card">
      <div className="list-head">
        <h2>Payment approvals</h2>
        <select aria-label="Show applications" value={filter} onChange={(e) => setFilter(e.target.value)} className="filter">
          <option value="pending">Pending</option>
          <option value="">All</option>
          <option value="approved">Approved</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Application</th>
              <th>Email</th>
              <th>Plan</th>
              <th>Submitted</th>
              <th className="right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {apps.map((a) => (
              <tr key={a.id}>
                <td data-label="Application" className="id mono">
                  {a.id}
                  <span className="sub">{a.deviceId}</span>
                </td>
                <td data-label="Email">
                  {a.email || '—'}
                  {a.message && <span className="sub">{a.message}</span>}
                </td>
                <td data-label="Plan">
                  {a.planName} <span className="sub">{a.priceLabel}</span>
                </td>
                <td data-label="Submitted">{fmtDate(a.createdAt)}</td>
                <td className="right">
                  <div className="actions">
                    {a.hasScreenshot && (
                      <a className="btn small" href={`/api/v1/applications/${encodeURIComponent(a.id)}/screenshot`} target="_blank" rel="noreferrer">
                        Payment
                      </a>
                    )}
                    {a.status === 'pending' ? (
                      <>
                        <button type="button" className="btn small primary" disabled={busy === a.id} onClick={() => decide(a, 'approve')}>
                          Approve
                        </button>
                        <button type="button" className="btn small danger" disabled={busy === a.id} onClick={() => decide(a, 'cancel')}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <span className={`badge ${a.status === 'approved' ? 'active' : 'inactive'}`}>{a.status === 'approved' ? 'Approved' : 'Cancelled'}</span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {apps.length === 0 && <p className="empty">{filter === 'pending' ? 'No payments waiting for approval.' : 'No applications.'}</p>}
    </section>
  );
}

export default function Dashboard() {
  const [notice, show] = useNotice();
  const [users, setUsers] = useState([]);
  const [term, setTerm] = useState('');
  const [activating, setActivating] = useState(null);
  const [busy, setBusy] = useState('');
  const [adding, setAdding] = useState(false);
  const [invalid, setInvalid] = useState({});
  const [appsKey, setAppsKey] = useState(0);
  const seq = useRef(0);
  const termRef = useRef('');

  const load = useCallback(async () => {
    const mine = ++seq.current;
    const t = termRef.current.trim();
    try {
      const data = await api('GET', `/users${t ? `?search=${encodeURIComponent(t)}` : ''}`);
      if (mine === seq.current) setUsers(data.users);
    } catch (err) {
      if (mine === seq.current) show('error', err.message);
    }
  }, [show]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    termRef.current = term;
    const timer = setTimeout(load, 250);
    return () => clearTimeout(timer);
  }, [term, load]);

  async function add(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const id = form.elements.id;
    const email = form.elements.email;
    id.value = id.value.trim();
    email.value = email.value.trim();
    setInvalid({ id: !id.checkValidity(), email: !email.checkValidity() });
    if (!id.checkValidity()) return show('error', 'User ID must be 3–64 characters: letters, digits, "-" or "_".');
    if (!email.checkValidity()) return show('error', 'Enter a valid email address.');
    setAdding(true);
    try {
      const { user } = await api('POST', '/users', { id: id.value, email: email.value });
      form.reset();
      await load();
      show('success', `User ${user.email} added.`);
    } catch (err) {
      show('error', err.message);
    } finally {
      setAdding(false);
    }
  }

  async function suspend(u) {
    if (!confirm(`Suspend the subscription of ${u.email}?\nThe desktop app will stop granting access.`)) return;
    setBusy(u.id);
    try {
      await api('PATCH', `/users/${encodeURIComponent(u.id)}/subscription`, { status: 'suspended' });
      await load();
      show('success', `Subscription of ${u.email} suspended.`);
    } catch (err) {
      show('error', err.message);
    } finally {
      setBusy('');
    }
  }

  async function remove(u) {
    if (!confirm(`Delete ${u.email} (${u.id})?\nThis permanently removes the user and their subscription.`)) return;
    setBusy(u.id);
    try {
      await api('DELETE', `/users/${encodeURIComponent(u.id)}`);
      await load();
      setAppsKey((k) => k + 1);
      show('success', `User ${u.email} deleted.`);
    } catch (err) {
      show('error', err.message);
    } finally {
      setBusy('');
    }
  }

  const t = term.trim();
  return (
    <>
      <header className="top">
        <div className="wrap top-inner">
          <div className="brand">
            <span className="logo" aria-hidden="true">
              A
            </span>
            <div>
              <strong>Axora Web Solutions</strong>
              <span>Subscription management</span>
            </div>
          </div>
          <span className="count" id="count" aria-live="polite">
            {t ? `${users.length} found` : `${users.length} user${users.length === 1 ? '' : 's'}`}
          </span>
        </div>
      </header>

      <main className="wrap">
        <div id="notice" className={`notice ${notice?.type || ''}`} role="status" aria-live="polite" hidden={!notice}>
          {notice?.text}
        </div>

        <section className="card">
          <h2>Add user</h2>
          <form id="add-form" className="add-form" noValidate onSubmit={add}>
            <label>
              <span>User ID</span>
              <input name="id" required minLength={3} maxLength={64} pattern={ID_PATTERN} autoComplete="off" spellCheck={false} placeholder="Lead Getter Device ID" aria-invalid={invalid.id ? 'true' : 'false'} />
            </label>
            <label>
              <span>Email</span>
              <input name="email" type="email" required maxLength={254} autoComplete="off" placeholder="customer@example.com" aria-invalid={invalid.email ? 'true' : 'false'} />
            </label>
            <button type="submit" className="btn primary" disabled={adding}>
              Add user
            </button>
          </form>
        </section>

        <Applications show={show} onChange={load} reloadKey={appsKey} />

        <section className="card">
          <div className="list-head">
            <h2>Users</h2>
            <input id="search" type="search" placeholder="Search by email or user ID" aria-label="Search by email or user ID" autoComplete="off" spellCheck={false} value={term} onChange={(e) => setTerm(e.target.value)} />
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>User ID</th>
                  <th>Email</th>
                  <th>Status</th>
                  <th>Expires</th>
                  <th className="right">Actions</th>
                </tr>
              </thead>
              <tbody id="rows">
                {users.map((u) => {
                  const s = u.subscription;
                  return (
                    <tr key={u.id}>
                      <td data-label="User ID" className="id mono">
                        {u.id}
                      </td>
                      <td data-label="Email">{u.email}</td>
                      <td data-label="Status">
                        <span className={`badge ${s.effectiveStatus}`}>{STATUS_LABEL[s.effectiveStatus] || s.effectiveStatus}</span>
                      </td>
                      <td data-label="Expires">{s.status === 'inactive' ? '—' : s.expiresAt ? fmtDate(s.expiresAt) : 'Never'}</td>
                      <td className="right">
                        <div className="actions">
                          {/* One subscription action: Suspend while access is active, otherwise Activate. */}
                          {s.effectiveStatus === 'active' ? (
                            <button type="button" className="btn small " disabled={busy === u.id} onClick={() => suspend(u)}>
                              Suspend
                            </button>
                          ) : (
                            <button type="button" className="btn small primary" onClick={() => setActivating(u)}>
                              Activate
                            </button>
                          )}
                          <button type="button" className="btn small danger" disabled={busy === u.id} onClick={() => remove(u)}>
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {users.length === 0 && (
            <p id="empty" className="empty">
              {t ? `No users match “${t}”.` : 'No users yet. Add one above.'}
            </p>
          )}
        </section>
      </main>

      <ActivateDialog
        user={activating}
        onClose={() => setActivating(null)}
        onDone={async (updated) => {
          setActivating(null);
          await load();
          show('success', `Subscription of ${updated.email} activated${updated.subscription.expiresAt ? ` until ${fmtDate(updated.subscription.expiresAt)}` : ' with no expiry'}.`);
        }}
      />
    </>
  );
}
