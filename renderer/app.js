'use strict';

// ============================================================
// FlowStudio Lite renderer (v2.6.0)
// Views: Accounts · Generate · History · Activity · Import · Settings
// ============================================================

// ---------- Helpers ----------
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function statusChip(status) {
  const key = String(status || '').toLowerCase().replace(/\s+/g, '');
  return el('span', `chip ${key}`, status || 'Unknown');
}

function accountDisplayName(acc) {
  return (acc && (acc.googleName || acc.name || acc.email)) || 'Google Account';
}

// ---------- In-app dialogs + toasts (v2.1.0) ----------
// Electron does NOT implement the browser's built-in dialog functions:
// calling them returns null / does nothing, so every handler that used
// one died silently on the owner's PC (v2.0.0's Add Account and the
// single Cookies-se-Add button were both dead for exactly this reason).
// All renderer dialogs are this in-app modal + toast system now, and a
// smoke test fails the build if the old calls ever come back.
const modalOverlay = document.getElementById('modal-overlay');
const modalTitle = document.getElementById('modal-title');
const modalMessage = document.getElementById('modal-message');
const modalInputWrap = document.getElementById('modal-input-wrap');
const modalInputLabel = document.getElementById('modal-input-label');
const modalInput = document.getElementById('modal-input');
const modalInput2Wrap = document.getElementById('modal-input2-wrap');
const modalInput2Label = document.getElementById('modal-input2-label');
const modalInput2 = document.getElementById('modal-input2');
const modalOkBtn = document.getElementById('modal-ok');
const modalCancelBtn = document.getElementById('modal-cancel');
let modalResolve = null;

function closeModal(result) {
  if (!modalResolve) return;
  const resolve = modalResolve;
  modalResolve = null;
  modalOverlay.hidden = true;
  resolve(result);
}

function modalValues() {
  return {
    value: modalInputWrap.hidden ? null : modalInput.value,
    value2: modalInput2Wrap.hidden ? null : modalInput2.value
  };
}

function showModal({ title, message = '', inputLabel = null, inputPlaceholder = '', initialValue = '', input2Label = null, input2Placeholder = '', okText = 'OK', cancelText = 'Cancel', danger = false }) {
  if (modalResolve) closeModal({ ok: false, value: null, value2: null });
  modalTitle.textContent = title || 'FlowStudio Lite';
  modalMessage.textContent = message || '';
  modalMessage.style.display = message ? 'block' : 'none';
  const hasInput = inputLabel !== null && inputLabel !== undefined;
  modalInputWrap.hidden = !hasInput;
  if (hasInput) {
    modalInputLabel.textContent = inputLabel;
    modalInput.value = initialValue;
    modalInput.placeholder = inputPlaceholder || '';
  }
  // v2.2.0: an optional SECOND field (the Add Account modal's optional
  // email). Resolves as `value2`.
  const hasInput2 = input2Label !== null && input2Label !== undefined;
  modalInput2Wrap.hidden = !hasInput2;
  if (hasInput2) {
    modalInput2Label.textContent = input2Label;
    modalInput2.value = '';
    modalInput2.placeholder = input2Placeholder || '';
  }
  modalOkBtn.textContent = okText;
  modalOkBtn.className = danger ? 'danger-ok' : 'primary';
  modalCancelBtn.style.display = cancelText ? '' : 'none';
  modalCancelBtn.textContent = cancelText || 'Cancel';
  modalOverlay.hidden = false;
  if (hasInput) {
    setTimeout(() => { try { modalInput.focus(); modalInput.select(); } catch (e) {} }, 30);
  }
  return new Promise(resolve => { modalResolve = resolve; });
}

modalOkBtn.addEventListener('click', () => {
  closeModal({ ok: true, ...modalValues() });
});
modalCancelBtn.addEventListener('click', () => closeModal({ ok: false, value: null, value2: null }));
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal({ ok: false, value: null, value2: null });
});
modalInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (!modalInput2Wrap.hidden) { try { modalInput2.focus(); } catch (err) {} return; }
    closeModal({ ok: true, ...modalValues() });
  }
});
modalInput2.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    closeModal({ ok: true, ...modalValues() });
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modalOverlay.hidden) closeModal({ ok: false, value: null });
});

/** Info dialog the user dismisses with OK. */
async function showInfoModal(title, message) {
  await showModal({ title, message, okText: 'OK', cancelText: null });
}

/** Yes/no question. Resolves true only on the OK button. */
async function showConfirmModal(title, message, { okText = 'Haan', cancelText = 'Cancel', danger = false } = {}) {
  const res = await showModal({ title, message, okText, cancelText, danger });
  return !!(res && res.ok);
}

/** Text input dialog. Resolves the typed string, or null on cancel. */
async function showInputModal({ title, message = '', label, placeholder = '', initialValue = '', okText = 'Add' }) {
  const res = await showModal({ title, message, inputLabel: label, inputPlaceholder: placeholder, initialValue, okText, cancelText: 'Cancel' });
  if (!res || !res.ok) return null;
  return typeof res.value === 'string' ? res.value : '';
}

/** Small non-blocking message (bottom-right), auto-dismissed. */
function showToast(message, type = 'info') {
  const wrap = document.getElementById('toast-wrap');
  if (!wrap || !message) return;
  const toast = el('div', `toast ${type}`, message);
  wrap.appendChild(toast);
  setTimeout(() => { try { toast.remove(); } catch (e) {} }, 5000);
}

/** Clipboard with a legacy fallback; resolves true when copied. */
async function copyTextToClipboard(text) {
  const value = String(text || '');
  if (!value) return false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (e) { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return !!ok;
  } catch (e) {
    return false;
  }
}

/**
 * The clipboard shape for one activity entry — IDENTICAL to
 * engine/activityStore.js formatEntryForCopy (the renderer cannot
 * require engine modules, so the format lives in both places; the
 * smoke test pins the engine side).
 */
function formatActivityEntryForCopy(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const lines = [];
  const when = entry.ts ? new Date(entry.ts).toLocaleString() : (entry.time || '');
  lines.push(`[${when}] ${String(entry.message || '').trim()}`);
  if (entry.accountName) lines.push(`Account: ${entry.accountName}`);
  if (entry.promptIndex !== null && entry.promptIndex !== undefined) lines.push(`Prompt #: ${entry.promptIndex + 1}`);
  if (entry.stage) lines.push(`Stage: ${entry.stage}`);
  if (entry.category) lines.push(`Category: ${entry.category}`);
  if (entry.level) lines.push(`Level: ${entry.level}`);
  if (entry.detail) lines.push(`Detail: ${entry.detail}`);
  if (entry.reason) lines.push(`Reason: ${entry.reason}`);
  if (entry.taskId) lines.push(`Task ID: ${entry.taskId}`);
  return lines.join('\n');
}

/**
 * v2.2.0 line formats — IDENTICAL to engine/activityStore.js
 * formatEntrySimple / formatEntryDetailLine (same renderer/engine
 * split as the copy format above; the smoke test pins the engine
 * side). Simple = "[time] ✔ message". Details adds the story bits.
 */
const ACTIVITY_LEVEL_ICONS = { success: '✔', warn: '⚠', error: '✘', info: '●' };

function activityLevelIcon(level) {
  return ACTIVITY_LEVEL_ICONS[level] || ACTIVITY_LEVEL_ICONS.info;
}

function formatActivityEntrySimple(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const time = entry.time || (entry.ts ? new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
  const head = time ? `[${time}] ` : '';
  return `${head}${activityLevelIcon(entry.level)} ${String(entry.message || '').trim()}`.trim();
}

function formatActivityEntryDetailLine(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const base = formatActivityEntrySimple(entry);
  const bits = [];
  if (entry.accountName) bits.push(`Account: ${entry.accountName}`);
  if (entry.promptIndex !== null && entry.promptIndex !== undefined) bits.push(`Prompt #${entry.promptIndex + 1}`);
  if (entry.stage) bits.push(`Stage: ${entry.stage}`);
  if (entry.reason) bits.push(`Reason: ${entry.reason}`);
  return bits.length ? `${base} — ${bits.join(' · ')}` : base;
}

// ---------- Appearance (Dark / White / System, persisted) ----------
let appearanceMode = 'dark';

function applyAppearance(mode) {
  appearanceMode = ['dark', 'white', 'system'].includes(mode) ? mode : 'dark';
  let resolved = appearanceMode;
  if (resolved === 'system') {
    resolved = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'white' : 'dark';
  }
  if (resolved === 'white') document.documentElement.setAttribute('data-theme', 'white');
  else document.documentElement.removeAttribute('data-theme');
  document.querySelectorAll('#appearance-seg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.appearance === appearanceMode));
}

async function setAppearance(mode, save = true) {
  applyAppearance(mode);
  if (save) {
    try { await window.api.setSetting('appearance', appearanceMode); } catch (e) {}
  }
}

document.querySelectorAll('#appearance-seg .seg-btn').forEach(btn => {
  btn.addEventListener('click', () => setAppearance(btn.dataset.appearance));
});
/* v2.11.0: the sidebar Appearance quick button is GONE — the owner
   ruled Appearance lives only in the Settings tab. */

// ---------- View switching ----------
const navBtns = document.querySelectorAll('.nav-btn');
function switchTo(view) {
  navBtns.forEach(t => t.classList.toggle('active', t.dataset.view === view));
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const target = document.getElementById(`view-${view}`);
  if (target) target.classList.add('active');
  if (view === 'history') loadHistory();
  if (view === 'generate') { refreshResumeBanner(); refreshDashboard(); }
  if (view === 'activity') renderActivityFull();
  if (view === 'import') loadChromeProfiles();
  if (view === 'settings') loadSettings();
  // v2.10.0: alag Accounts view nahi raha — accounts ka vertical
  // box sidebar me hamesha maujood hai (ZDola-style), isliye yahan
  // koi accounts branch nahi. Dashboard ki ginati sidebar ki stats
  // line me jaati hai (refreshDashboard).
}
navBtns.forEach(btn => btn.addEventListener('click', () => switchTo(btn.dataset.view)));
const gotoRotationBtn = document.getElementById('btn-goto-rotation-settings');
if (gotoRotationBtn) gotoRotationBtn.addEventListener('click', () => switchTo('settings'));

// ---------- Accounts ----------
const accountsEmpty = document.getElementById('accounts-empty');
let currentAccounts = [];
// Per-account messages (login/credit errors and confirmations) are shown
// as visible text ON the card — never silent, never console-only.
const accountMessages = new Map(); // accountId -> { text, isError }
// v2.0.0: live 🍪 cookie-check states per account (from IPC phase events
// and import results): accountId -> { state, reason }
const cookieStates = new Map();

// v2.5.0: the Accounts list now sits in a ZDola-style panel BOX —
// filter tabs (Sab / Live / Ready / Fail, counts included), a tick
// on every row, a bulk action bar (Sync / Delete selected) and a
// status line. "Live ready" means the same thing the dashboard has
// always counted: status Ready or Low Credits.
let accountFilter = 'all'; // 'all' | 'live' | 'ready' | 'fail'
const selectedAccounts = new Set();
// v2.13.0: profile accounts whose sign-in window is open and whose
// "Done" confirmation is still pending — their sidebar line shows
// the Done button until the login is confirmed.
const loginPendingIds = new Set();

function isLiveReadyAccount(acc) {
  return !!acc && (acc.status === 'Ready' || acc.status === 'Low Credits');
}
function isFailedAccount(acc) {
  if (!acc) return false;
  if (acc.status === 'Need Login' || acc.status === 'Exhausted') return true;
  const cs = cookieStates.get(acc.id);
  return !!cs && cs.state === 'fail';
}
// v2.13.0: ONE state per account for the unified sidebar lines —
// the cookie-check state when there is one, else a state derived
// from the account's own status. States: checking | live | ready |
// fail (fail carries a plain-English reason in the line's meta).
function lineStateOf(acc) {
  const cs = cookieStateOf(acc);
  if (cs) return cs;
  const s = String((acc && acc.status) || '');
  if (s === 'Live') return { state: 'live', reason: '' };
  if (s === 'Ready' || s === 'Low Credits') return { state: 'ready', reason: '' };
  if (s === 'Cooldown') return { state: 'ready', reason: 'Cooldown' };
  if (s === 'Need Login') return { state: 'fail', reason: 'Need login' };
  if (s === 'Unconfirmed') return { state: 'fail', reason: 'Login unconfirmed' };
  if (s === 'Exhausted') return { state: 'fail', reason: 'Credits finished' };
  return { state: 'fail', reason: s || 'Not checked yet' };
}
function lineMatchesFilter(acc, filter) {
  if (!filter || filter === 'all') return true;
  const st = lineStateOf(acc);
  if (filter === 'live') return st.state === 'live' || st.state === 'ready';
  return st.state === filter;
}
function accountFilterCounts() {
  const counts = { all: currentAccounts.length, checking: 0, live: 0, fail: 0 };
  for (const acc of currentAccounts) {
    const st = lineStateOf(acc);
    if (st.state === 'checking') counts.checking += 1;
    else if (st.state === 'fail') counts.fail += 1;
    else counts.live += 1; // live + ready
  }
  return counts;
}
function updateAccountsBoxChrome() {
  const counts = accountFilterCounts();
  const sel = selectedAccounts.size;
  const syncBtn = document.getElementById('btn-accounts-sync-selected');
  const delBtn = document.getElementById('btn-accounts-delete-selected');
  if (syncBtn) syncBtn.disabled = sel === 0;
  if (delBtn) delBtn.disabled = sel === 0;
  // v2.13.0: status line counts come from the unified line states —
  // "not confirmed" = failed-with-an-unconfirmed/not-checked reason
  // or still checking; Verify All settles those.
  const liveReady = currentAccounts.filter(a => { const s = lineStateOf(a); return s.state === 'live' || s.state === 'ready'; }).length;
  const notConfirmed = currentAccounts.filter(a => { const s = lineStateOf(a); return s.state === 'checking' || s.reason === 'Login unconfirmed' || s.reason === 'Not checked yet'; }).length;
  const line = document.getElementById('accounts-status-line');
  if (line) {
    line.textContent = `${sel} of ${counts.all} selected · ${liveReady} live ready · ${notConfirmed} not confirmed${notConfirmed > 0 ? ' (press Verify All)' : ''}`;
  }
  const selAll = document.getElementById('btn-select-all-accounts');
  if (selAll) {
    const visible = currentAccounts.filter(a => lineMatchesFilter(a, cookieFilter));
    const allSel = visible.length > 0 && visible.every(a => selectedAccounts.has(a.id));
    selAll.textContent = allSel ? 'Select none' : 'Select all';
  }
}

function setAccountMessage(id, text, isError) {
  if (!id) return;
  if (text) accountMessages.set(id, { text, isError: !!isError });
  else accountMessages.delete(id);
}

const LOW_CREDIT_THRESHOLD = 10;

function cookieChipFor(acc) {
  const st = cookieStates.get(acc.id);
  if (!st && !acc.hasCookies) return null;
  const wrap = el('div', 'cookie-line');
  if (st) {
    const chip = el('span', `cookie-chip ${st.state}`);
    chip.textContent = st.state === 'checking' ? '🍪 Checking…'
      : st.state === 'live' ? `🍪 Live${st.reason ? ` · ${st.reason}` : ''}`
      : st.state === 'ready' ? `🍪 Ready${st.reason ? ` · ${st.reason}` : ''}`
      : `🍪 Fail — ${st.reason || 'check fail'}`;
    wrap.appendChild(chip);
  } else {
    wrap.appendChild(el('span', 'cookie-chip', '🍪 Cookies saved'));
  }
  if (acc.hasCookies) {
    const reBtn = el('button', 'mini-btn', '🍪 Re-check');
    reBtn.addEventListener('click', async () => {
      reBtn.disabled = true;
      cookieStates.set(acc.id, { state: 'checking', reason: '' });
      renderAccounts(currentAccounts);
      try {
        const res = await window.api.recheckCookies(acc.id);
        if (res && res.accounts) renderAccounts(res.accounts);
        if (res && res.check) {
          cookieStates.set(acc.id, { state: res.check.state, reason: res.check.reason || '' });
        }
        if (res && res.success === false && !(res && res.check)) {
          cookieStates.delete(acc.id);
          setAccountMessage(acc.id, res.error || 'Cookie re-check failed.', true);
        } else if (res && res.check && res.check.state === 'fail') {
          setAccountMessage(acc.id, `Cookie check failed — ${res.check.reason}.`, true);
        } else if (res) {
          setAccountMessage(acc.id, null, false);
        }
      } catch (err) {
        cookieStates.delete(acc.id);
        setAccountMessage(acc.id, `Cookie re-check fail: ${err.message}`, true);
      }
      reBtn.disabled = false;
      renderAccounts(currentAccounts);
      refreshDashboard();
    });
    wrap.appendChild(reBtn);
  }
  return wrap;
}

// v2.4.0 (owner's demand, ZDola screenshot): the Accounts list is
// COMPACT ROWS now, not big cards — with 10–50 accounts the cards
// ate the whole page. One row per account: status icon · name/email
// · one haalat line (status + credits + videos count) · the same
// buttons, smaller. Cookie chip + wajah and per-account messages
// stay as sub-lines inside the row; nothing was removed.
const ACC_STATUS_ICON = {
  ready: { icon: '✓', tone: 'ok' },
  lowcredits: { icon: '✓', tone: 'warn' },
  needlogin: { icon: '✕', tone: 'bad' },
  exhausted: { icon: '✕', tone: 'bad' },
  cooldown: { icon: '⏸', tone: 'warn' },
  unconfirmed: { icon: '?', tone: 'warn' }
};

function renderAccounts(accounts) {
  currentAccounts = accounts || [];
  // Selections of accounts that no longer exist are dropped quietly.
  const existingIds = new Set(currentAccounts.map(a => a.id));
  for (const id of [...selectedAccounts]) {
    if (!existingIds.has(id)) selectedAccounts.delete(id);
  }
  for (const id of [...loginPendingIds]) {
    if (!existingIds.has(id)) loginPendingIds.delete(id);
  }
  renderAccountLines();
  updateAccountsBoxChrome();
}

// v2.5.0: Accounts box ke controls — bulk Sync/Delete, selection
// saaf, aur "Sirf live accounts chalao" toggle (setting
// 'live_only_accounts'; generation ke pool selection me iska samman
// workerPool karta hai, createPool har run par taaza padhta hai).

document.getElementById('btn-accounts-sync-selected').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const ids = [...selectedAccounts];
  if (ids.length === 0) return;
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  let fresh = null;
  for (const id of ids) {
    try {
      const res = await window.api.syncAccount(id);
      if (res && res.accounts) fresh = res.accounts;
    } catch (err) { /* ek account ka fail baakiyon ko nahi rokta */ }
  }
  if (fresh) renderAccounts(fresh);
  btn.disabled = false;
  btn.textContent = '✔ Sync Selected';
  updateAccountsBoxChrome();
  refreshDashboard();
  showToast(`${ids.length} account(s) synced.`, 'success');
});

document.getElementById('btn-accounts-delete-selected').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const ids = [...selectedAccounts];
  if (ids.length === 0) return;
  const names = ids
    .map(id => { const a = currentAccounts.find(x => x.id === id); return a ? (a.googleName || a.name) : id; })
    .join(', ');
  const yes = await showConfirmModal(
    'Remove the selected accounts?',
    `${ids.length} account(s) will be removed: ${names}\n\nTheir saved login profiles and saved cookies will also be deleted. This cannot be undone.`,
    { okText: 'Yes, remove them', danger: true }
  );
  if (!yes) return;
  btn.disabled = true;
  let fresh = null;
  for (const id of ids) {
    try {
      const res = await window.api.deleteAccount(id);
      if (res && res.accounts) fresh = res.accounts;
    } catch (err) { /* ek ka fail baakiyon ko nahi rokta */ }
    selectedAccounts.delete(id);
  }
  if (fresh) renderAccounts(fresh);
  else renderAccounts(currentAccounts);
  btn.disabled = false;
  refreshDashboard();
  showToast(`${ids.length} account(s) removed.`, 'success');
});

document.getElementById('btn-accounts-clear-selection').addEventListener('click', () => {
  selectedAccounts.clear();
  renderAccounts(currentAccounts);
});

// v2.10.0: sidebar box ke head ka "Select all" link — dikh rahe
// (filtered) accounts ko ek saath select; saare selected hon to
// wahi click selection saaf kar deta hai (label updateAccountsBox-
// Chrome badalta hai).
const selectAllBtn = document.getElementById('btn-select-all-accounts');
if (selectAllBtn) selectAllBtn.addEventListener('click', () => {
  const visible = currentAccounts.filter(a => lineMatchesFilter(a, cookieFilter));
  if (visible.length === 0) return;
  const allSel = visible.every(a => selectedAccounts.has(a.id));
  if (allSel) visible.forEach(a => selectedAccounts.delete(a.id));
  else visible.forEach(a => selectedAccounts.add(a.id));
  renderAccounts(currentAccounts);
});

document.getElementById('accounts-live-only').addEventListener('change', async (e) => {
  try { await window.api.setSetting('live_only_accounts', e.target.checked ? '1' : '0'); } catch (err) {}
  showToast(e.target.checked
    ? 'Generation will now use only Live / Ready accounts.'
    : 'Generation will now use all eligible accounts (as before).', 'info');
});

function updateSidebarTotals() {
  const known = currentAccounts.filter(a => typeof a.credits === 'number');
  const total = known.reduce((s, a) => s + a.credits, 0);
  const live = currentAccounts.filter(a => a.status === 'Ready' || a.status === 'Low Credits').length;
  document.getElementById('side-total-credits').textContent = known.length ? String(total) : '—';
  document.getElementById('side-total-sub').textContent =
    `${currentAccounts.length} account(s) · ${live} live`;
  // v2.5.0: the workers box is gone from Generate (control lives in
  // Settings); only this one small status line remains there, fed by
  // the saved limit.
  // v2.7.0 (FIX 4): wahi line ab tay shakal me hai — "Seema (Settings
  // se): 3 · Live uplabdh: 1 · Abhi chal rahe: 1" — aur run ke dauran
  // pool ki bheji hui asal ginati se taaza hoti rehti hai.
  genLineState.live = live;
  renderGenAccountsLine();
}

// v2.7.0 (FIX 4): Generate ki ginati line ka ek hi hisaab-kitab.
// seema = Settings ki saved limit; live = asal me uplabdh (live-ready)
// accounts; chal = abhi sach me chal rahe workers (pool batata hai).
const genLineState = { seema: null, live: null, chal: 0 };
function renderGenAccountsLine() {
  const note = document.getElementById('gen-live-note');
  if (!note) return;
  const seema = genLineState.seema !== null ? genLineState.seema : savedConcurrencyLimit;
  const live = genLineState.live !== null ? genLineState.live : '—';
  note.textContent = `Parallel browsers: ${seema} · Mode: ${showBrowsersOn ? 'Visible' : 'Hidden'} · Live available: ${live} · Running now: ${genLineState.chal}`;
}

async function refreshDashboard() {
  try {
    const d = await window.api.getCreditDashboard();
    if (!d) return;
    // v2.10.0: purani Accounts-page wali 5 badi stat cards gayi —
    // wahi ginati ab sidebar ke vertical box ki EK compact stats
    // line me aati hai (ZDola ki "All-time · today" line ki tarah).
    const line = document.getElementById('side-stats-line');
    if (line) {
      line.textContent = `Total credits ${d.totalCredits} · Live ${d.liveCount}/${d.accountCount} · Today's spend (est.) ~${d.spendToday} · Today's videos ${d.todayVideos}`;
    }
    document.getElementById('side-total-credits').textContent = String(d.totalCredits);
    document.getElementById('side-total-sub').textContent = `${d.accountCount} account(s) · ${d.liveCount} live`;
  } catch (e) { /* dashboard is best-effort; rows carry the same numbers */ }
}

async function loadAccounts() {
  try {
    const accounts = await window.api.getAccounts();
    renderAccounts(accounts);
  } catch (err) {
    renderAccounts([]);
    accountsEmpty.textContent = `Accounts could not be loaded: ${err.message} — close the app and open it again.`;
  }
  refreshDashboard();
}

document.getElementById('btn-add-account').addEventListener('click', () => {
  // v2.11.0 FINAL: Add Account opens the chooser popup with the three
  // routes (Gmail Login · Add Cookies · Chrome Profiles).
  const ov = document.getElementById('addaccount-overlay');
  if (ov) { ov.hidden = false; return; }
  gmailLoginFlow();
});

async function gmailLoginFlow() {
  // Name only — email optional, no confirm chain. The account is
  // created the moment you press Add; sign-in happens from the
  // account's own Sign In / Chrome button.
  const res = await showModal({
    title: '+ New Account',
    message: 'Just write a name — the account is added right away. Sign in from its card with the "Sign In" button.',
    inputLabel: 'Account name',
    inputPlaceholder: 'e.g. My Gmail 1',
    input2Label: 'Email (optional — just a reminder, not required)',
    input2Placeholder: 'e.g. my.account@gmail.com',
    okText: 'Add',
    cancelText: 'Cancel'
  });
  if (!res || !res.ok) return;
  try {
    const out = await window.api.addAccount((res.value || '').trim(), (res.value2 || '').trim());
    if (out && out.accounts) renderAccounts(out.accounts);
    refreshDashboard();
    if (out && out.account) {
      setAccountMessage(out.account.id, 'Account added ✔ — now press "Sign In" on its card and log in to Google once; the login stays saved.', false);
      renderAccounts(currentAccounts);
      showToast(`Account added: ${out.account.name} — sign in from its card.`, 'success');
    }
  } catch (err) {
    await showInfoModal('Could not add the account', err.message);
  }
}

document.getElementById('btn-sync-all').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Verifying…';
  try {
    const res = await window.api.syncAllAccounts();
    if (res && res.accounts) renderAccounts(res.accounts);
    if (res && res.summary) {
      const s = res.summary;
      document.getElementById('verify-summary').textContent =
        `Checked ${s.total}: ${s.live} live · ${s.low} low credits · ${s.exhausted} exhausted · ${s.needLogin} need login · ${s.unconfirmed} unconfirmed · ${s.unknown} unknown`;
    }
  } catch (err) {
    // v1.9.0 rule stands: a rejected IPC call must not strand this
    // button on "Verifying…" forever.
    document.getElementById('verify-summary').textContent = `Verify failed: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = '✔ Verify All';
    refreshDashboard();
  }
});

// ---------- Cookie-file import (v2.0.0: save + automatic check + 🍪 chip) ----------
function noteCookieResult(res) {
  if (res && res.account && res.check) {
    cookieStates.set(res.account.id, { state: res.check.state, reason: res.check.reason || '' });
  }
}

// ---------- Cookies se Add — modal with 2 big options (v2.2.0) ----------
// The owner's demand: ONE modal, two clear paths — (a) paste cookies
// into a textarea, (b) pick cookie file(s). Both run on the EXISTING
// parser/store/check machinery (no parallel system); a bad paste
// shows its error INSIDE the modal so it can be fixed and retried.
const cookieOverlay = document.getElementById('cookie-modal-overlay');
const cookieNameInput = document.getElementById('cookie-name');
const cookiePasteWrap = document.getElementById('cookie-paste-wrap');
const cookiePasteText = document.getElementById('cookie-paste-text');
const cookiePasteError = document.getElementById('cookie-paste-error');

function openCookieModal() {
  cookiePasteError.hidden = true;
  cookiePasteError.textContent = '';
  cookiePasteWrap.hidden = true;
  document.getElementById('cookie-opt-paste').classList.remove('active');
  cookieOverlay.hidden = false;
  setTimeout(() => { try { cookieNameInput.focus(); } catch (e) {} }, 30);
}
function closeCookieModal() { cookieOverlay.hidden = true; }

document.getElementById('cookie-modal-close').addEventListener('click', closeCookieModal);
cookieOverlay.addEventListener('click', (e) => { if (e.target === cookieOverlay) closeCookieModal(); });
document.getElementById('btn-import-cookie').addEventListener('click', openCookieModal);

document.getElementById('cookie-opt-paste').addEventListener('click', () => {
  cookiePasteWrap.hidden = false;
  document.getElementById('cookie-opt-paste').classList.add('active');
  setTimeout(() => { try { cookiePasteText.focus(); } catch (e) {} }, 30);
});

function applyCookieImportResult(res) {
  // Shared by the paste path: card chip + card message + dashboard.
  if (res && res.accounts) renderAccounts(res.accounts);
  noteCookieResult(res);
  if (res && res.account) {
    setAccountMessage(res.account.id, res.success ? (res.message || 'Cookie login confirmed.') : (res.error || 'Cookie check failed.'), !res.success);
    renderAccounts(currentAccounts);
  }
  refreshDashboard();
}

document.getElementById('cookie-paste-add').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const text = cookiePasteText.value || '';
  if (!text.trim()) {
    cookiePasteError.textContent = 'Paste the cookies text first — an account cannot be created from an empty box.';
    cookiePasteError.hidden = false;
    return;
  }
  btn.disabled = true;
  btn.textContent = '🍪 Checking…';
  cookiePasteError.hidden = true;
  try {
    const res = await window.api.importCookieText((cookieNameInput.value || '').trim(), text);
    if (res && res.account) {
      // Account bana aur check hua — natija card par.
      closeCookieModal();
      cookiePasteText.value = '';
      applyCookieImportResult(res);
      showToast(res.success ? 'Cookie account added — LIVE ✔' : `Cookie check: ${res.error || 'failed'}`, res.success ? 'success' : 'error');
    } else if (res) {
      // Parse-level failure: NO account was created — error stays in
      // the modal so the paste can be fixed and retried.
      cookiePasteError.textContent = res.error || 'The cookies could not be understood. Paste in Netscape cookies.txt or JSON format.';
      cookiePasteError.hidden = false;
      if (res.accounts) renderAccounts(res.accounts);
    }
  } catch (err) {
    cookiePasteError.textContent = `Cookie import fail: ${err.message}`;
    cookiePasteError.hidden = false;
  }
  btn.disabled = false;
  btn.textContent = 'Paste Karke Add Karo';
});

async function runCookieFileImport(label, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '🍪 Checking…'; }
  try {
    const res = await window.api.importCookieFile(label || '');
    if (res && res.accounts) renderAccounts(res.accounts);
    if (res && res.canceled) {
      // user closed the file dialog — nothing to report
    } else if (res && res.success) {
      noteCookieResult(res);
      if (res.account) setAccountMessage(res.account.id, res.message || 'Cookie login confirmed.', false);
    } else if (res && res.account) {
      noteCookieResult(res);
      setAccountMessage(res.account.id, res.error || 'Cookie check failed.', true);
    } else if (res) {
      await showInfoModal('Cookie import failed', res.error || 'Cookie import failed.');
    }
  } catch (err) {
    await showInfoModal('Cookie import fail', err.message);
  }
  if (btn) { btn.disabled = false; btn.textContent = '🍪 Cookies se Add'; }
  renderAccounts(currentAccounts);
  refreshDashboard();
}

document.getElementById('cookie-opt-file').addEventListener('click', async () => {
  const label = (cookieNameInput.value || '').trim();
  closeCookieModal();
  if (label) {
    // Naam likha hai → ek file, usi naam se.
    await runCookieFileImport(label, null);
  } else {
    // Naam khaali → kai files, naam file ke naam se.
    await runCookieBulkImport(null);
  }
});

async function runCookieBulkImport(btn) {
  if (btn) { btn.disabled = true; btn.textContent = '🍪 Checking… (one account at a time)'; }
  try {
    const res = await window.api.importCookieFilesBulk();
    if (res && res.accounts) renderAccounts(res.accounts);
    if (res && !res.canceled && Array.isArray(res.results)) {
      for (const r of res.results) {
        if (r.accountId) {
          if (r.check) cookieStates.set(r.accountId, { state: r.check.state, reason: r.check.reason || '' });
          setAccountMessage(r.accountId, r.success ? (r.message || 'Cookie login confirmed.') : (r.error || 'Cookie check failed.'), !r.success);
        }
      }
      renderAccounts(currentAccounts);
      const lines = res.results.map(r => `${r.success ? '✔' : '✘'} ${r.file}: ${r.success ? (r.message || 'logged in') : (r.error || 'failed')}`);
      await showInfoModal('Cookie import complete', `${res.importedCount} of ${res.totalFiles} file(s) logged in:\n\n${lines.join('\n')}`);
    }
  } catch (err) {
    await showInfoModal('Bulk cookie import fail', err.message);
  }
  if (btn) { btn.disabled = false; btn.textContent = '🍪 Kai Cookie Files Ek Saath…'; }
  refreshDashboard();
}

const bulkCookieBtn = document.getElementById('btn-import-cookies-bulk');
if (bulkCookieBtn) bulkCookieBtn.addEventListener('click', (e) => runCookieBulkImport(e.currentTarget));

// ---------- Import from installed Chrome ----------
const chromeProfilesList = document.getElementById('chrome-profiles-list');

async function loadChromeProfiles() {
  let profiles;
  try {
    profiles = await window.api.getInstalledChromeProfiles();
  } catch (err) {
    chromeProfilesList.innerHTML = '';
    chromeProfilesList.appendChild(el('div', 'empty', `Could not read installed Chrome profiles: ${err.message}`));
    return;
  }
  chromeProfilesList.innerHTML = '';
  // Approved Design-1-final: the grid starts with a dashed
  // "+ Add Account" card (direct Gmail login), and a profile whose
  // Gmail is already an account shows ALREADY IMPORTED with its
  // credits and a Sync button — never a second Import button, so
  // no account is ever imported twice.
  const addCard = el('div', 'card profile-add-card');
  addCard.appendChild(el('h3', '', '+ Add Account'));
  addCard.appendChild(el('div', 'email', 'Sign in directly with any Gmail ID'));
  addCard.addEventListener('click', () => gmailLoginFlow());
  chromeProfilesList.appendChild(addCard);
  if (!profiles || profiles.length === 0) {
    chromeProfilesList.appendChild(el('div', 'empty', 'No installed Chrome profiles detected.'));
    return;
  }
  for (const p of profiles) {
    const card = el('div', 'card');
    card.appendChild(el('h3', '', p.gaiaName || p.name || p.dirName));
    card.appendChild(el('div', 'email', p.email || p.dirName));
    const actions = el('div', 'btn-row');
    const existing = p.email ? currentAccounts.find(a => a.email && a.email.toLowerCase() === p.email.toLowerCase()) : null;
    if (existing) {
      card.appendChild(el('div', 'email', typeof existing.credits === 'number' ? `${existing.credits} credits` : 'Credits not checked yet'));
      actions.appendChild(el('span', 'already-badge', 'ALREADY IMPORTED'));
      const syncBtn = el('button', '', 'Sync');
      syncBtn.addEventListener('click', async () => {
        syncBtn.disabled = true;
        syncBtn.textContent = 'Syncing…';
        try { await window.api.syncAccount(existing.id); } catch (e) {}
        syncBtn.disabled = false;
        syncBtn.textContent = 'Sync';
        loadChromeProfiles();
      });
      actions.appendChild(syncBtn);
      card.appendChild(actions);
      chromeProfilesList.appendChild(card);
      continue;
    }
    const importBtn = el('button', '', 'Import this profile');
    importBtn.addEventListener('click', async () => {
      importBtn.disabled = true;
      importBtn.textContent = 'Importing…';
      try {
        const res = await window.api.importChromeProfile(p.dirName);
        if (res && res.accounts) renderAccounts(res.accounts);
        if (res && res.success) {
          await showInfoModal('Profile imported', res.cookiesLocked
            ? 'Imported, but the cookies were locked (Chrome is using that profile). Close that profile\'s Chrome, import again, then press Sync on the account card.'
            : 'Profile imported. Press Sync on the new account card to see its live credits.');
        } else {
          await showInfoModal('Import failed', (res && res.error) || 'Import failed.');
        }
      } catch (err) {
        await showInfoModal('Import fail', err.message);
      }
      importBtn.disabled = false;
      importBtn.textContent = 'Import this profile';
      refreshDashboard();
    });
    actions.appendChild(importBtn);
    card.appendChild(actions);
    chromeProfilesList.appendChild(card);
  }
}

document.getElementById('btn-refresh-profiles').addEventListener('click', loadChromeProfiles);
document.getElementById('btn-import-all').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Importing…';
  try {
    const res = await window.api.importAllChromeProfiles();
    if (res && res.accounts) renderAccounts(res.accounts);
    if (res && res.success) {
      await showInfoModal('All profiles imported', `${res.importedCount} of ${res.totalFound} Chrome profiles were imported. Press Sync on each card to see the live credits.`);
    } else {
      await showInfoModal('Import failed', (res && res.error) || 'Import failed.');
    }
  } catch (err) {
    await showInfoModal('Import fail', err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Import All Detected Profiles';
    refreshDashboard();
  }
});

// ---------- Generate ----------
const taskList = document.getElementById('task-list');
const logBox = document.getElementById('log-box');

// v2.4.0: per-task start stamps for the live elapsed clock on
// generating rows. First 'generating' sighting starts the clock;
// a 1s ticker rewrites only the elapsed spans.
const taskStartTimes = new Map();
function formatElapsedClock(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}
setInterval(() => {
  for (const [taskId, row] of taskRows) {
    const span = row.querySelector('[data-role="elapsed"]');
    if (!span) continue;
    const started = taskStartTimes.get(taskId);
    if (started && row.classList.contains('generating')) {
      span.textContent = ` · ⏱ ${formatElapsedClock(Date.now() - started)}`;
    } else if (span.textContent) {
      span.textContent = '';
    }
  }
}, 1000);
const runStatus = document.getElementById('run-status');
const taskRows = new Map(); // taskId -> row element
let isRunning = false;
// Last run-level error, kept on the status line even when the trailing
// 'Idle' progress event arrives right after it.
let stickyRunError = null;
// v2.5.0: prompt modes are exactly TWO (owner's order) —
//   'bulk'      = the smart parser (saare tag styles khud detect:
//                 #00-01 / #1 / scene / prompt / numbers, warna lines)
//   'paragraph' = blank-line separated, ek paragraph = ek prompt
// DEFAULT = 'bulk'. Purani saved values ('auto'/'lines'/'blocks')
// parser ke normalizePromptMode se inhi do par safe girti hain.
//
// ⚠ v2.5.0 ROOT-CAUSE NOTE (Fix 1 — "prompt add nahi hota"):
// Is helper ka naam pehle `parsePromptsDetailed` tha — bilkul wahi
// naam jo promptParser.js `window.parsePromptsDetailed` par rakhta
// hai. Classic scripts me top-level function declaration window par
// chadh jati hai, aur app.js promptParser.js ke BAAD load hota hai —
// to window.parsePromptsDetailed is helper se OVERWRITE ho gaya, aur
// helper khud ko hi bulata raha: har keystroke par "RangeError:
// Maximum call stack size exceeded", counter hamesha "Prompts: 0",
// aur Generate handler pehle kadam par hi mar jata tha. Isi liye is
// helper ka naam ab alag hai — renderer ke kisi top-level function ka
// naam window.* wale parser API se KABHI na mile.
let promptMode = 'bulk';

function parseCurrentPrompts(raw) {
  if (typeof window.parsePromptsDetailed === 'function') {
    return window.parsePromptsDetailed(raw, promptMode);
  }
  const texts = String(raw || '').split('\n').map(s => s.trim()).filter(Boolean);
  return {
    items: texts.map((text, i) => ({ text, tag: `scene${String(i + 1).padStart(3, '0')}` })),
    style: 'lines',
    styleLabel: 'one line = one prompt'
  };
}

function parsePrompts(raw) {
  return parseCurrentPrompts(raw).items.map(item => item.text);
}

let promptPreviewOpen = false;

function renderPromptPreview(detailed) {
  const panel = document.getElementById('prompt-preview');
  panel.innerHTML = '';
  for (const item of detailed.items) {
    const row = el('div', 'pv-row');
    row.appendChild(el('span', 'tag-chip', item.tag));
    row.appendChild(el('span', 'pv-text', item.text.length > 60 ? `${item.text.slice(0, 59)}…` : item.text));
    panel.appendChild(row);
  }
  panel.style.display = promptPreviewOpen && detailed.items.length > 0 ? 'block' : 'none';
}

function updatePromptCount() {
  // v2.5.0 hardening: the counter must NEVER die silently again (the
  // v2.4.0 name-collision made every parse throw and the counter sat
  // at "Prompts: 0" forever). Any parse failure falls back to a plain
  // line count and says so on the detect line — visible, not silent.
  const area = document.getElementById('prompts-input');
  const detectEl = document.getElementById('prompt-detect');
  let detailed;
  try {
    detailed = parseCurrentPrompts(area.value);
  } catch (err) {
    const n = String(area.value || '').split('\n').map(s => s.trim()).filter(Boolean).length;
    document.getElementById('prompt-count').textContent = `Prompts: ${n}`;
    detectEl.textContent = `Could not parse the prompts (${err.message}) — showing a plain line count.`;
    return;
  }
  const n = detailed.items.length;
  document.getElementById('prompt-count').textContent = `Prompts: ${n}`;
  detectEl.textContent = n === 0
    ? 'Paste your prompts — the style is detected automatically.'
    : `Detected: ${n} prompts · style: ${detailed.styleLabel}`;
  document.getElementById('btn-prompt-preview').style.display = n > 0 ? '' : 'none';
  renderPromptPreview(detailed);
}

document.getElementById('btn-prompt-preview').addEventListener('click', () => {
  promptPreviewOpen = !promptPreviewOpen;
  document.getElementById('btn-prompt-preview').textContent = promptPreviewOpen ? 'Hide Preview' : 'Show Preview';
  updatePromptCount();
});

const PROMPT_MODE_HINTS = {
  bulk: 'Bulk Prompt: just paste — the app detects tags (scene / prompt / number / #00-01) itself and separates the prompts; without tags, each line is one prompt.',
  paragraph: 'Paragraph Prompt: one paragraph = one prompt — a blank line = a new prompt.'
};
const PROMPT_MODE_PLACEHOLDERS = {
  bulk: '#00-01 A cinematic shot of a lighthouse during a storm, waves crashing...\n#00-02 A drone flyover of a green valley at sunrise, mist lifting...',
  paragraph: 'A cinematic shot of a lighthouse during a storm, waves crashing,\ndark clouds rolling in over the sea...\n\nA drone flyover of a green valley at sunrise,\nmist lifting off the river...'
};

document.querySelectorAll('#prompt-mode-seg .seg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    promptMode = btn.dataset.mode;
    document.querySelectorAll('#prompt-mode-seg .seg-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.getElementById('prompt-mode-hint').textContent = PROMPT_MODE_HINTS[promptMode] || PROMPT_MODE_HINTS.bulk;
    document.getElementById('prompts-input').placeholder = PROMPT_MODE_PLACEHOLDERS[promptMode] || PROMPT_MODE_PLACEHOLDERS.bulk;
    updatePromptCount();
  });
});
document.getElementById('prompts-input').addEventListener('input', updatePromptCount);

document.getElementById('btn-import-prompts-file').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const res = await window.api.importPromptsFile();
    if (res && res.success && typeof res.text === 'string') {
      const area = document.getElementById('prompts-input');
      area.value = area.value.trim() ? `${area.value.replace(/\s+$/, '')}\n${res.text}` : res.text;
      area.dispatchEvent(new Event('input', { bubbles: true }));
      // v2.5.0: an imported file goes through the SAME smart parser —
      // Bulk mode detects tags / lines itself; Paragraph mode keeps
      // its blank-line rule, so only switch AWAY from paragraph when
      // the file is not already being counted there.
      if (promptMode !== 'bulk') {
        document.querySelector('#prompt-mode-seg .seg-btn[data-mode="bulk"]').click();
      } else {
        updatePromptCount();
      }
    } else if (res && !res.canceled) {
      await showInfoModal('File import failed', (res && res.error) || 'The file could not be imported.');
    }
  } catch (err) {
    await showInfoModal('File import fail', err.message);
  }
  btn.disabled = false;
});

let isPaused = false;
function setPauseResumeUI() {
  const btn = document.getElementById('btn-pause-resume');
  if (!btn) return;
  btn.disabled = !isRunning;
  btn.textContent = isPaused ? '▶ Resume' : '⏸ Pause';
}
function setRunningUI(running) {
  isRunning = running;
  if (!running) isPaused = false;
  document.getElementById('btn-generate').disabled = running;
  document.getElementById('btn-stop').disabled = !running;
  setPauseResumeUI();
  runStatus.textContent = running ? 'Running…' : '';
}

function makePreviewButton(taskId) {
  const btn = el('button', '', '▶ Preview');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const res = await window.api.previewVideo(taskId);
      if (res && res.success === false) showToast(res.error || 'The preview could not be opened.', 'error');
    } catch (err) {
      showToast(`Preview fail: ${err.message}`, 'error');
    }
    btn.disabled = false;
  });
  return btn;
}

function makeRetryButton(taskId) {
  const retryBtn = el('button', '', 'Retry');
  retryBtn.addEventListener('click', async () => {
    retryBtn.disabled = true;
    try {
      const res = await window.api.retryTask(taskId);
      if (res && res.success === false) {
        showToast(res.error || 'The retry could not be started.', 'error');
        retryBtn.disabled = false;
      } else {
        switchTo('generate');
      }
    } catch (err) {
      showToast(`Retry fail: ${err.message}`, 'error');
      retryBtn.disabled = false;
    }
  });
  return retryBtn;
}

function ensureTaskRow(data) {
  let row = taskRows.get(data.taskId);
  if (row) return row;
  if (taskList.querySelector('.empty')) taskList.innerHTML = '';
  row = el('div', 'task-row pending');
  const head = el('div', 'task-head');
  // v2.3.0: the TAG chip comes FIRST — a video saved under a wrong
  // tag is visible at a glance, before anything else on the row.
  const tagChip = el('span', 'tag-chip task-tag', data.tag || '');
  tagChip.dataset.role = 'tag';
  tagChip.style.display = data.tag ? '' : 'none';
  head.appendChild(tagChip);
  head.appendChild(el('span', 'task-idx', `#${(data.promptIndex ?? 0) + 1}`));
  head.appendChild(el('span', 'task-prompt', data.promptText || ''));
  const chip = statusChip('pending');
  chip.dataset.role = 'status';
  head.appendChild(chip);
  row.appendChild(head);
  const detail = el('div', 'task-detail', '');
  detail.dataset.role = 'detail';
  const detailText = el('span', '');
  detailText.dataset.role = 'detail-text';
  detail.appendChild(detailText);
  // v2.4.0: live elapsed clock for a generating row (mm:ss, ticking).
  const elapsedSpan = el('span', 'task-elapsed', '');
  elapsedSpan.dataset.role = 'elapsed';
  detail.appendChild(elapsedSpan);
  row.appendChild(detail);
  const btnRow = el('div', 'btn-row');
  btnRow.dataset.role = 'actions';
  row.appendChild(btnRow);
  taskList.appendChild(row);
  taskRows.set(data.taskId, row);
  return row;
}

function updateTaskRow(data) {
  const row = ensureTaskRow(data);
  if (data.tag) {
    const tagChip = row.querySelector('[data-role="tag"]');
    if (tagChip) {
      tagChip.textContent = data.tag;
      tagChip.style.display = '';
    }
  }
  const chip = row.querySelector('[data-role="status"]');
  const detail = row.querySelector('[data-role="detail"]');
  const detailText = row.querySelector('[data-role="detail-text"]');
  const btnRow = row.querySelector('[data-role="actions"]');
  const statusLabel = { pending: 'Pending', generating: 'Generating', done: 'Done', failed: 'Failed' }[data.status] || data.status;
  chip.className = `chip ${data.status}`;
  chip.textContent = statusLabel;
  row.className = `task-row ${data.status}`;
  btnRow.innerHTML = '';

  if (data.status === 'generating') {
    if (data.taskId && !taskStartTimes.has(data.taskId)) taskStartTimes.set(data.taskId, Date.now());
    detailText.textContent = data.accountName ? `Account: ${data.accountName}` : 'Generating…';
    detail.classList.remove('error');
  } else if (data.status === 'done') {
    detailText.textContent = data.fileName ? `Saved: ${data.fileName}` : 'Done';
    detail.classList.remove('error');
    if (data.taskId) btnRow.appendChild(makePreviewButton(data.taskId));
  } else if (data.status === 'failed') {
    detailText.textContent = data.reason ? `Failed: ${data.reason}` : 'Failed';
    detail.classList.add('error');
    btnRow.appendChild(makeRetryButton(data.taskId));
  } else {
    // pending — includes the v2.0.0 failover state: data.reason explains
    detailText.textContent = data.reason || '';
    detail.classList.remove('error');
  }
}

// v2.2.0: the Generate log uses the SAME one-line format as the
// Activity Simple mode (time + coloured icon + plain message), so
// both panels read identically. Raw entries are kept alongside the
// DOM so Copy Log survives DOM trimming.
const LOG_TYPE_ICONS = { success: '✔', warn: '⚠', error: '✘', info: '●' };
const logEntries = [];

function formatLogLine(data) {
  const time = data.timestamp || new Date().toLocaleTimeString();
  const icon = LOG_TYPE_ICONS[data.type] || LOG_TYPE_ICONS.info;
  let line = `[${time}] ${icon} ${String(data.message || '').trim()}`;
  // v2.4.0: the visible line is plain language; the original
  // technical error (when the engine attached one) rides along in
  // the COPY so a forwarded log still carries the full diagnosis.
  if (data.rawError) line += ` (takneeki detail: ${data.rawError})`;
  return line;
}

function addLog(data) {
  const entry = { timestamp: data.timestamp || '', type: data.type || 'info', message: data.message || '', rawError: data.rawError || '' };
  logEntries.push(entry);
  if (logEntries.length > 400) logEntries.splice(0, logEntries.length - 400);
  const line = el('div', `log-line log-${entry.type}`);
  line.appendChild(el('span', 'lg-time', `[${entry.timestamp || new Date().toLocaleTimeString()}]`));
  line.appendChild(el('span', 'lg-icon', LOG_TYPE_ICONS[entry.type] || LOG_TYPE_ICONS.info));
  line.appendChild(document.createTextNode(` ${entry.message}`));
  logBox.appendChild(line);
  while (logBox.children.length > 400) logBox.removeChild(logBox.firstChild);
  logBox.scrollTop = logBox.scrollHeight;
}

document.getElementById('btn-pick-folder').addEventListener('click', async () => {
  // v2.1.0 guard: an IPC failure must show, never die silently.
  try {
    const res = await window.api.selectFolder();
    if (res && res.success) {
      document.getElementById('setting-folder').value = res.folder;
      document.getElementById('pref-folder').value = res.folder;
      await window.api.setSetting('download_folder', res.folder);
    }
  } catch (err) {
    showToast(`Folder chunne me dikkat: ${err.message}`, 'error');
  }
});

document.getElementById('btn-open-folder').addEventListener('click', async () => {
  try {
    const folder = document.getElementById('setting-folder').value;
    if (folder) await window.api.openFolder(folder);
  } catch (err) {
    showToast(`Could not open the folder: ${err.message}`, 'error');
  }
});

// v2.1.0: the whole visible log, for the 📋 Copy Log button.
// v2.2.0: copies the stored entries in the shared Simple format, and
// a 🧹 Clear Log button sits beside it (image-4 style controls).
document.getElementById('btn-copy-log').addEventListener('click', async () => {
  if (activityCache.length === 0) {
    showToast('The log is empty — nothing to copy.');
    return;
  }
  const text = activityPanelMode === 'details'
    ? activityCache.map(formatActivityEntryForCopy).filter(Boolean).join('\n\n')
    : activityCache.map(formatActivityEntrySimple).filter(Boolean).join('\n');
  const ok = await copyTextToClipboard(text);
  showToast(ok ? `Log copied (${activityCache.length} entries).` : 'Could not copy the log.', ok ? 'success' : 'error');
});

document.getElementById('btn-clear-log').addEventListener('click', async () => {
  logEntries.length = 0;
  if (logBox) logBox.innerHTML = '';
  try { await window.api.clearActivity(); } catch (e) {}
  activityCache = [];
  renderActivityMini();
  renderActivityFull();
});

// v2.5.0: the "ek saath kitne accounts" control lives in Settings
// (Defaults) now — the Generate page has no workers box any more.
// Every run reads the SAVED value fresh, so a Settings change applies
// to the very next Generate without touching this page.
let savedConcurrencyLimit = 4;

async function readSavedConcurrency() {
  try {
    const v = await window.api.getSetting('concurrency', '');
    if (['1', '2', '3', '4', '5'].includes(String(v))) savedConcurrencyLimit = Number(v);
  } catch (e) { /* savedConcurrencyLimit keeps its last known value */ }
  return savedConcurrencyLimit;
}

// v2.4.0: the actual "start a fresh batch" step, split out of the
// Generate handler so the duplicate-charge guard can run first.
async function startNewRun(prompts) {
  hideSequenceBanner();
  // v2.11.0: a custom TAG chosen on the Generate page names every
  // prompt that has no tag of its own (they arrive with the plain
  // number tags 01, 02, ...). First takes the tag, the rest take
  // tag-2, tag-3, ... so no file is ever overwritten.
  if (typeof selectedCustomTag !== 'undefined' && selectedCustomTag) {
    let n = 0;
    prompts = prompts.map(p => {
      if (p && /^\d+$/.test(String(p.tag || ''))) {
        n += 1;
        return { ...p, tag: n === 1 ? selectedCustomTag : `${selectedCustomTag}-${n}` };
      }
      return p;
    });
  }
  const config = {
    prompts,
    model: document.getElementById('setting-model').value,
    duration: document.getElementById('setting-duration').value,
    aspectRatio: document.getElementById('setting-aspect').value,
    // v2.4.0: Outputs is locked to x1 — the select no longer exists.
    outputsCount: 1,
    concurrency: await readSavedConcurrency(),
    downloadFolder: document.getElementById('setting-folder').value
  };
  taskRows.clear();
  taskList.innerHTML = '';
  taskStartTimes.clear();
  stickyRunError = null;
  runStatus.classList.remove('error');
  // A start failure must be VISIBLE (status line + log), never a silent
  // hang — and a rejected IPC call must not strand the UI either.
  let res;
  try {
    res = await window.api.startGeneration(config);
  } catch (err) {
    runStatus.textContent = `Could not start generation: ${err.message}`;
    runStatus.classList.add('error');
    addLog({ message: `Start failed: ${err.message}`, type: 'error', timestamp: new Date().toLocaleTimeString() });
    return false;
  }
  if (res && res.success === false) {
    runStatus.textContent = res.error || 'Could not start generation.';
    runStatus.classList.add('error');
    addLog({ message: `Start failed: ${res.error || 'unknown error'}`, type: 'error', timestamp: new Date().toLocaleTimeString() });
    return false;
  }
  setRunningUI(true);
  return true;
}

document.getElementById('btn-generate').addEventListener('click', async () => {
  const raw = document.getElementById('prompts-input').value;
  // v2.3.0: items carry their TAG (+ original position) into the run —
  // downloads are named by tag and the sequence report checks by tag.
  // v2.5.0 hardening (Fix 1): a parse failure must come back as a
  // VISIBLE modal, never as the silent dead click the owner hit in
  // v2.4.0 (the handler used to die on its first line).
  let detailed;
  try {
    detailed = parseCurrentPrompts(raw);
  } catch (err) {
    await showInfoModal('Prompts could not be read', `There was a problem separating the prompts: ${err.message}\n\nThe text is still in the box as it was — change the mode (Bulk Prompt / Paragraph Prompt) and try again.`);
    return;
  }
  const prompts = detailed.items.map((item, i) => ({ text: item.text, tag: item.tag, index: i }));
  if (prompts.length === 0) {
    await showInfoModal('Prompt needed', promptMode === 'paragraph'
      ? 'Write at least one paragraph — a blank line = a new prompt.'
      : 'Paste at least one prompt — Bulk mode will detect the tags/style itself.');
    return;
  }

  // v2.4.0 — DUPLICATE-CHARGE GUARD. On the owner's PC a mid-flight
  // prompt was Generate-d a second time and Flow charged for it
  // again. If any pasted prompt is already pending / needs_check /
  // running, warn FIRST: the safe default is Resume (the pending
  // render is checked in Flow, never re-charged). Prompts that do
  // not match anything are unaffected either way.
  // v2.5.0: the guard is ADVISORY, never a gate — any failure of the
  // check itself (IPC down, handler error) lets generation proceed
  // untouched; only the warning is skipped, and the skip is logged.
  let dupMatches = [];
  try {
    const chk = await window.api.checkPromptDuplicates(prompts);
    if (chk && chk.success && Array.isArray(chk.matches)) dupMatches = chk.matches;
  } catch (e) {
    dupMatches = [];
    addLog({ message: `Duplicate check nahi ho paya (${e.message}) — bagair check ke generation aage badh raha hai.`, type: 'warn', timestamp: new Date().toLocaleTimeString() });
  }
  if (dupMatches.length > 0) {
    const names = dupMatches.map(m => `#${m.index + 1}`).join(', ');
    const anyMidFlight = dupMatches.some(m => m.needsCheck || m.status === 'running');
    const resume = await showConfirmModal(
      'This prompt is already pending',
      `${dupMatches.length} prompt(s) (${names}) are already in the queue as ${anyMidFlight ? 'partly generated / pending' : 'pending'}. Generating again will make Flow deduct their credits AGAIN.\n\nThe right way: Resume the pending prompts first — the ones already sent to Flow will be checked first, and credits will not be deducted again.`,
      { okText: 'Resume instead (recommended)', cancelText: 'Run new anyway' }
    );
    if (resume) {
      await startResumeFlow();
      showToast('The old pending prompts are resuming. You can Generate the new prompts (the ones that were not duplicates) after these.', 'info');
      return;
    }
    const sure = await showConfirmModal(
      'Run new for sure?',
      'A new run will deduct these prompts\' credits again, and the old pending renders will keep generating separately. Usually this is money wasted.',
      { okText: 'Yes, run new', cancelText: 'No, leave it', danger: true }
    );
    if (!sure) return;
  }

  await startNewRun(prompts);
});

// v2.4.0 (fix: button feedback): Pause/Resume/Stop must show their
// effect the instant they are clicked — on the owner's PC they
// looked dead, so he pressed them again and again. The clicked
// button disables itself and the status line speaks immediately;
// the run's own progress events reconcile the final state.
/* v2.11.0 FINAL: Pause and Resume are ONE toggle button — while a
   run is going it reads "⏸ Pause"; once paused it reads "▶ Resume". */
document.getElementById('btn-pause-resume').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  if (!isPaused) {
    runStatus.textContent = '⏸ Pausing…';
    try {
      await window.api.pauseGeneration();
      isPaused = true;
      runStatus.textContent = '⏸ Paused';
    } catch (err) { showToast(`Could not pause: ${err.message}`, 'error'); }
  } else {
    runStatus.textContent = '▶ Resuming…';
    try {
      await window.api.resumeGeneration();
      isPaused = false;
      runStatus.textContent = 'Running…';
    } catch (err) { showToast(`Could not resume: ${err.message}`, 'error'); }
  }
  setPauseResumeUI();
});
document.getElementById('btn-stop').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  const prBtn = document.getElementById('btn-pause-resume');
  if (prBtn) prBtn.disabled = true;
  runStatus.textContent = '⏹ Stopping…';
  try {
    await window.api.stopGeneration();
  } catch (err) {
    showToast(`Could not stop: ${err.message}`, 'error');
  }
  setRunningUI(false);
});

// ---------- Sequence report (v2.3.0) ----------
// Run khatam hone par main process DB + DISK se report banata hai:
// har tag ka video asal me maujood hai ya nahi, sahi naam par hai ya
// nahi. Yahan sirf dikhana hai + do action: [Sirf Missing Dobara
// Banao] aur galat-naam wali file ka one-click rename.
const sequenceBanner = document.getElementById('sequence-banner');

function hideSequenceBanner() {
  sequenceBanner.style.display = 'none';
  sequenceBanner.innerHTML = '';
}

async function refreshSequenceReport() {
  try {
    const res = await window.api.getSequenceReport();
    renderSequenceBanner(res && res.report ? res.report : null);
  } catch (e) {
    hideSequenceBanner();
  }
}

function renderSequenceBanner(report) {
  if (!report || !report.total) {
    hideSequenceBanner();
    return;
  }
  sequenceBanner.innerHTML = '';
  sequenceBanner.className = `sequence-banner ${report.complete ? 'ok' : 'warn'}`;
  const head = el('div', 'seq-head');
  // v2.10.0: app ke apne -2/-3 suffix wale poori files (asal naam
  // par purani file thi) — ye GALAT NAAM nahi, POORE hain; banner
  // me inki saaf line alag se dikhti hai.
  const suffixed = (report.present || []).filter(x => x.suffixNote);
  const suffixLines = () => {
    for (const p of suffixed) {
      const line = el('div', 'seq-line ok');
      line.appendChild(el('span', 'tag-chip', p.tag));
      line.appendChild(el('span', 'seq-text', `COMPLETE — the file is "${p.fileName}" (a file already existed under the original name, so it got a suffixed name — the video is completely fine)`));
      sequenceBanner.appendChild(line);
    }
  };
  if (report.complete) {
    head.appendChild(el('span', 'seq-title', `✔ Sequence complete: all ${report.total} of ${report.total} videos are present`));
    sequenceBanner.appendChild(head);
    suffixLines();
  } else {
    head.appendChild(el('span', 'seq-title',
      `⚠ Sequence: ${report.presentCount} of ${report.total} complete` +
      (report.missing.length ? ` · ${report.missing.length} MISSING` : '') +
      (report.wrongName.length ? ` · ${report.wrongName.length} WRONG NAME` : '')));
    sequenceBanner.appendChild(head);

    for (const m of report.missing) {
      const line = el('div', 'seq-line missing');
      line.appendChild(el('span', 'tag-chip', m.tag));
      line.appendChild(el('span', 'seq-text', `MISSING — ${m.reason}`));
      sequenceBanner.appendChild(line);
    }
    for (const w of report.wrongName) {
      const line = el('div', 'seq-line wrong');
      line.appendChild(el('span', 'tag-chip', w.tag));
      line.appendChild(el('span', 'seq-text', `WRONG NAME — the file is "${w.currentName}", it should be "${w.expectedName}"`));
      if (w.canRename) {
        const btn = el('button', 'mini-btn seq-rename', 'Rename to the correct name');
        btn.addEventListener('click', async () => {
          const yes = await showConfirmModal('File ka naam badlein?',
            `Rename "${w.currentName}" to "${w.expectedName}"? This is this tag's actual video — only the name will be fixed; the video stays exactly as it is.`,
            { okText: 'Yes, rename it' });
          if (!yes) return;
          btn.disabled = true;
          try {
            const res = await window.api.renameTaskFile(w.taskId);
            if (res && res.success) {
              showToast(`Name fixed: ${res.fileName}`, 'success');
              await refreshSequenceReport();
              loadHistory();
            } else {
              showToast((res && res.error) || 'Rename failed.', 'error');
              btn.disabled = false;
            }
          } catch (err) {
            showToast(`Rename fail: ${err.message}`, 'error');
            btn.disabled = false;
          }
        });
        line.appendChild(btn);
      } else {
        line.appendChild(el('span', 'seq-note', `("${w.expectedName}" already exists — it will not be overwritten; move it first)`));
      }
      sequenceBanner.appendChild(line);
    }
    suffixLines();

    if (report.missing.length > 0) {
      const actions = el('div', 'seq-actions');
      const btn = el('button', 'primary', `🔁 Regenerate Missing Only (${report.missing.length})`);
      btn.addEventListener('click', async () => {
        const tags = report.missing.map(m => m.tag).join(', ');
        const yes = await showConfirmModal('Regenerate only the missing ones?',
          `${report.missing.length} missing video(s) will be generated again: ${tags}\n\nThe already-made videos will NOT be touched — credits will be spent only on these missing ones, and the new videos will be saved under their ORIGINAL tag names (the number will not change again).`,
          { okText: 'Yes, make only the missing ones' });
        if (!yes) return;
        btn.disabled = true;
        try {
          const res = await window.api.retryMissingTasks(report.missing.map(m => m.taskId));
          if (res && res.success) {
            hideSequenceBanner();
            taskRows.clear();
            taskList.innerHTML = '';
            setRunningUI(true);
            showToast(`${res.totalPrompts} missing prompt(s) are running again.`, 'success');
          } else {
            showToast((res && res.error) || 'The retry could not be started.', 'error');
            btn.disabled = false;
          }
        } catch (err) {
          showToast(`Retry fail: ${err.message}`, 'error');
          btn.disabled = false;
        }
      });
      actions.appendChild(btn);
      sequenceBanner.appendChild(actions);
    }
  }
  sequenceBanner.style.display = 'block';
}

// ---------- Resumable queue banner ----------
const resumeBanner = document.getElementById('resume-banner');
const resumeText = document.getElementById('resume-text');

async function refreshResumeBanner() {
  try {
    const info = await window.api.getResumableTasks();
    if (info && info.total > 0) {
      resumeText.textContent = info.needsCheck > 0
        ? `${info.total} prompt(s) from an earlier run are still pending — ${info.needsCheck} of them were mid-flight when the app closed and will be verified in Flow first (no double credit charge).`
        : `${info.total} prompt(s) from an earlier run are still pending.`;
      resumeBanner.style.display = 'flex';
    } else {
      resumeBanner.style.display = 'none';
    }
  } catch (e) {
    resumeBanner.style.display = 'none';
  }
}

// v2.4.0: the resume flow, callable from the banner button AND from
// the duplicate-charge guard's "Resume karo" choice.
async function startResumeFlow() {
  let res;
  try {
    res = await window.api.resumeTasks();
  } catch (err) {
    runStatus.textContent = `Could not resume the queue: ${err.message}`;
    runStatus.classList.add('error');
    return false;
  }
  if (res && res.success === false) {
    runStatus.textContent = res.error || 'Could not resume the queue.';
    runStatus.classList.add('error');
    return false;
  }
  resumeBanner.style.display = 'none';
  hideSequenceBanner();
  taskRows.clear();
  taskList.innerHTML = '';
  taskStartTimes.clear();
  setRunningUI(true);
  return true;
}

document.getElementById('btn-resume-queue').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  await startResumeFlow();
  btn.disabled = false;
});

// ---------- History (v2.2.0: ZDola-style table) ----------
// The owner's reference (his screenshot): a TABLE of downloaded
// videos — select checkbox, name, output folder, size, date, status
// chip, actions — with search, status/folder filters and a bulk bar.
// The row mapping below mirrors engine/historyTable.js (the renderer
// cannot require engine modules; the smoke test pins the engine side).
const historyTbody = document.getElementById('history-tbody');
const historyEmpty = document.getElementById('history-empty');
const historySelected = new Set();
let historyRows = []; // mapped view-models, newest first
let historyStatusFilter = 'all';
let historyFolderFilter = 'all';
let historySearchText = '';

const HIST_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function histDateText(raw) {
  if (!raw) return '—';
  const m = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  let d;
  if (m) d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  else { d = new Date(raw); if (isNaN(d.getTime())) return '—'; }
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${d.getDate()} ${HIST_MONTHS[d.getMonth()]}, ${h}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`;
}

function histSizeText(raw) {
  if (raw === null || raw === undefined || raw === '') return '—';
  const n = parseFloat(String(raw));
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 0.1) return `${Math.max(1, Math.round(n * 1024))} KB`;
  return `${n.toFixed(1)} MB`;
}

function histFolderOf(filePath) {
  if (!filePath) return '—';
  const parts = String(filePath).split(/[\\/]/).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : '—';
}

function histDirOf(filePath) {
  if (!filePath) return '';
  const idx = Math.max(String(filePath).lastIndexOf('/'), String(filePath).lastIndexOf('\\'));
  return idx > 0 ? String(filePath).slice(0, idx) : '';
}

function mapHistoryRow(t) {
  const done = t.status === 'completed';
  const name = t.file_name || (t.file_path ? String(t.file_path).split(/[\\/]/).pop() : '') ||
    String(t.prompt_text || '').replace(/\s+/g, ' ').trim().slice(0, 42) || '(video)';
  return {
    id: String(t.id || ''),
    name,
    tag: (t.prompt_tag || '').trim(),
    prompt: String(t.prompt_text || '').replace(/\s+/g, ' ').trim(),
    folder: histFolderOf(t.file_path),
    dir: histDirOf(t.file_path),
    sizeText: histSizeText(t.file_size_mb),
    dateText: histDateText(t.completed_at || t.created_at),
    status: done ? 'done' : 'failed',
    reason: done ? '' : (t.error_reason || 'Unknown error'),
    accountName: t.assigned_account_name || '',
    filePath: t.file_path || '',
    promptIndex: t.prompt_index ?? 0
  };
}

function filteredHistoryRows() {
  const q = historySearchText.trim().toLowerCase();
  return historyRows.filter(r => {
    if (historyStatusFilter !== 'all' && r.status !== historyStatusFilter) return false;
    if (historyFolderFilter !== 'all' && r.folder !== historyFolderFilter) return false;
    if (q && !(`${r.name} ${r.prompt} ${r.tag || ''}`.toLowerCase().includes(q))) return false;
    return true;
  });
}

function updateHistoryBulkBar() {
  const visible = filteredHistoryRows();
  // Selection only counts rows that still exist.
  for (const id of [...historySelected]) {
    if (!historyRows.some(r => r.id === id)) historySelected.delete(id);
  }
  document.getElementById('history-selected-count').textContent = `Selected: ${historySelected.size}`;
  document.getElementById('btn-delete-selected').disabled = historySelected.size === 0;
  const checkAll = document.getElementById('history-check-all');
  checkAll.checked = visible.length > 0 && visible.every(r => historySelected.has(r.id));
  checkAll.indeterminate = visible.some(r => historySelected.has(r.id)) && !checkAll.checked;
}

function renderHistoryTable() {
  const visible = filteredHistoryRows();
  historyTbody.innerHTML = '';
  historyEmpty.style.display = visible.length === 0 ? 'block' : 'none';
  historyEmpty.textContent = historyRows.length === 0 ? 'Nothing yet.' : 'No video found in this search/filter.';
  for (const r of visible) {
    const tr = document.createElement('tr');
    if (historySelected.has(r.id)) tr.className = 'selected';

    const tdCheck = el('td', 'col-check');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = historySelected.has(r.id);
    cb.addEventListener('change', () => {
      if (cb.checked) historySelected.add(r.id); else historySelected.delete(r.id);
      tr.classList.toggle('selected', cb.checked);
      updateHistoryBulkBar();
    });
    tdCheck.appendChild(cb);
    tr.appendChild(tdCheck);

    const tdName = el('td', '');
    if (r.tag) {
      const nameLine = el('div', 'h-name-line');
      nameLine.appendChild(el('span', 'tag-chip', r.tag));
      nameLine.appendChild(el('span', 'h-name', r.name));
      tdName.appendChild(nameLine);
    } else {
      tdName.appendChild(el('div', 'h-name', r.name));
    }
    if (r.prompt) {
      const p = el('div', 'h-prompt', r.prompt.length > 90 ? `${r.prompt.slice(0, 89)}…` : r.prompt);
      p.title = r.prompt;
      tdName.appendChild(p);
    }
    if (r.status === 'failed') tdName.appendChild(el('div', 'h-reason', `Failed: ${r.reason}${r.accountName ? ` · ${r.accountName}` : ''}`));
    tr.appendChild(tdName);

    tr.appendChild(el('td', '', r.folder));
    tr.appendChild(el('td', 'h-size', r.sizeText));
    tr.appendChild(el('td', 'h-date', r.dateText));

    const tdStatus = el('td', '');
    tdStatus.appendChild(el('span', `status-chip ${r.status}`, r.status === 'done' ? '● Done' : '● Failed'));
    tr.appendChild(tdStatus);

    const tdAct = el('td', 'h-actions');
    if (r.status === 'done' && r.filePath) {
      tdAct.appendChild(makePreviewButton(r.id));
      const folderBtn = el('button', '', '📂');
      folderBtn.title = 'Is video ka folder kholo';
      folderBtn.addEventListener('click', async () => {
        try { if (r.dir) await window.api.openFolder(r.dir); } catch (err) { showToast(`Could not open the folder: ${err.message}`, 'error'); }
      });
      tdAct.appendChild(folderBtn);
    }
    if (r.status === 'failed') tdAct.appendChild(makeRetryButton(r.id));
    tr.appendChild(tdAct);

    historyTbody.appendChild(tr);
  }
  updateHistoryBulkBar();
}

async function loadHistory() {
  try {
    const stats = await window.api.getUsageStats();
    if (stats) {
      document.getElementById('usage-stats').textContent =
        `Videos saved — all-time: ${stats.total} · last 7 days: ${stats.last7Days} · today: ${stats.today}`;
      document.getElementById('hist-total').textContent = String(stats.total);
      document.getElementById('hist-today').textContent = String(stats.today);
      document.getElementById('hist-week').textContent = String(stats.last7Days);
    }
  } catch (e) {}
  try {
    const d = await window.api.getCreditDashboard();
    if (d) document.getElementById('hist-spend').textContent = `${d.spendToday} credits`;
  } catch (e) {}
  let rows;
  try {
    rows = await window.api.getHistory(300);
  } catch (err) {
    historyRows = [];
    historyTbody.innerHTML = '';
    historyEmpty.style.display = 'block';
    historyEmpty.textContent = `History could not be loaded: ${err.message}`;
    return;
  }
  historyRows = (rows || []).map(mapHistoryRow);
  // Refresh the folder filter options from the actual folders.
  const folderSel = document.getElementById('history-folder-filter');
  const folders = [...new Set(historyRows.map(r => r.folder).filter(f => f !== '—'))].sort();
  const keep = folders.includes(historyFolderFilter) ? historyFolderFilter : 'all';
  folderSel.innerHTML = '';
  const allOpt = document.createElement('option');
  allOpt.value = 'all';
  allOpt.textContent = 'All Folders';
  folderSel.appendChild(allOpt);
  for (const f of folders) {
    const o = document.createElement('option');
    o.value = f;
    o.textContent = f;
    folderSel.appendChild(o);
  }
  folderSel.value = keep;
  historyFolderFilter = keep;
  renderHistoryTable();
}

document.getElementById('btn-refresh-history').addEventListener('click', loadHistory);
document.getElementById('history-search').addEventListener('input', (e) => {
  historySearchText = e.target.value || '';
  renderHistoryTable();
});
document.querySelectorAll('#history-filter-seg .seg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    historyStatusFilter = btn.dataset.filter;
    document.querySelectorAll('#history-filter-seg .seg-btn').forEach(b => b.classList.toggle('active', b === btn));
    renderHistoryTable();
  });
});
document.getElementById('history-folder-filter').addEventListener('change', (e) => {
  historyFolderFilter = e.target.value;
  renderHistoryTable();
});
document.getElementById('history-check-all').addEventListener('change', (e) => {
  const visible = filteredHistoryRows();
  if (e.target.checked) visible.forEach(r => historySelected.add(r.id));
  else visible.forEach(r => historySelected.delete(r.id));
  renderHistoryTable();
});
document.getElementById('btn-history-open-folder').addEventListener('click', async () => {
  try {
    const folder = document.getElementById('setting-folder').value || await window.api.getDefaultDownloadFolder();
    if (folder) await window.api.openFolder(folder);
  } catch (err) {
    showToast(`Could not open the folder: ${err.message}`, 'error');
  }
});
document.getElementById('btn-delete-selected').addEventListener('click', async () => {
  // This deletes REAL files — the in-app confirm modal is mandatory;
  // nothing is ever deleted from a bare click.
  const ids = [...historySelected];
  if (ids.length === 0) return;
  const yes = await showConfirmModal(
    'Delete the selected videos?',
    `${ids.length} video(s) are selected.\n\nOn deleting, their video FILE will also be deleted from disk, along with the History record. This cannot be undone.`,
    { okText: 'Yes, delete file + record', danger: true }
  );
  if (!yes) return;
  try {
    const res = await window.api.deleteHistoryTasks(ids, true);
    if (res && res.success) {
      historySelected.clear();
      showToast(`${res.deleted} record(s) deleted · ${res.filesDeleted} file(s) also deleted.${res.skippedFiles && res.skippedFiles.length ? ` ${res.skippedFiles.length} file(s) could not be deleted (outside the allowed folder).` : ''}`, 'success');
    } else {
      showToast((res && res.error) || 'Delete failed.', 'error');
    }
  } catch (err) {
    showToast(`Delete fail: ${err.message}`, 'error');
  }
  loadHistory();
});
document.getElementById('btn-clear-history').addEventListener('click', async () => {
  const yes = await showConfirmModal('Clear the history?', 'Remove all completed/failed history RECORDS? The video files will stay on disk — only the list will be cleared. (Usage counts will remain.)', { okText: 'Yes, clear only the records', danger: true });
  if (!yes) return;
  try {
    await window.api.clearHistory();
  } catch (err) {
    await showInfoModal('History could not be cleared', err.message);
    return;
  }
  historySelected.clear();
  loadHistory();
});

// ---------- Activity (v2.0.0; v2.2.0 Simple/Details log-stream) ----------
const activityMiniList = document.getElementById('activity-mini-list');
const activityFullList = document.getElementById('activity-list');
let activityCache = []; // newest first
let activityFilter = 'all';
// v2.2.0 (owner's demand, his log-panel screenshot): two reading
// modes — 'simple' (one clean line per event, default) and
// 'details' (the v2.1.0 expandable full story + per-entry copy).
let activityMode = 'simple';

function activityRow(entry, full = false) {
  const row = el('div', `ev level-${entry.level || 'info'}`);
  if (!full) {
    // Mini panel (Accounts page): compact, message + time only.
    row.appendChild(el('span', 'dot'));
    row.appendChild(el('span', 'msg', entry.message || ''));
    row.appendChild(el('time', '', entry.time || ''));
    return row;
  }
  if (activityMode === 'simple') {
    // One line: time + coloured icon + plain meaning. Nothing else.
    row.appendChild(el('time', '', entry.time || ''));
    row.appendChild(el('span', 'ev-icon', activityLevelIcon(entry.level)));
    row.appendChild(el('span', 'msg', entry.message || ''));
    return row;
  }
  // Details mode — the v2.1.0 behaviour: the first line carries the
  // story bits (account/stage/wajah), a click expands the full
  // detail block, and 📋 copies the entry verbatim.
  row.appendChild(el('span', 'dot'));
  const main = el('div', 'ev-main');
  const bits = [];
  if (entry.accountName) bits.push(`Account: ${entry.accountName}`);
  if (entry.promptIndex !== null && entry.promptIndex !== undefined) bits.push(`Prompt #${entry.promptIndex + 1}`);
  if (entry.stage) bits.push(`Stage: ${entry.stage}`);
  if (entry.reason) bits.push(`Reason: ${entry.reason}`);
  main.appendChild(el('span', 'msg', bits.length ? `${entry.message || ''} — ${bits.join(' · ')}` : (entry.message || '')));
  const detailLines = [];
  if (entry.accountName) detailLines.push(`Account: ${entry.accountName}`);
  if (entry.promptIndex !== null && entry.promptIndex !== undefined) detailLines.push(`Prompt #: ${entry.promptIndex + 1}`);
  if (entry.stage) detailLines.push(`Stage: ${entry.stage}`);
  if (entry.ts) detailLines.push(`Time: ${new Date(entry.ts).toLocaleString()}`);
  if (entry.detail) detailLines.push(`Detail: ${entry.detail}`);
  if (entry.reason) detailLines.push(`Reason: ${entry.reason}`);
  if (!detailLines.length) detailLines.push('No further detail was recorded for this older entry.');
  const detail = el('div', 'ev-detail', detailLines.join('\n'));
  detail.addEventListener('click', (e) => e.stopPropagation());
  main.appendChild(detail);
  row.appendChild(main);
  const copyBtn = el('button', 'mini-btn ev-copy', '📋 Copy');
  copyBtn.title = 'Copy the full detail of this entry';
  copyBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const ok = await copyTextToClipboard(formatActivityEntryForCopy(entry));
    showToast(ok ? 'Entry copied — you can paste it anywhere and send it.' : 'Copy failed.', ok ? 'success' : 'error');
  });
  row.appendChild(copyBtn);
  row.appendChild(el('time', '', entry.time || ''));
  row.addEventListener('click', () => row.classList.toggle('expanded'));
  return row;
}

function renderActivityInto(container, entries, cap, full = false) {
  container.innerHTML = '';
  const slice = entries.slice(0, cap);
  if (slice.length === 0) {
    container.appendChild(el('div', 'empty', 'No activity yet.'));
    return;
  }
  for (const entry of slice) container.appendChild(activityRow(entry, full));
}

/* v2.11.0 FINAL: the embedded Activity panel at the bottom of the
   Generate page (ZDola-style, owner-approved Design 2). Simple =
   one clean line per event; Details = the line plus a grey detail
   sub-line under it (time · account · stage/reason). */
let activityPanelMode = 'simple';
function renderActivityMini() {
  if (!activityMiniList) return;
  activityMiniList.innerHTML = '';
  const entries = activityCache.slice(0, 30);
  if (entries.length === 0) {
    activityMiniList.appendChild(el('div', 'empty', 'No activity yet.'));
  }
  for (const entry of entries) {
    const row = el('div', `ev level-${entry.level || 'info'}`);
    row.appendChild(el('span', 'dot'));
    const main = el('div', 'ev-main');
    main.appendChild(el('span', 'msg', entry.message || ''));
    if (activityPanelMode === 'details') {
      const bits = [];
      if (entry.time) bits.push(entry.time);
      if (entry.accountName) bits.push(entry.accountName);
      if (entry.stage) bits.push(entry.stage);
      if (entry.reason) bits.push(entry.reason);
      if (entry.detail) bits.push(entry.detail);
      if (bits.length) main.appendChild(el('div', 'ev-sub', bits.join(' · ')));
    }
    row.appendChild(main);
    row.appendChild(el('time', '', entry.time || ''));
    activityMiniList.appendChild(row);
  }
  const statusLine = document.getElementById('activity-status-line');
  if (statusLine) {
    const latest = activityCache[0];
    statusLine.textContent = latest ? (latest.message || 'Ready.') : 'Ready. Check cookies, select live accounts, then start generation.';
  }
  const chip = document.getElementById('activity-ready-chip');
  if (chip) chip.textContent = isRunning ? 'Running' : 'Ready';
  updateActivityStatsLine();
}
async function updateActivityStatsLine() {
  const line = document.getElementById('activity-stats-line');
  if (!line) return;
  try {
    const stats = await window.api.getUsageStats();
    if (stats) line.textContent = `All-time: ${stats.total} videos saved · ${stats.today} today`;
  } catch (e) { /* best effort */ }
}
document.querySelectorAll('#activity-panel-mode .seg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    activityPanelMode = btn.dataset.amode === 'details' ? 'details' : 'simple';
    document.querySelectorAll('#activity-panel-mode .seg-btn').forEach(b => b.classList.toggle('active', b === btn));
    renderActivityMini();
  });
});
const prevVideosBtn = document.getElementById('btn-prev-videos');
if (prevVideosBtn) prevVideosBtn.addEventListener('click', () => switchTo('history'));
['btn-back-generate', 'btn-back-generate-2', 'btn-back-generate-3'].forEach(id => {
  const b = document.getElementById(id);
  if (b) b.addEventListener('click', () => switchTo('generate'));
});

function renderActivityFull() {
  activityFullList.classList.toggle('simple-mode', activityMode === 'simple');
  const filtered = activityFilter === 'all'
    ? activityCache
    : activityCache.filter(e => e.category === activityFilter);
  renderActivityInto(activityFullList, filtered, 300, true);
}

document.querySelectorAll('#activity-mode-seg .seg-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    activityMode = btn.dataset.mode === 'details' ? 'details' : 'simple';
    document.querySelectorAll('#activity-mode-seg .seg-btn').forEach(b => b.classList.toggle('active', b === btn));
    renderActivityFull();
    try { await window.api.setSetting('activity_view_mode', activityMode); } catch (e) {}
  });
});

async function loadActivity() {
  try {
    const entries = await window.api.getActivity({ category: 'all', limit: 300 });
    activityCache = Array.isArray(entries) ? entries : [];
  } catch (e) {
    activityCache = [];
  }
  renderActivityMini();
  renderActivityFull();
}

document.querySelectorAll('#activity-filter-seg .seg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    activityFilter = btn.dataset.filter;
    document.querySelectorAll('#activity-filter-seg .seg-btn').forEach(b => b.classList.toggle('active', b === btn));
    renderActivityFull();
  });
});
document.getElementById('btn-refresh-activity').addEventListener('click', loadActivity);
document.getElementById('btn-copy-activity').addEventListener('click', async () => {
  // v2.2.0: Copy Log copies what the owner SEES — Simple mode copies
  // the clean one-liners, Details mode copies the full story format.
  const filtered = activityFilter === 'all'
    ? activityCache
    : activityCache.filter(e => e.category === activityFilter);
  if (filtered.length === 0) {
    showToast('There is no activity entry to copy.');
    return;
  }
  const text = activityMode === 'simple'
    ? filtered.map(formatActivityEntrySimple).filter(Boolean).join('\n')
    : filtered.map(formatActivityEntryForCopy).filter(Boolean).join('\n\n');
  const ok = await copyTextToClipboard(text);
  showToast(ok ? `Log copied (${filtered.length} entries) — you can paste it anywhere and send it.` : 'Copy failed.', ok ? 'success' : 'error');
});
document.getElementById('btn-clear-activity').addEventListener('click', async () => {
  const yes = await showConfirmModal('Clear the activity?', 'Clear all activity history? This cannot be undone.', { okText: 'Yes, clear it', danger: true });
  if (!yes) return;
  try {
    await window.api.clearActivity();
    activityCache = [];
    renderActivityMini();
    renderActivityFull();
  } catch (err) {
    await showInfoModal('Activity could not be cleared', err.message);
  }
});

// ---------- Settings (v2.0.0) ----------
let settingsLoaded = false;

async function loadSettings() {
  try {
    const [model, duration, aspect, concurrency, folder, chromePath, autoplay, autoVerify, browserBg, namingMode] = await Promise.all([
      window.api.getSetting('default_model', ''),
      window.api.getSetting('default_duration', ''),
      window.api.getSetting('default_aspect', ''),
      window.api.getSetting('concurrency', ''),
      window.api.getDefaultDownloadFolder(),
      window.api.getSetting('chrome_path', ''),
      window.api.getSetting('preview_autoplay', '1'),
      window.api.getSetting('auto_verify_start', '0'),
      window.api.getSetting('browser_background', '1'),
      window.api.getSetting('naming_mode', 'tag')
    ]);
    if (model) { document.getElementById('pref-model').value = model; document.getElementById('setting-model').value = model; }
    if (duration) { document.getElementById('pref-duration').value = duration; document.getElementById('setting-duration').value = duration; }
    if (aspect) { document.getElementById('pref-aspect').value = aspect; document.getElementById('setting-aspect').value = aspect; }
    if (['1', '2', '3', '4', '5'].includes(String(concurrency))) {
      document.getElementById('setting-parallel').value = String(concurrency);
      savedConcurrencyLimit = Number(concurrency);
    } else {
      // No saved choice yet — the select's own value rules, so the
      // note line and the box can never disagree on a fresh install.
      savedConcurrencyLimit = Number(document.getElementById('setting-parallel').value) || 4;
    }
    // v2.14.0: the note line under the boxes must show the same number
    // the select shows — refresh it once the saved value is known.
    renderGenAccountsLine();
    if (folder) {
      document.getElementById('pref-folder').value = folder;
      document.getElementById('setting-folder').value = folder;
    }
    // v2.3.0: file naming mode (tag default / scene purana tareeka).
    const namingValue = String(namingMode) === 'scene' ? 'scene' : 'tag';
    document.getElementById('pref-naming').value = namingValue;
    document.getElementById('pref-chrome-path').value = chromePath || '';
    document.getElementById('pref-preview-autoplay').checked = String(autoplay) !== '0';
    document.getElementById('pref-auto-verify').checked = String(autoVerify) === '1';
    setBrowserBgUI(String(browserBg) !== '0');
    settingsLoaded = true;
    renderAbout();
  } catch (e) { /* settings are best-effort; defaults apply */ }
}

async function renderAbout() {
  try {
    const stats = await window.api.getUsageStats();
    const box = document.getElementById('about-box');
    box.innerHTML = '';
    const lines = [
      ['Version', 'FlowStudio Lite v2.15.0'],
      ['Accounts', String(currentAccounts.length)],
      ['Total videos saved', stats ? String(stats.total) : '—'],
      ['Design', 'Warm Premium (Dark) + White appearance — change it above']
    ];
    for (const [k, v] of lines) {
      const div = el('div', '');
      div.appendChild(el('b', '', `${k}: `));
      div.appendChild(document.createTextNode(v));
      box.appendChild(div);
    }
  } catch (e) {}
}

function bindPref(id, key, mirrorId) {
  const node = document.getElementById(id);
  if (!node) return;
  node.addEventListener('change', async () => {
    try { await window.api.setSetting(key, node.value); } catch (e) {}
    if (mirrorId) {
      const mirror = document.getElementById(mirrorId);
      if (mirror) mirror.value = node.value;
    }
    // v2.5.0: concurrency is Settings-only now — keep the Generate
    // status line's limit in step the moment it changes.
    if (key === 'concurrency') { savedConcurrencyLimit = Number(node.value) || 4; renderGenAccountsLine(); }
    updateSidebarTotals();
  });
}
bindPref('pref-model', 'default_model', 'setting-model');
bindPref('pref-duration', 'default_duration', 'setting-duration');
bindPref('pref-aspect', 'default_aspect', 'setting-aspect');
bindPref('setting-parallel', 'concurrency');
bindPref('pref-naming', 'naming_mode');
// Generate-page selects bhi defaults update karte hain (ek hi sach).
bindPref('setting-model', 'default_model', 'pref-model');
bindPref('setting-duration', 'default_duration', 'pref-duration');
bindPref('setting-aspect', 'default_aspect', 'pref-aspect');

document.getElementById('pref-chrome-path').addEventListener('change', async (e) => {
  try { await window.api.setSetting('chrome_path', e.target.value.trim()); } catch (err) {}
});
document.getElementById('btn-pref-chrome-browse').addEventListener('click', async () => {
  try {
    const res = await window.api.selectChromePath();
    if (res && res.success && res.path) {
      document.getElementById('pref-chrome-path').value = res.path;
      await window.api.setSetting('chrome_path', res.path);
    }
  } catch (e) {}
});
document.getElementById('btn-pref-pick-folder').addEventListener('click', async () => {
  try {
    const res = await window.api.selectFolder();
    if (res && res.success) {
      document.getElementById('pref-folder').value = res.folder;
      document.getElementById('setting-folder').value = res.folder;
      await window.api.setSetting('download_folder', res.folder);
    }
  } catch (err) {
    showToast(`Folder chunne me dikkat: ${err.message}`, 'error');
  }
});
document.getElementById('pref-preview-autoplay').addEventListener('change', async (e) => {
  try { await window.api.setSetting('preview_autoplay', e.target.checked ? '1' : '0'); } catch (err) {}
});
document.getElementById('pref-auto-verify').addEventListener('change', async (e) => {
  try { await window.api.setSetting('auto_verify_start', e.target.checked ? '1' : '0'); } catch (err) {}
});

// v2.2.0: browser background toggle — ONE setting, two switches
// (Settings + Generate), always in sync. ON (default) = generation
// runs headless/background; a browser is only ever SEEN when the
// owner opens it himself from a card's "Chrome ↗" button.
/* v2.11.0 FINAL: the switch is named "Show Browsers" (owner's
   order). The stored setting stays 'browser_background' — the two
   checkboxes now mean SHOW, so their checked state is the inverse
   of the stored background flag. */
let showBrowsersOn = false;
function setBrowserBgUI(bgOn) {
  showBrowsersOn = !bgOn;
  const a = document.getElementById('pref-browser-bg');
  const b = document.getElementById('setting-browser-bg');
  if (a) a.checked = showBrowsersOn;
  if (b) b.checked = showBrowsersOn;
  const desc = document.getElementById('showmode-desc');
  if (desc) desc.textContent = showBrowsersOn
    ? 'ON — browsers open on screen when you press Generate, so you can watch the work live.'
    : 'OFF — no window opens. The browsers work hidden in the background, so your PC stays light. Progress and Activity still show everything.';
  if (typeof renderGenAccountsLine === 'function') renderGenAccountsLine();
}
async function setBrowserBg(bgOn) {
  setBrowserBgUI(bgOn);
  try {
    await window.api.setSetting('browser_background', bgOn ? '1' : '0');
    showToast(bgOn
      ? 'Show Browsers OFF — browsers will work hidden in the background.'
      : 'Show Browsers ON — browsers will open on screen during generation.', 'success');
  } catch (err) {}
}
document.getElementById('pref-browser-bg').addEventListener('change', (e) => setBrowserBg(!e.target.checked));

// ---------- Events ----------
window.api.onLog(addLog);
window.api.onTaskUpdate(updateTaskRow);
window.api.onAccountUpdated((data) => {
  // Login/credit failures arriving as events are shown on the account
  // card — never silently dropped.
  if (data && data.success === false) {
    const id = data.accountId || (data.account && data.account.id);
    setAccountMessage(id, data.error || 'Something went wrong with this account.', true);
    if (data.accounts) renderAccounts(data.accounts);
    else if (id) renderAccounts(currentAccounts);
    else loadAccounts();
    refreshDashboard();
    return;
  }
  if (data && data.success === true && data.account && data.account.id) {
    setAccountMessage(data.account.id, null, false);
  }
  // v2.1.0 (stale card note fix): a FRESH account object arrived — its
  // balance/status may have just changed (e.g. credits charged during a
  // run). Any older non-error note on that card may now contradict the
  // live numbers (the owner's card kept saying the old credit count),
  // so drop it. Error notes stay until an explicit success clears them.
  if (data && data.account && data.account.id) {
    const existing = accountMessages.get(data.account.id);
    if (existing && !existing.isError) setAccountMessage(data.account.id, null, false);
  }
  if (data && data.accounts) renderAccounts(data.accounts);
  else loadAccounts();
  refreshDashboard();
});
window.api.onProgress((data) => {
  if (!data) return;
  // v2.7.0 (FIX 4): pool ki bheji hui asal ginati se Generate ki line
  // taaza karo — seema Settings se, live asal uplabdh, chal rahe
  // workers asal me kitne hain. Run khatam hote hi "chal rahe" 0.
  if (typeof data.seema === 'number') genLineState.seema = data.seema;
  if (typeof data.liveAccounts === 'number') genLineState.live = data.liveAccounts;
  if (typeof data.workersActive === 'number') genLineState.chal = data.workersActive;
  if (data.status === 'Completed' || data.status === 'Stopped' || data.status === 'NoAccounts' || data.status === 'Idle'
    || (typeof data.status === 'string' && data.status.startsWith('Error:'))) {
    genLineState.chal = 0;
  }
  renderGenAccountsLine();
  if (data.status === 'Completed') {
    stickyRunError = null;
    runStatus.classList.remove('error');
    setRunningUI(false);
    runStatus.textContent = 'Completed ✔';
    refreshDashboard();
    refreshSequenceReport();
  } else if (data.status === 'Stopped') {
    stickyRunError = null;
    runStatus.classList.remove('error');
    setRunningUI(false);
    runStatus.textContent = 'Stopped';
    refreshSequenceReport();
  } else if (data.status === 'NoAccounts') {
    stickyRunError = null;
    runStatus.classList.remove('error');
    setRunningUI(false);
    runStatus.textContent = 'No usable accounts — add an account and sign in first (Accounts tab).';
  } else if (typeof data.status === 'string' && data.status.startsWith('Error:')) {
    stickyRunError = data.status.slice('Error:'.length).trim();
    setRunningUI(false);
    runStatus.textContent = stickyRunError;
    runStatus.classList.add('error');
    refreshSequenceReport();
  } else if (data.status === 'Idle') {
    if (isRunning) { setRunningUI(false); refreshSequenceReport(); }
    if (stickyRunError) {
      runStatus.textContent = stickyRunError;
      runStatus.classList.add('error');
    }
    refreshDashboard();
  } else if (data.status) {
    runStatus.textContent = data.status;
  }
});
window.api.onActivityUpdate((entry) => {
  if (!entry) return;
  activityCache.unshift(entry);
  if (activityCache.length > 500) activityCache.length = 500;
  renderActivityMini();
  renderActivityFull();
});
window.api.onCookieCheckUpdate((data) => {
  if (!data || !data.accountId) return;
  if (data.phase === 'checking') {
    cookieStates.set(data.accountId, { state: 'checking', reason: '' });
    // The account may have JUST been created by this import — make
    // sure its card exists so the Checking… chip is visible live.
    if (!currentAccounts.some(a => a.id === data.accountId)) loadAccounts();
    else renderAccounts(currentAccounts);
  } else if (data.phase === 'done') {
    cookieStates.set(data.accountId, { state: data.state || 'fail', reason: data.reason || '' });
    renderAccounts(currentAccounts);
  }
});

// ---------- Init ----------
(async function init() {
  try {
    // Appearance FIRST (saved choice, restart ke baad bhi).
    try {
      const savedAppearance = await window.api.getSetting('appearance', 'dark');
      applyAppearance(typeof savedAppearance === 'string' ? savedAppearance : 'dark');
    } catch (e) { applyAppearance('dark'); }

    // v2.2.0: saved browser-background mode + activity view mode.
    try {
      const bg = await window.api.getSetting('browser_background', '1');
      setBrowserBgUI(String(bg) !== '0');
    } catch (e) { setBrowserBgUI(true); }
    // v2.5.0: "Sirf live accounts chalao" toggle ki saved haalat.
    try {
      const lo = await window.api.getSetting('live_only_accounts', '0');
      const t = document.getElementById('accounts-live-only');
      if (t) t.checked = String(lo) === '1';
    } catch (e) {}
    try {
      const mode = await window.api.getSetting('activity_view_mode', 'simple');
      if (mode === 'details') {
        activityMode = 'details';
        document.querySelectorAll('#activity-mode-seg .seg-btn').forEach(b =>
          b.classList.toggle('active', b.dataset.mode === 'details'));
      }
    } catch (e) {}

    await loadAccounts();
    await loadChromeProfiles();
    await loadActivity();
    refreshResumeBanner();
    updatePromptCount();

    const folder = await window.api.getDefaultDownloadFolder();
    if (folder) document.getElementById('setting-folder').value = folder;
    // v2.5.0: concurrency lives only in Settings — just remember it
    // for the Generate status line; every run re-reads it fresh.
    await readSavedConcurrency();
    updateSidebarTotals();
    // Saved generation defaults (Settings page se tay) Generate par lago.
    const [dm, dd, da] = await Promise.all([
      window.api.getSetting('default_model', ''),
      window.api.getSetting('default_duration', ''),
      window.api.getSetting('default_aspect', '')
    ]);
    if (dm) document.getElementById('setting-model').value = dm;
    if (dd) document.getElementById('setting-duration').value = dd;
    if (da) document.getElementById('setting-aspect').value = da;
  } catch (err) {
    // Never boot into a silent blank window.
    accountsEmpty.style.display = 'block';
    accountsEmpty.textContent = `There was a problem starting the app: ${err.message} — close the app and open it again.`;
  }
})();

// ================= v2.11.0 — FINAL DESIGN wiring =================
// Everything below serves the owner-approved final design: the top
// strip, the Add Account chooser, the Cookies box, custom tags, the
// Updates box, social links, the mobile tab bar and corner-drag
// resizing. Pure English UI throughout.

// ---------- Top strip: Sync = Verify All ----------
const stripSyncBtn = document.getElementById('btn-strip-sync');
if (stripSyncBtn) stripSyncBtn.addEventListener('click', () => {
  const b = document.getElementById('btn-sync-all');
  if (b) b.click();
});

// ---------- Add Account chooser (3 routes) ----------
const aaOverlay = document.getElementById('addaccount-overlay');
function closeAddAccountPopup() { if (aaOverlay) aaOverlay.hidden = true; }
const aaClose = document.getElementById('addaccount-close');
if (aaClose) aaClose.addEventListener('click', closeAddAccountPopup);
if (aaOverlay) aaOverlay.addEventListener('click', (e) => { if (e.target === aaOverlay) closeAddAccountPopup(); });
const aaLogin = document.getElementById('aa-opt-login');
if (aaLogin) aaLogin.addEventListener('click', () => { closeAddAccountPopup(); gmailLoginFlow(); });
const aaCookies = document.getElementById('aa-opt-cookies');
if (aaCookies) aaCookies.addEventListener('click', () => { closeAddAccountPopup(); openCookieModal(); });
const aaProfiles = document.getElementById('aa-opt-profiles');
if (aaProfiles) aaProfiles.addEventListener('click', () => { closeAddAccountPopup(); switchTo('import'); });

// ---------- Cookies box (FINAL design) ----------
let cookieFilter = 'all';
function cookieStateOf(acc) {
  const st = cookieStates.get(acc.id);
  if (st && st.state) return st;
  if (acc.hasCookies) return { state: 'ready', reason: '' };
  return null;
}
function renderAccountLines() {
  const box = document.getElementById('cookie-lines');
  if (!box) return;
  const counts = accountFilterCounts();
  document.querySelectorAll('#cookie-filter-seg button').forEach(b => {
    const k = b.dataset.cfilter;
    const label = k === 'all' ? 'All' : k === 'checking' ? 'Checking' : k === 'live' ? 'Live' : 'Fail';
    b.textContent = `${label} (${counts[k] || 0})`;
    b.classList.toggle('active', cookieFilter === k);
  });
  box.innerHTML = '';
  const visible = currentAccounts.filter(acc => lineMatchesFilter(acc, cookieFilter));
  if (visible.length === 0) {
    box.appendChild(el('div', 'empty ck-empty', currentAccounts.length === 0
      ? 'No accounts yet — press "+ Add Account" to sign in, or "Add Cookies" to add one.'
      : 'No accounts in this state.'));
    return;
  }
  visible.forEach((acc) => {
    const st = lineStateOf(acc);
    const line = el('div', 'ck-line');
    if (selectedAccounts.has(acc.id)) line.classList.add('selected');
    const tick = document.createElement('input');
    tick.type = 'checkbox';
    tick.className = 'acc-tick';
    tick.checked = selectedAccounts.has(acc.id);
    tick.addEventListener('change', () => {
      if (tick.checked) selectedAccounts.add(acc.id);
      else selectedAccounts.delete(acc.id);
      renderAccounts(currentAccounts);
    });
    line.appendChild(tick);
    const main = el('div', 'ck-main');
    main.appendChild(el('span', 'ck-name', accountDisplayName(acc)));
    let meta = '';
    if (st.state === 'checking') meta = 'checking…';
    else if (st.state === 'fail') meta = st.reason || 'check failed';
    else {
      const creditsText = (acc.credits === null || acc.credits === undefined) ? '— credits' : `${acc.credits} credits`;
      meta = st.reason ? `${st.reason} · ${creditsText}` : creditsText;
      if (typeof acc.credits === 'number' && acc.credits < LOW_CREDIT_THRESHOLD && st.state !== 'fail') meta += ' · Low';
    }
    main.appendChild(el('span', 'ck-meta', meta));
    line.appendChild(main);
    const chip = el('span', `ck-chip ${st.state}`,
      st.state === 'checking' ? 'CHECKING…' : st.state.toUpperCase());
    line.appendChild(chip);
    if (loginPendingIds.has(acc.id)) {
      const done = el('button', 'ck-open', 'Done');
      done.title = "Confirm this account's login";
      done.addEventListener('click', async () => {
        done.disabled = true;
        done.textContent = 'Checking…';
        try {
          const res = await window.api.completeLogin(acc.id);
          loginPendingIds.delete(acc.id);
          if (res && res.accounts) renderAccounts(res.accounts);
          if (res && res.success) setAccountMessage(acc.id, res.message || 'Login confirmed.', false);
          else setAccountMessage(acc.id, (res && res.error) || 'Login could not be confirmed yet.', true);
        } catch (err) {
          setAccountMessage(acc.id, `Login check failed: ${err.message}`, true);
        }
        renderAccounts(currentAccounts);
      });
      line.appendChild(done);
    }
    const open = el('button', 'ck-open', acc.status === 'Need Login' ? 'Sign In' : 'Chrome ↗');
    open.title = acc.status === 'Need Login' ? "Open this account's sign-in window" : "Open this account's Chrome";
    open.addEventListener('click', async () => {
      open.disabled = true;
      try {
        const res = await window.api.openLoginWindow(acc.id);
        if (res && res.success === false) {
          showToast(res.error || 'Chrome could not be opened.', 'error');
        } else if (acc.status === 'Need Login') {
          loginPendingIds.add(acc.id);
          setAccountMessage(acc.id, 'Chrome is open — sign in there, then press Done on this line.', false);
          renderAccounts(currentAccounts);
        }
      } catch (err) { showToast(`Chrome could not be opened: ${err.message}`, 'error'); }
      open.disabled = false;
    });
    line.appendChild(open);
    box.appendChild(line);
    // Notes live UNDER the line, only when there is something to say.
    if (acc.status === 'Cooldown' && acc.restUntil) {
      const till = new Date(acc.restUntil);
      if (!isNaN(till)) box.appendChild(el('div', 'ck-note', `Resting till ${till.toLocaleString()} — rotation skips this account until then.`));
    }
    if (acc.status === 'Unconfirmed') {
      box.appendChild(el('div', 'ck-note', 'Login unconfirmed — Sync once more to confirm (two-strike rule), or Sign In if this account really is logged out.'));
    }
    const msg = accountMessages.get(acc.id);
    if (msg) box.appendChild(el('div', msg.isError ? 'ck-note error' : 'ck-note', msg.text));
  });
}
// Kept as an alias: cookie-check events still call the old name.
function renderCookieLines() { renderAccountLines(); }
document.querySelectorAll('#cookie-filter-seg button').forEach(b => {
  b.addEventListener('click', () => { cookieFilter = b.dataset.cfilter; renderCookieLines(); });
});

// ---------- Custom tags (Generate TAG dropdown + Settings manager) ----------
let customTags = [];
let selectedCustomTag = '';
function renderTagUI() {
  const sel = document.getElementById('tag-select');
  if (sel) {
    const prev = selectedCustomTag;
    sel.innerHTML = '';
    const none = document.createElement('option');
    none.value = ''; none.textContent = 'None';
    sel.appendChild(none);
    for (const t of customTags) {
      const o = document.createElement('option');
      o.value = t; o.textContent = t;
      sel.appendChild(o);
    }
    sel.value = customTags.includes(prev) ? prev : '';
    selectedCustomTag = sel.value;
  }
  const chips = document.getElementById('custom-tags-chips');
  if (chips) {
    chips.innerHTML = '';
    for (const t of customTags) {
      const chip = el('button', 'ctag-chip', `${t}  ✕`);
      chip.title = 'Remove this tag';
      chip.addEventListener('click', async () => {
        customTags = customTags.filter(x => x !== t);
        if (selectedCustomTag === t) selectedCustomTag = '';
        await saveCustomTags();
        renderTagUI();
      });
      chips.appendChild(chip);
    }
    if (customTags.length === 0) chips.appendChild(el('span', 'hint', 'No custom tags yet.'));
  }
}
async function saveCustomTags() {
  try { await window.api.setSetting('custom_tags', JSON.stringify(customTags)); } catch (e) {}
}
async function addCustomTag(raw) {
  const t = String(raw || '').trim();
  if (!t) return false;
  if (customTags.some(x => x.toLowerCase() === t.toLowerCase())) {
    showToast(`Tag "${t}" already exists.`);
    return false;
  }
  customTags.push(t);
  await saveCustomTags();
  renderTagUI();
  return true;
}
const tagSelect = document.getElementById('tag-select');
if (tagSelect) tagSelect.addEventListener('change', () => { selectedCustomTag = tagSelect.value; });
const btnAddTag = document.getElementById('btn-add-tag');
if (btnAddTag) btnAddTag.addEventListener('click', async () => {
  const res = await showModal({
    title: '+ Add Tag',
    message: 'Write the tag name. Videos saved with this tag carry its name (e.g. Scence1.mp4).',
    inputLabel: 'Tag name',
    inputPlaceholder: 'e.g. Scence1',
    okText: 'Add Tag',
    cancelText: 'Cancel'
  });
  if (!res || !res.ok) return;
  if (await addCustomTag(res.value)) {
    selectedCustomTag = String(res.value).trim();
    const sel = document.getElementById('tag-select');
    if (sel) sel.value = selectedCustomTag;
    showToast(`Tag added: ${selectedCustomTag}`, 'success');
  }
});
const btnCustomTagAdd = document.getElementById('btn-custom-tag-add');
if (btnCustomTagAdd) btnCustomTagAdd.addEventListener('click', async () => {
  const input = document.getElementById('custom-tag-input');
  if (input && await addCustomTag(input.value)) {
    input.value = '';
    showToast('Tag added.', 'success');
  }
});

// ---------- Updates box ----------
const APP_VERSION = '2.15.0';
function versionNewer(a, b) {
  const pa = String(a || '').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}
async function checkUpdates(manual) {
  const status = document.getElementById('upd-status');
  const btn = document.getElementById('btn-check-updates');
  if (btn) btn.disabled = true;
  if (status) status.textContent = 'Checking for updates…';
  try {
    const res = await window.api.checkForUpdates();
    const now = new Date().toLocaleString();
    try { await window.api.setSetting('updates_last_check', now); } catch (e) {}
    if (!res || !res.ok) {
      if (status) status.textContent = `Could not check for updates${res && res.error ? ` (${res.error})` : ''} · Last checked: ${now}`;
      if (manual) showToast('Could not check for updates — check your internet connection.', 'error');
      return;
    }
    if (res.latest && versionNewer(res.latest, APP_VERSION)) {
      if (status) status.innerHTML = '';
      if (status) {
        status.appendChild(document.createTextNode(`⬆ A new version is available: ${res.latest} · Last checked: ${now} — `));
        const a = document.createElement('a');
        a.href = '#'; a.textContent = 'Open the release page';
        a.addEventListener('click', (e) => { e.preventDefault(); if (res.url) window.api.openExternal(res.url); });
        status.appendChild(a);
      }
      if (manual) showToast(`New version available: ${res.latest}`, 'success');
    } else {
      if (status) status.textContent = `✔ You are on the latest version · Last checked: ${now}`;
      if (manual) showToast('You are on the latest version.', 'success');
    }
  } catch (err) {
    if (status) status.textContent = `Could not check for updates (${err.message}).`;
  } finally {
    if (btn) btn.disabled = false;
  }
}
const btnCheckUpdates = document.getElementById('btn-check-updates');
if (btnCheckUpdates) btnCheckUpdates.addEventListener('click', async () => {
  // v2.12.0: once an update is downloaded, this button IS the
  // "Restart & Update" button.
  if (updateReadyVersion) {
    try { await window.api.updateInstall(); } catch (e) {}
    return;
  }
  checkUpdates(true);
  try { await window.api.updateCheck(); } catch (e) {}
});

// v2.12.0: live updater states (installed app only). Downloading
// happens in the background; when the update is ready, the status
// line says so and the Check button becomes "Restart & Update".
let updateReadyVersion = null;
if (window.api.onUpdateStatus) {
  window.api.onUpdateStatus((st) => {
    const status = document.getElementById('upd-status');
    const btn = document.getElementById('btn-check-updates');
    if (!st || !st.state) return;
    if (st.state === 'checking') {
      if (status) status.textContent = 'Checking for updates…';
    } else if (st.state === 'available') {
      if (status) status.textContent = `⬆ New version ${st.version || ''} found — downloading in the background…`;
    } else if (st.state === 'downloading') {
      if (status) status.textContent = `⬆ Downloading the update… ${st.percent || 0}%`;
    } else if (st.state === 'downloaded') {
      updateReadyVersion = st.version || '';
      if (status) status.textContent = `✔ Update ${updateReadyVersion} downloaded — press "Restart & Update" to finish.`;
      if (btn) { btn.textContent = '↻ Restart & Update'; btn.disabled = false; }
    } else if (st.state === 'error') {
      if (status) status.textContent = `Update failed (${st.error || 'unknown error'}) — try again later.`;
      if (btn) btn.disabled = false;
    }
  });
}
const prefAutoUpdate = document.getElementById('pref-auto-update');
if (prefAutoUpdate) prefAutoUpdate.addEventListener('change', async (e) => {
  try { await window.api.setSetting('auto_check_updates', e.target.checked ? '1' : '0'); } catch (err) {}
});

// ---------- Social links ----------
let socialLinks = {};
async function loadSocialLinks() {
  try {
    socialLinks = JSON.parse(await window.api.getSetting('social_links', '{}')) || {};
  } catch (e) { socialLinks = {}; }
  ['whatsapp', 'chat', 'support'].forEach(net => {
    const input = document.getElementById(`social-${net}`);
    if (input) input.value = socialLinks[net] || '';
  });
}
['whatsapp', 'chat', 'support'].forEach(net => {
  const input = document.getElementById(`social-${net}`);
  if (input) input.addEventListener('change', async () => {
    socialLinks[net] = input.value.trim();
    try { await window.api.setSetting('social_links', JSON.stringify(socialLinks)); } catch (e) {}
  });
});
document.querySelectorAll('.social-icon').forEach(btn => {
  btn.addEventListener('click', () => {
    const url = socialLinks[btn.dataset.net];
    if (url) window.api.openExternal(url);
    else showToast('This link is not set yet — add it in Settings, in the CREATED BY box.');
  });
});

// ---------- Mobile tab bar (<=699px) ----------
document.querySelectorAll('#mobile-tabbar button').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.mtab;
    document.body.dataset.mtab = tab;
    document.querySelectorAll('#mobile-tabbar button').forEach(b => b.classList.toggle('active', b === btn));
    if (tab === 'settings') switchTo('settings');
    else switchTo('generate');
  });
});

// ---------- Corner-drag resizing (cookies box + prompts box) ----------
function makeCornerResizable(elm, settingKey, minH, maxH) {
  if (!elm) return;
  elm.style.position = elm.style.position || 'relative';
  let drag = null;
  elm.addEventListener('mousedown', (e) => {
    const r = elm.getBoundingClientRect();
    if (e.clientX > r.right - 18 && e.clientY > r.bottom - 18) {
      drag = { y: e.clientY, h: r.height };
      e.preventDefault();
    }
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const h = Math.max(minH, Math.min(maxH, drag.h + (e.clientY - drag.y)));
    elm.style.height = `${h}px`;
    elm.style.flex = 'none';
  });
  window.addEventListener('mouseup', async () => {
    if (!drag) return;
    drag = null;
    try { await window.api.setSetting(settingKey, String(Math.round(elm.getBoundingClientRect().height))); } catch (e) {}
  });
}
makeCornerResizable(document.getElementById('cookie-lines'), 'cookie_box_h', 84, 460);
makeCornerResizable(document.querySelector('.gen-form'), 'prompts_box_h', 240, 1000);

// ---------- v2.11 init extras ----------
(async function initV211() {
  try {
    try {
      customTags = JSON.parse(await window.api.getSetting('custom_tags', '[]')) || [];
    } catch (e) { customTags = []; }
    if (!Array.isArray(customTags) || customTags.length === 0) {
      customTags = ['Scence1', 'Scence2', 'Intro', 'Ending'];
    }
    renderTagUI();
    await loadSocialLinks();
    const autoUpd = await window.api.getSetting('auto_check_updates', '1');
    if (prefAutoUpdate) prefAutoUpdate.checked = String(autoUpd) !== '0';
    const lastCheck = await window.api.getSetting('updates_last_check', '');
    const status = document.getElementById('upd-status');
    if (status && lastCheck) status.textContent = `Last checked: ${lastCheck}`;
    const updCur = document.getElementById('upd-current');
    if (updCur) updCur.textContent = `v${APP_VERSION}`;
    const stripVer = document.getElementById('strip-version');
    if (stripVer) stripVer.textContent = `v${APP_VERSION}`;
    if (typeof updatePromptCount === 'function') { try { updatePromptCount(); } catch (e) {} }
    const ckH = parseInt(await window.api.getSetting('cookie_box_h', ''), 10);
    const ckBox = document.getElementById('cookie-lines');
    if (ckBox && ckH >= 84 && ckH <= 460) { ckBox.style.height = `${ckH}px`; ckBox.style.flex = 'none'; }
    if (String(autoUpd) !== '0') checkUpdates(false);
  } catch (e) { /* v2.11 extras are best-effort */ }
})();
