'use strict';

// Admin page. Authorization is handled by the browser (HTTP Basic, sent
// automatically to this same origin); no credentials or secrets live here.

(() => {
  const $ = (sel) => document.querySelector(sel);
  const rows = $('#rows');
  const empty = $('#empty');
  const notice = $('#notice');
  const search = $('#search');
  const addForm = $('#add-form');
  const dialog = $('#activate');
  const actForm = $('#activate-form');

  const STATUS_LABEL = { active: 'Active', expired: 'Expired', suspended: 'Suspended', inactive: 'Inactive' };
  let users = [];
  let activating = null;
  let noticeTimer = null;
  let loadSeq = 0;

  function show(type, text) {
    clearTimeout(noticeTimer);
    notice.className = `notice ${type}`;
    notice.textContent = text;
    notice.hidden = false;
    if (type === 'success') noticeTimer = setTimeout(() => (notice.hidden = true), 5000);
  }

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

  function cell(label, content, cls) {
    const td = document.createElement('td');
    if (label) td.dataset.label = label;
    if (cls) td.className = cls;
    if (content instanceof Node) td.append(content);
    else td.textContent = content;
    return td;
  }

  function button(text, cls, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn small ${cls}`;
    b.textContent = text;
    b.addEventListener('click', () => onClick(b));
    return b;
  }

  function render() {
    rows.replaceChildren();
    for (const u of users) {
      const s = u.subscription;
      const tr = document.createElement('tr');
      const badge = document.createElement('span');
      badge.className = `badge ${s.effectiveStatus}`;
      badge.textContent = STATUS_LABEL[s.effectiveStatus] || s.effectiveStatus;
      const expires = s.status === 'inactive' ? '—' : s.expiresAt ? fmtDate(s.expiresAt) : 'Never';
      const actions = document.createElement('div');
      actions.className = 'actions';
      // One subscription action: Suspend while access is active, otherwise Activate.
      if (s.effectiveStatus === 'active') actions.append(button('Suspend', '', (b) => suspend(u, b)));
      else actions.append(button('Activate', 'primary', () => openActivate(u)));
      actions.append(button('Delete', 'danger', (b) => remove(u, b)));
      tr.append(cell('User ID', u.id, 'id mono'), cell('Email', u.email), cell('Status', badge), cell('Expires', expires), cell('', actions, 'right'));
      rows.append(tr);
    }
    const term = search.value.trim();
    empty.hidden = users.length > 0;
    empty.textContent = term ? `No users match “${term}”.` : 'No users yet. Add one above.';
    $('#count').textContent = term ? `${users.length} found` : `${users.length} user${users.length === 1 ? '' : 's'}`;
  }

  async function load() {
    const seq = ++loadSeq;
    const term = search.value.trim();
    try {
      const data = await api('GET', `/users${term ? `?search=${encodeURIComponent(term)}` : ''}`);
      if (seq !== loadSeq) return;
      users = data.users;
      render();
    } catch (err) {
      if (seq === loadSeq) show('error', err.message);
    }
  }

  let searchTimer = null;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(load, 250);
  });

  addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = addForm.elements.id;
    const email = addForm.elements.email;
    id.value = id.value.trim();
    email.value = email.value.trim();
    for (const f of [id, email]) f.setAttribute('aria-invalid', String(!f.checkValidity()));
    if (!id.checkValidity()) return show('error', 'User ID must be 3–64 characters: letters, digits, "-" or "_".');
    if (!email.checkValidity()) return show('error', 'Enter a valid email address.');
    const submit = addForm.querySelector('button');
    submit.disabled = true;
    try {
      const { user } = await api('POST', '/users', { id: id.value, email: email.value });
      addForm.reset();
      await load();
      show('success', `User ${user.email} added.`);
    } catch (err) {
      show('error', err.message);
    } finally {
      submit.disabled = false;
    }
  });

  async function suspend(u, btn) {
    if (!confirm(`Suspend the subscription of ${u.email}?\nThe desktop app will stop granting access.`)) return;
    btn.disabled = true;
    try {
      await api('PATCH', `/users/${encodeURIComponent(u.id)}/subscription`, { status: 'suspended' });
      await load();
      show('success', `Subscription of ${u.email} suspended.`);
    } catch (err) {
      show('error', err.message);
      btn.disabled = false;
    }
  }

  async function remove(u, btn) {
    if (!confirm(`Delete ${u.email} (${u.id})?\nThis permanently removes the user and their subscription.`)) return;
    btn.disabled = true;
    try {
      await api('DELETE', `/users/${encodeURIComponent(u.id)}`);
      await load();
      show('success', `User ${u.email} deleted.`);
    } catch (err) {
      show('error', err.message);
      btn.disabled = false;
    }
  }

  // --- activation dialog -------------------------------------------------------

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
  function chosenExpiry() {
    const { duration, date } = actForm.elements;
    if (duration.value === 'never') return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.value);
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59).toISOString() : '';
  }

  function updatePreview() {
    const { duration, date } = actForm.elements;
    date.disabled = duration.value === 'never';
    const exp = chosenExpiry();
    $('#activate-preview').textContent = exp === null ? 'The subscription will never expire.' : exp ? `Expires ${fmtDate(exp)} (your local time).` : 'Choose an expiry date.';
  }

  function openActivate(u) {
    activating = u;
    $('#activate-user').textContent = `${u.email} · ${u.id}`;
    const { duration, date } = actForm.elements;
    duration.value = '1';
    date.min = ymd(new Date());
    date.value = ymd(addMonths(new Date(), 1));
    actError.hidden = true;
    updatePreview();
    dialog.showModal();
  }

  actForm.elements.duration.addEventListener('change', () => {
    const { duration, date } = actForm.elements;
    const months = Number(duration.value);
    if (months) date.value = ymd(addMonths(new Date(), months));
    updatePreview();
    if (duration.value === 'custom') date.focus();
  });
  actForm.elements.date.addEventListener('input', () => {
    actForm.elements.duration.value = 'custom';
    updatePreview();
  });
  $('#activate-cancel').addEventListener('click', () => dialog.close());

  const actError = $('#activate-error');
  function dialogError(text) {
    actError.textContent = text;
    actError.hidden = false;
  }

  actForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    actError.hidden = true;
    const expiresAt = chosenExpiry();
    if (expiresAt === '') return dialogError('Choose an expiry date.');
    if (expiresAt !== null && Date.parse(expiresAt) <= Date.now()) return dialogError('The expiry date must be in the future.');
    const submit = actForm.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      const { user } = await api('PATCH', `/users/${encodeURIComponent(activating.id)}/subscription`, { status: 'active', expiresAt });
      dialog.close();
      await load();
      show('success', `Subscription of ${user.email} activated${user.subscription.expiresAt ? ` until ${fmtDate(user.subscription.expiresAt)}` : ' with no expiry'}.`);
    } catch (err) {
      dialogError(err.message);
    } finally {
      submit.disabled = false;
    }
  });

  load();
})();
