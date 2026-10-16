const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

// v2.12.0: when the app runs INSTALLED (packaged), accounts data
// and Chrome profiles must NOT live inside the install folder — an
// update replaces that folder. They go to the per-user data folder
// instead, where updates never touch them. Source runs (and the
// test suites, which set FLOW_LITE_DATA_DIR themselves) are
// completely unaffected. This must run BEFORE the engine loads.
if (app.isPackaged) {
  if (!process.env.FLOW_LITE_DATA_DIR) {
    process.env.FLOW_LITE_DATA_DIR = path.join(app.getPath('userData'), 'data');
  }
  if (!process.env.FLOW_LITE_PROFILES_DIR) {
    process.env.FLOW_LITE_PROFILES_DIR = path.join(app.getPath('userData'), 'profiles');
  }
}

const {
  getAccounts,
  addAccount,
  deleteAccount,
  openLoginWindow,
  completeLoginCheck,
  fetchRealCredits,
  refreshAllAccountCredits,
  getInstalledChromeProfiles,
  importFromInstalledChrome,
  importAllInstalledChromeProfiles
} = require('./engine/accountStore');
const { importAccountFromCookieFile, importAccountFromCookieText, importAccountsFromCookieFiles, recheckAccountCookies } = require('./engine/cookieImport');
const { WorkerPool } = require('./engine/workerPool');
const { dbService } = require('./engine/db');
const { assertAccountId, assertChromeProfileDirName, validateNumericSetting, assertAllowedMediaFile } = require('./engine/pathSecurity');
const liveBrowsers = require('./engine/liveBrowsers');
const { killProcessesByPid } = require('./engine/processHelper');
const usageStats = require('./engine/usageStats');
const browserMode = require('./engine/browserMode');
const { getActivityStore, recordActivity } = require('./engine/activityStore');
// v2.1.0: the app version is read from package.json (single source), so
// the startup Activity line can never drift from the shipped version.
const APP_VERSION = (() => { try { return require('./package.json').version; } catch (e) { return '2.9.0'; } })();
const creditWatch = require('./engine/creditWatch');
const { buildSequenceReport } = require('./engine/sequenceReport');
const { fileNameForTag } = require('./engine/tagNaming');
const promptMatch = require('./engine/promptMatch');
const plainError = require('./engine/plainError');
const { pathToFileURL } = require('url');

let mainWindow = null;
let activeWorkerPool = null;
let previewWindow = null;
// v2.3.0: the most recent run's identity ({ batchId, taskIds,
// downloadFolder }), fed by the pool's onRunStart — the sequence
// report is built for exactly these tasks.
let lastRunInfo = null;

/** v2.3.0: download naming mode — 'tag' (default) or 'scene' (purana). */
function currentNamingPattern() {
  return dbService.getSetting('naming_mode', 'tag') === 'scene' ? 'scene' : 'tag';
}

/**
 * v2.3.0: normalise the renderer's prompt payload — items may be
 * plain strings or { text, tag, index } from the smart parser.
 * `index` preserves the original position (never renumbered).
 */
function normalizePromptItems(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const p of list) {
    if (typeof p === 'string') {
      const text = p.trim();
      if (text) out.push({ text, tag: '' });
    } else if (p && typeof p === 'object') {
      const text = String(p.text || '').trim();
      if (!text) continue;
      const item = { text, tag: String(p.tag || '').trim().slice(0, 60) };
      if (Number.isInteger(p.index)) item.index = p.index;
      out.push(item);
    }
  }
  return out;
}

/**
 * v2.0.0: low-credit alerts — an account under 10 credits raises ONE
 * Activity entry per account per DAY (creditWatch holds the dedupe
 * state). Called after syncs, pool account updates, run finishes and
 * once shortly after startup (balances are stored, no browser needed).
 */
function runLowCreditAlerts() {
  try {
    const watch = creditWatch.createCreditWatch(dbService);
    watch.checkLowAlerts(dbService.getAccounts(), (acc) => {
      recordActivity({
        category: 'credits', level: 'warn', accountId: acc.id,
        accountName: acc.googleName || acc.name,
        stage: 'credits',
        detail: `Is account ka balance 10 credits se neeche aa gaya hai — is par sirf chhote/ek-aadh video hi ban payenge. Credits kal ke daily refresh se bhar sakte hain, ya koi dusra account istemal karo. Ye alert ek account ke liye din me sirf ek baar aata hai.`,
        message: `Low credits alert: ${acc.googleName || acc.name} — sirf ${acc.credits} credits bache (10 se kam)`
      });
    });
  } catch (e) {}
}

/**
 * v2.0.0: one place builds a WorkerPool with the full IPC wiring.
 * v2.2.0: the pool's background mode comes from the owner's
 * 'browser_background' setting (default ON) — Generate runs in the
 * background without popping Chrome windows; the visible browser is
 * opened by hand from the card's "Chrome ↗" button only.
 * v2.4.0: "background" no longer means Puppeteer headless — the
 * engine launches a real headed Chrome parked off-screen/minimized
 * (engine/browserMode.js launchPlan), because headless stalled Flow
 * on the owner's PC. The pool flag keeps its name (`headless` =
 * background requested) so the wiring below is unchanged.
 */
function createPool(concurrency) {
  const background = browserMode.resolveBackgroundEnabled(dbService.getSetting(browserMode.SETTING_KEY, '1'));
  return new WorkerPool({
    concurrency,
    headless: background,
    // v2.5.0: "Sirf live accounts chalao" (Accounts page toggle) —
    // har run par taaza padha jata hai, isliye toggle ka asar agle hi
    // Generate se dikhta hai.
    liveOnly: dbService.getSetting('live_only_accounts', '0') === '1',
    onLog: (data) => send('automation-log', data),
    onProgress: (data) => send('automation-progress', data),
    onWorkerUpdate: (data) => send('worker-update', data),
    onVideoStarted: (data) => send('video-started', data),
    onVideoProgress: (data) => send('video-progress', data),
    onVideoCompleted: (data) => send('video-completed', data),
    onAccountUpdated: (data) => { send('account-updated', data); runLowCreditAlerts(); },
    onTaskUpdate: (data) => send('task-update', data),
    onRunStart: (info) => { lastRunInfo = info; }
  });
}

/** v2.0.0: shared run launcher — a queue-level failure stays VISIBLE. */
function launchPoolRun(pool, runFn, errLabel) {
  runFn(pool)
    .catch(err => {
      // v2.4.0: plain-language first, raw technical text attached.
      const t = plainError.translateError(err);
      send('automation-log', { message: `${errLabel} error: ${t.plain}`, type: 'error', timestamp: new Date().toLocaleTimeString(), rawError: t.raw });
      send('automation-progress', { status: `Error: ${t.plain}` });
    })
    .finally(() => {
      if (activeWorkerPool === pool) activeWorkerPool = null;
      try { dbService.persistNow(); } catch (e) {}
      runLowCreditAlerts();
      send('automation-progress', { status: 'Idle' });
    });
}

// v1.9.0: a stray rejected promise in the main process used to vanish
// silently (or crash without a trace). Log it and keep the app alive —
// the flows that matter surface their own errors to the renderer.
process.on('unhandledRejection', (reason) => {
  console.error('[FlowStudio Lite] Unhandled promise rejection:', reason && reason.message ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[FlowStudio Lite] Uncaught exception:', err && err.message ? err.message : err);
});

// Trusted-renderer guard (pattern from V2 main.js): every IPC handler runs
// this first, so only the app's own top-level renderer frame can invoke.
function assertTrustedRenderer(event) {
  if (!mainWindow || mainWindow.isDestroyed() || !event || !event.sender) {
    throw new Error('Untrusted IPC sender: Window is not available');
  }
  if (event.sender !== mainWindow.webContents) {
    throw new Error('Untrusted IPC sender: Event sender does not match main window');
  }
  if (event.senderFrame && event.senderFrame.parent !== null) {
    throw new Error('Untrusted IPC sender: Child frame IPC invocation is forbidden');
  }
  const currentUrl = event.sender.getURL();
  if (typeof currentUrl !== 'string' || (!currentUrl.startsWith('file:') && currentUrl !== 'about:blank')) {
    throw new Error('Untrusted IPC sender: Renderer window navigated to an untrusted URL');
  }
}

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function getDefaultDownloadFolder() {
  const saved = dbService.getSetting('download_folder', '');
  if (saved && typeof saved === 'string' && saved.trim()) return saved.trim();
  return path.join(os.homedir(), 'Downloads', 'FlowStudioLite_Videos');
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  // v2.2.0: default size fits a typical laptop screen (~1280x800) —
  // the window can always be maximised from its own title bar.
  // v2.7.0: default ab 1180x760 hai — owner ki chhoti screen par
  // 1280x800 kinare se bahar ja raha tha; saare views is size par
  // bhi fit-test pass karte hain (1000x650 tak).
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 1000,
    minHeight: 640,
    title: 'FlowStudio Lite',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // v2.2.0 fit-to-screen self-check (tests/fitcheck.js): only when the
  // FLOW_LITE_FIT_TEST env flag is set — the app is sized 1100x750 and
  // every view is opened in turn; a view FAILS if the document itself
  // would scroll (body scroll) or if any fixed chrome (toolbar /
  // stats / bulk bar) is pushed outside the window. Internal list
  // regions scrolling is the design, not a failure.
  if (process.env.FLOW_LITE_FIT_TEST === '1') {
    // v2.6.0: the size comes from the harness (tests/fitcheck.js runs
    // 1100x750 AND the owner's smaller 1024x700) — default 1100x750.
    const fitW = parseInt(process.env.FLOW_LITE_FIT_WIDTH || '1100', 10) || 1100;
    const fitH = parseInt(process.env.FLOW_LITE_FIT_HEIGHT || '750', 10) || 750;
    mainWindow.setSize(fitW, fitH);
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const script = `
            (async () => {
              const wait = (ms) => new Promise(r => setTimeout(r, ms));
              const views = ['generate', 'history', 'activity', 'import', 'settings'];
              const out = {};
              for (const v of views) {
                const btn = document.querySelector('.nav-btn[data-view="' + v + '"]');
                if (btn) btn.click();
                await wait(400);
                const de = document.documentElement;
                const viewEl = document.querySelector('.view.active');
                const offenders = [];
                if (viewEl) {
                  viewEl.querySelectorAll('.toolbar, .stats-row, .bulk-bar, .actions, .resume-banner, .view-head').forEach(elm => {
                    const r = elm.getBoundingClientRect();
                    if (r.width > 0 && (r.bottom > window.innerHeight + 4 || r.top < -4)) {
                      offenders.push(elm.className + '@' + Math.round(r.bottom));
                    }
                  });
                }
                out[v] = {
                  docOverflow: de.scrollHeight - de.clientHeight,
                  viewOverflow: viewEl ? (viewEl.scrollHeight - viewEl.clientHeight) : -1,
                  offenders
                };
              }
              return out;
            })()
          `;
          const result = await mainWindow.webContents.executeJavaScript(script);
          let fail = false;
          for (const [v, r] of Object.entries(result)) {
            if (r.docOverflow > 2 || r.viewOverflow > 2 || r.offenders.length > 0) fail = true;
          }
          console.log('FIT_RESULT ' + JSON.stringify({ pass: !fail, views: result }));
          app.exit(fail ? 1 : 0);
        } catch (e) {
          console.log('FIT_RESULT ' + JSON.stringify({ pass: false, error: String(e && e.message || e) }));
          app.exit(1);
        }
      }, 1500);
    });
  }

  // v2.5.0 prompt-entry UI test (tests/uitest.js): only when the
  // FLOW_LITE_UI_TEST env flag is set. Drives the REAL Generate page
  // exactly like a user: types/pastes into the prompts textarea in
  // every prompt mode (counter + detect line checked), then clicks
  // Generate for real — a seeded throwaway account makes the run
  // start, and main reads the created queue rows back from the DB to
  // prove the prompts + tags travelled the whole IPC intact. (The
  // renderer-side window.api cannot be stubbed — contextBridge
  // objects are frozen — so the DB is the honest capture point.)
  // With FLOW_LITE_UI_TEST_GUARD_FAIL=1 the duplicate-guard handler
  // throws on purpose (see its test seam) and the SAME flow must
  // still create the batch.
  if (process.env.FLOW_LITE_UI_TEST === '1') {
    try {
      const existing = dbService.getAccounts ? dbService.getAccounts() : [];
      if (!existing || existing.length === 0) {
        dbService.insertAccount({ id: 'acc_ui_test', name: 'UI Test', email: 'ui@test.local', dirName: 'acc_ui_test', status: 'Ready', credits: 500 });
      }
    } catch (e) {}
    mainWindow.webContents.on('console-message', (e, level, message) => {
      if (level >= 2) console.log('RENDERER_CONSOLE ' + message);
    });
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const finish = (obj, code) => {
          console.log('UI_RESULT ' + JSON.stringify(obj));
          app.exit(code);
          setTimeout(() => process.exit(code), 3000);
        };
        try {
          const script = `
            (async () => {
              const wait = (ms) => new Promise(r => setTimeout(r, ms));
              const errors = [];
              window.addEventListener('error', (ev) => { errors.push('window.onerror: ' + (ev.message || ev.error)); });
              window.addEventListener('unhandledrejection', (ev) => { errors.push('unhandledrejection: ' + (ev.reason && ev.reason.message || ev.reason)); });
              const out = { errors, steps: {} };
              document.querySelector('.nav-btn[data-view="generate"]').click();
              await wait(400);
              const area = document.getElementById('prompts-input');
              const count = () => document.getElementById('prompt-count').textContent;
              const detect = () => document.getElementById('prompt-detect').textContent;
              const setText = async (text) => {
                area.focus();
                area.value = text;
                area.dispatchEvent(new Event('input', { bubbles: true }));
                await wait(120);
              };
              const modeOf = () => {
                const b = document.querySelector('#prompt-mode-seg .seg-btn.active');
                return b ? b.dataset.mode : '(none)';
              };
              const clickMode = async (mode) => {
                const b = document.querySelector('#prompt-mode-seg .seg-btn[data-mode="' + mode + '"]');
                if (b) { b.click(); await wait(120); }
                return !!b;
              };
              out.steps.initialMode = modeOf();
              out.steps.offeredModes = Array.from(document.querySelectorAll('#prompt-mode-seg .seg-btn')).map(b => b.dataset.mode);
              // 1) paragraph-style text in the default (Bulk) mode
              await setText('A lighthouse in a storm, waves crashing over the rocks.\\n\\nA drone flyover of a green valley at sunrise.');
              out.steps.defaultModeParagraphText = { mode: modeOf(), count: count(), detect: detect() };
              // 2) tag-style text in Bulk mode (smart parser)
              await setText('#00-01 A lighthouse in a storm\\n#00-02 A drone flyover of a valley');
              out.steps.defaultModeTagText = { mode: modeOf(), count: count() };
              // 3) every offered mode, both text shapes
              out.steps.modes = {};
              for (const m of out.steps.offeredModes) {
                await clickMode(m);
                await setText('First prompt about a red car\\nSecond prompt about a blue boat');
                const twoLines = count();
                await setText('Para one is here, it is a single paragraph.\\n\\nPara two follows after a blank line.');
                const twoParas = count();
                out.steps.modes[m] = { twoLines, twoParas, activeAfter: modeOf() };
              }
              // 4) REAL Generate click — the batch must land in the DB
              await clickMode('bulk');
              await setText('#00-01 A lighthouse in a storm\\n#00-02 A drone flyover of a valley\\n#00-03 A cat sleeping in sunlight');
              out.steps.beforeGenerate = { count: count(), detect: detect() };
              document.getElementById('btn-generate').click();
              await wait(2500);
              out.steps.runStatus = document.getElementById('run-status').textContent;
              const modal = document.getElementById('modal-overlay');
              out.steps.modalVisible = modal ? !modal.hidden : null;
              const logBox = document.getElementById('log-box');
              out.steps.logHasGuardSkip = logBox ? logBox.textContent.includes('Duplicate check nahi ho paya') : false;
              out.steps.logTail = logBox ? logBox.textContent.slice(-300) : '';
              out.errors = errors;
              return out;
            })()
          `;
          const result = await mainWindow.webContents.executeJavaScript(script);
          try {
            result.dbTasks = dbService.query('SELECT prompt_text, prompt_tag FROM queue_tasks ORDER BY prompt_index ASC')
              .map(r => ({ text: r.prompt_text, tag: r.prompt_tag }));
          } catch (e) { result.dbTasks = []; result.dbError = String(e && e.message || e); }
          try { result.savedConcurrency = dbService.getSetting('concurrency', ''); } catch (e) {}
          finish(result, 0);
        } catch (e) {
          finish({ pass: false, error: String(e && e.message || e) }, 1);
        }
      }, 1500);
    });
  }

  // QA screenshot seam (v2.6.0): FLOW_LITE_SHOT_DIR=<dir> (+ optional
  // FLOW_LITE_FIT_WIDTH/HEIGHT for the window size) — captures the
  // Generate view as a PNG and exits (v2.10.0: Accounts view gaya;
  // sidebar ka vertical accounts box har shot me dikhta hai).
  // Design-review aid only; never set in normal use.
  if (process.env.FLOW_LITE_SHOT_DIR) {
    const shotDir = process.env.FLOW_LITE_SHOT_DIR;
    const shotW = parseInt(process.env.FLOW_LITE_FIT_WIDTH || '1024', 10) || 1024;
    const shotH = parseInt(process.env.FLOW_LITE_FIT_HEIGHT || '700', 10) || 700;
    mainWindow.setSize(shotW, shotH);
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const fs = require('fs');
          fs.mkdirSync(shotDir, { recursive: true });
          for (const v of ['generate']) {
            await mainWindow.webContents.executeJavaScript(`document.querySelector('.nav-btn[data-view="${v}"]').click()`);
            await new Promise(r => setTimeout(r, 900));
            const wide = await mainWindow.webContents.executeJavaScript(`(() => { const out = []; const view = document.querySelector('.view.active'); const vr = view.getBoundingClientRect(); document.querySelectorAll('.view.active *').forEach(elm => { const r = elm.getBoundingClientRect(); if (r.width > 0 && r.right > vr.right + 2) out.push((elm.tagName || '') + '.' + (elm.className || elm.id || '') + ' right=' + Math.round(r.right) + ' viewRight=' + Math.round(vr.right) + ' w=' + Math.round(r.width)); }); return out.slice(0, 8); })()`);
            if (wide && wide.length) console.log('WIDE ' + v + ': ' + wide.join(' | '));
            const img = await mainWindow.webContents.capturePage();
            fs.writeFileSync(require('path').join(shotDir, `${v}-${shotW}x${shotH}.png`), img.toPNG());
          }
          console.log('SHOTS_DONE ' + shotDir);
          app.exit(0);
        } catch (e) {
          console.error('SHOT_FAIL ' + String(e && e.message || e));
          app.exit(1);
        }
      }, 1800);
    });
  }
}

app.whenReady().then(async () => {
  await dbService.ensureInit();
  // Audit fix #1: recover any task a crashed previous session left 'running'.
  const recovered = dbService.getRecoveredInterruptedCount();
  if (recovered > 0) {
    console.log(`[FlowStudio Lite] Recovered ${recovered} interrupted task(s) -> failed: interrupted`);
  }
  createWindow();

  // v2.12.0: arm the auto-updater; a quiet first check follows a
  // few seconds later when the owner left "Check automatically" on.
  setupAutoUpdater();
  if (autoUpdater && app.isPackaged) {
    setTimeout(() => {
      try {
        if (String(dbService.getSetting('auto_check_updates', '1')) !== '0') {
          autoUpdater.checkForUpdates().catch(() => {});
        }
      } catch (e) {}
    }, 6000);
  }

  // v2.0.0: Activity — live-push every new entry to the renderer, note
  // the start, check stored balances for low-credit alerts, and honour
  // the Settings "auto verify on start" toggle (background, never
  // blocking the UI — the Indifference Rule applies to the app too).
  try { getActivityStore().setBroadcaster((entry) => send('activity-update', entry)); } catch (e) {}
  recordActivity({ category: 'system', level: 'info', message: `FlowStudio Lite v${APP_VERSION} shuru hua` });
  setTimeout(() => {
    runLowCreditAlerts();
    try {
      if (dbService.getSetting('auto_verify_start', '0') === '1') {
        recordActivity({ category: 'system', level: 'info', message: 'Auto-verify (start par) chal raha hai…' });
        refreshAllAccountCredits()
          .then(({ summary }) => {
            if (summary) {
              recordActivity({ category: 'login', level: 'info', stage: 'verify', detail: 'Har account ka live check hua: live = login sahi aur credits hain · low = login sahi, credits kam · exhausted = credits 0 · need-login = do baar sign-out confirm hua · unconfirmed = ek baar sign-out dikha, pakka nahi · unknown = check pura nahi ho paya.', message: `Auto-verify complete: ${summary.live} live · ${summary.low} low · ${summary.exhausted} exhausted · ${summary.needLogin} need-login · ${summary.unconfirmed} unconfirmed · ${summary.unknown} unknown` });
            }
            send('account-updated', { accounts: getAccounts() });
            runLowCreditAlerts();
          })
          .catch(() => {});
      }
    } catch (e) {}
  }, 4000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  // v1.9.0: Electron does NOT wait for an async before-quit handler, so
  // the flush must happen FIRST and synchronously — previously it sat
  // behind awaits at the end and a fast quit could lose the last
  // debounce window (2s) of account/task changes.
  try { dbService.persistNow(); } catch (e) {}
  if (activeWorkerPool) {
    try { await activeWorkerPool.stop(); } catch (e) {}
    activeWorkerPool = null;
  }
  // v1.4: never leave the app's own Sign In Chrome running behind us —
  // an orphaned login window holding its profile invisibly is exactly
  // the failure the deep audit found. These PIDs are registered by
  // openLoginWindow itself, so only app-spawned windows are closed.
  try {
    const loginProcs = liveBrowsers.listLoginProcesses();
    if (loginProcs.length > 0) {
      // Unregister first (v1.6.0): the windows' close handlers read
      // their registration to decide whether to auto-sync — during
      // shutdown they must stay silent.
      for (const p of loginProcs) {
        try { liveBrowsers.unregister(p.accountId, p.pid); } catch (e) {}
      }
      await killProcessesByPid(loginProcs.map((p) => p.pid));
    }
  } catch (e) {}
  try { dbService.persistNow(); } catch (e) {}
});

// ---------------- Accounts ----------------

ipcMain.handle('get-accounts', async (event) => {
  assertTrustedRenderer(event);
  await dbService.ensureInit();
  return getAccounts();
});

ipcMain.handle('add-account', async (event, payload) => {
  assertTrustedRenderer(event);
  await dbService.ensureInit();
  // v2.2.0: the Add modal sends { name, email } (email optional). A
  // plain string payload is still accepted for safety.
  const name = typeof payload === 'string' ? payload : (payload && typeof payload.name === 'string' ? payload.name : '');
  const email = (payload && typeof payload === 'object' && typeof payload.email === 'string') ? payload.email : '';
  const result = addAccount(name, email);
  if (result && result.account) {
    recordActivity({ category: 'system', level: 'info', accountId: result.account.id, accountName: result.account.name, message: `Naya account joda: ${result.account.name}` });
  }
  return result;
});

ipcMain.handle('delete-account', async (event, id) => {
  assertTrustedRenderer(event);
  await dbService.ensureInit();
  assertAccountId(id);
  const before = dbService.getAccount(id);
  const accounts = deleteAccount(id);
  recordActivity({ category: 'system', level: 'warn', accountId: id, accountName: before ? (before.googleName || before.name) : null, message: `Account hataya gaya: ${before ? (before.googleName || before.name) : id}` });
  return { success: true, accounts };
});

ipcMain.handle('open-login-window', async (event, id) => {
  assertTrustedRenderer(event);
  await dbService.ensureInit();
  assertAccountId(id);
  return openLoginWindow(id, (data) => {
    send('account-updated', data);
  });
});

ipcMain.handle('complete-login', async (event, id) => {
  assertTrustedRenderer(event);
  await dbService.ensureInit();
  assertAccountId(id);
  return await completeLoginCheck(id);
});

ipcMain.handle('sync-account', async (event, id) => {
  assertTrustedRenderer(event);
  await dbService.ensureInit();
  assertAccountId(id);
  return await fetchRealCredits(id);
});

ipcMain.handle('sync-all-accounts', async (event) => {
  assertTrustedRenderer(event);
  await dbService.ensureInit();
  // v1.8.0: Sync All is the verify pass — returns the classified
  // summary alongside the refreshed accounts.
  const { accounts, summary } = await refreshAllAccountCredits();
  if (summary) {
    recordActivity({ category: 'login', level: 'info', stage: 'verify', detail: 'Har account ka live check hua: live = login sahi aur credits hain · low = login sahi, credits kam · exhausted = credits 0 · need-login = do baar sign-out confirm hua · unconfirmed = ek baar sign-out dikha, pakka nahi · unknown = check pura nahi ho paya. Jo check ek baar me pakka nahi hua, use ek baar khud dobara check kiya gaya tha.', message: `Verify All: ${summary.live} live · ${summary.low} low · ${summary.exhausted} exhausted · ${summary.needLogin} need-login · ${summary.unconfirmed} unconfirmed · ${summary.unknown} unknown` });
  }
  runLowCreditAlerts();
  return { success: true, accounts, summary };
});

ipcMain.handle('get-installed-chrome-profiles', async (event) => {
  assertTrustedRenderer(event);
  return getInstalledChromeProfiles();
});

ipcMain.handle('import-chrome-profile', async (event, dirName) => {
  assertTrustedRenderer(event);
  await dbService.ensureInit();
  assertChromeProfileDirName(dirName);
  return await importFromInstalledChrome(dirName);
});

ipcMain.handle('import-all-chrome-profiles', async (event) => {
  assertTrustedRenderer(event);
  await dbService.ensureInit();
  return await importAllInstalledChromeProfiles();
});

// Cookie-file import. The dialog runs in the main process (trusted file
// paths). v2.0.0 (owner's order): the engine SAVES the parsed cookies
// per-account in the app data folder and runs an AUTOMATIC check whose
// live phases stream back here as 'cookie-check-update' events, so the
// account row's 🍪 chip shows Checking… -> Live / Ready / Fail — reason.
const COOKIE_FILE_FILTERS = [
  { name: 'Cookie files', extensions: ['txt', 'json'] },
  { name: 'All files', extensions: ['*'] }
];
const cookiePhase = (data) => send('cookie-check-update', data);

ipcMain.handle('import-cookie-file', async (event, payload) => {
  assertTrustedRenderer(event);
  await dbService.ensureInit();
  const label = (payload && typeof payload.label === 'string') ? payload.label : '';
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select a cookie file for this account',
    properties: ['openFile'],
    filters: COOKIE_FILE_FILTERS
  });
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return { success: false, canceled: true, accounts: getAccounts() };
  }
  return await importAccountFromCookieFile({ filePath: result.filePaths[0], label, onPhase: cookiePhase });
});

ipcMain.handle('import-cookie-files-bulk', async (event) => {
  assertTrustedRenderer(event);
  await dbService.ensureInit();
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select cookie files — one file per account',
    properties: ['openFile', 'multiSelections'],
    filters: COOKIE_FILE_FILTERS
  });
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return { success: false, canceled: true, accounts: getAccounts() };
  }
  return await importAccountsFromCookieFiles(result.filePaths, cookiePhase);
});

// v2.2.0: import from PASTED cookie text (cookie modal's paste path).
// The text travels over IPC from the app's own renderer only; the
// engine parses it with the same parser/store/check as files, and a
// parse failure returns BEFORE any account is created so the modal
// can show the error inline. Cookie values are never logged here.
ipcMain.handle('import-cookie-text', async (event, payload) => {
  assertTrustedRenderer(event);
  await dbService.ensureInit();
  const label = (payload && typeof payload.label === 'string') ? payload.label : '';
  const text = (payload && typeof payload.text === 'string') ? payload.text : '';
  return await importAccountFromCookieText({ text, label, onPhase: cookiePhase });
});

// v2.0.0: re-run the automatic check against an account's SAVED cookies.
ipcMain.handle('recheck-cookies', async (event, id) => {
  assertTrustedRenderer(event);
  await dbService.ensureInit();
  assertAccountId(id);
  const res = await recheckAccountCookies(id, cookiePhase);
  runLowCreditAlerts();
  return res;
});

// ---------------- Files & settings ----------------

ipcMain.handle('select-folder', async (event) => {
  assertTrustedRenderer(event);
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return { success: false, folder: '' };
  }
  return { success: true, folder: result.filePaths[0] };
});

ipcMain.handle('open-folder', async (event, folderPath) => {
  assertTrustedRenderer(event);
  if (typeof folderPath !== 'string' || !folderPath.trim()) return { success: false };
  const resolved = path.resolve(folderPath.trim());
  if (!fs.existsSync(resolved)) {
    try { fs.mkdirSync(resolved, { recursive: true }); } catch (e) { return { success: false, error: e.message }; }
  }
  await shell.openPath(resolved);
  return { success: true };
});

// v2.11.0: Updates box (Settings) — check the official GitHub
// releases of the owner's repo. Read-only, no credentials involved.
// v2.12.0: the repo is now the dedicated flowstudio-lite repo.
ipcMain.handle('check-for-updates', async () => {
  const https = require('https');
  try {
    const data = await new Promise((resolve, reject) => {
      const req = https.get('https://api.github.com/repos/mohdkhan837218-spec/flowstudio-lite/releases/latest', {
        headers: { 'User-Agent': 'FlowStudioLite', 'Accept': 'application/vnd.github+json' },
        timeout: 12000
      }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (res.statusCode === 404) return resolve(null); // no releases yet
          if (res.statusCode !== 200) return reject(new Error(`GitHub HTTP ${res.statusCode}`));
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      });
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.on('error', reject);
    });
    if (!data || !data.tag_name) return { ok: true, latest: null, url: null };
    return { ok: true, latest: data.tag_name, url: data.html_url || null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// v2.11.0: social/support links from the strip + CREATED BY box.
// v2.12.0: REAL auto-update via electron-updater, fed by the GitHub
// Releases of mohdkhan837218-spec/flowstudio-lite. Flow: the app
// checks on start (when "Check automatically" is on) and from the
// Settings Updates box; a newer release downloads in the
// background; when it is ready the box offers "Restart & Update",
// which installs it (quitAndInstall). In an unpackaged (source) run
// the updater stays silent and the box shows the read-only release
// info from the 'check-for-updates' handler above.
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch (e) { autoUpdater = null; }
const updateState = { state: 'idle' };
function pushUpdateState(patch) {
  Object.assign(updateState, patch);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-status', { ...updateState });
  }
}
function setupAutoUpdater() {
  if (!autoUpdater || !app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on('checking-for-update', () => pushUpdateState({ state: 'checking' }));
  autoUpdater.on('update-available', (info) => pushUpdateState({ state: 'available', version: info && info.version }));
  autoUpdater.on('update-not-available', () => pushUpdateState({ state: 'none' }));
  autoUpdater.on('download-progress', (p) => pushUpdateState({ state: 'downloading', percent: Math.round((p && p.percent) || 0) }));
  autoUpdater.on('update-downloaded', (info) => pushUpdateState({ state: 'downloaded', version: info && info.version }));
  autoUpdater.on('error', (err) => pushUpdateState({ state: 'error', error: err ? String(err.message || err) : 'unknown error' }));
}
ipcMain.handle('update-check', async (event) => {
  assertTrustedRenderer(event);
  if (!autoUpdater || !app.isPackaged) return { supported: false };
  try {
    await autoUpdater.checkForUpdates();
    return { supported: true, started: true };
  } catch (e) {
    pushUpdateState({ state: 'error', error: e.message });
    return { supported: true, started: false, error: e.message };
  }
});
ipcMain.handle('update-install', async (event) => {
  assertTrustedRenderer(event);
  if (autoUpdater && app.isPackaged) {
    setImmediate(() => { try { autoUpdater.quitAndInstall(); } catch (e) {} });
    return { success: true };
  }
  return { success: false };
});

ipcMain.handle('open-external', async (event, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    await shell.openExternal(url);
    return { success: true };
  }
  return { success: false, error: 'Invalid URL' };
});

ipcMain.handle('get-setting', async (event, payload) => {
  assertTrustedRenderer(event);
  await dbService.ensureInit();
  const { key, defaultValue } = payload || {};
  return dbService.getSetting(key, defaultValue);
});

ipcMain.handle('set-setting', async (event, payload) => {
  assertTrustedRenderer(event);
  await dbService.ensureInit();
  const { key, value } = payload || {};
  dbService.setSetting(key, value);
  return { success: true };
});

ipcMain.handle('get-default-download-folder', async (event) => {
  assertTrustedRenderer(event);
  await dbService.ensureInit();
  return getDefaultDownloadFolder();
});

// ---------------- Generation ----------------

// v2.4.0: duplicate-charge guard (read-only). The renderer calls
// this BEFORE starting a run: any pasted prompt that is already
// pending / needs_check / running is reported, so the owner can
// choose Resume instead of paying Flow twice for the same render.
ipcMain.handle('check-prompt-duplicates', async (event, payload) => {
  assertTrustedRenderer(event);
  // v2.5.0 TEST SEAM (tests/uitest.js, run B): force the guard itself
  // to fail so the suite can prove generation proceeds without it —
  // the guard is a salaah, not a gate. Env-gated; never set in
  // normal use.
  if (process.env.FLOW_LITE_UI_TEST_GUARD_FAIL === '1') {
    throw new Error('Duplicate guard forced down (UI test seam)');
  }
  await dbService.ensureInit();
  const items = normalizePromptItems(payload && payload.prompts);
  const openRows = dbService.getOpenTasks();
  const matches = promptMatch.findPendingDuplicates(items, openRows);
  return { success: true, matches };
});

ipcMain.handle('start-generation', async (event, config) => {
  assertTrustedRenderer(event);
  await dbService.ensureInit();

  if (activeWorkerPool) {
    return { success: false, error: 'A generation run is already in progress. Stop it before starting a new one.' };
  }

  const prompts = normalizePromptItems(config && config.prompts);
  if (prompts.length === 0) {
    return { success: false, error: 'No prompts provided.' };
  }

  const settings = {
    type: 'Video',
    videoMode: 'Text',
    model: (config && config.model) || 'Omni Flash',
    duration: (config && config.duration) || '6s',
    aspectRatio: (config && config.aspectRatio) || '9:16',
    // v2.4.0: Outputs is locked to x1 (the select is gone from the
    // UI). Any outputsCount a caller still sends is ignored; older
    // saved settings are read as x1 by the engine as well.
    outputsCount: 1,
    quality: (config && config.quality) || '360p',
    // v2.3.0: default naming is by the prompt's TAG; the old
    // scene001-style naming is the Settings option ('scene').
    namingPattern: currentNamingPattern()
  };

  let downloadFolder = (config && config.downloadFolder) || getDefaultDownloadFolder();
  downloadFolder = path.resolve(String(downloadFolder));
  if (!fs.existsSync(downloadFolder)) {
    // v1.9.0: an unwritable/invalid output path must come back as the
    // app's friendly error shape, not a raw thrown system error.
    try {
      fs.mkdirSync(downloadFolder, { recursive: true });
    } catch (e) {
      return { success: false, error: `Output folder banaya nahi ja saka (${downloadFolder}): ${e.message}` };
    }
  }
  dbService.setSetting('download_folder', downloadFolder);

  // v2.0.0: parallel generation — 1..5 workers, default 3.
  const concurrency = validateNumericSetting(config && config.concurrency, 1, 5, 3);
  dbService.setSetting('concurrency', String(concurrency));

  activeWorkerPool = createPool(concurrency);
  const pool = activeWorkerPool;
  launchPoolRun(pool, (p) => p.runQueue(prompts, settings, downloadFolder), 'Queue');

  return { success: true, totalPrompts: prompts.length };
});

ipcMain.handle('pause-generation', async (event) => {
  assertTrustedRenderer(event);
  if (activeWorkerPool) activeWorkerPool.pause();
  return { success: true };
});

ipcMain.handle('resume-generation', async (event) => {
  assertTrustedRenderer(event);
  if (activeWorkerPool) activeWorkerPool.resume();
  return { success: true };
});

ipcMain.handle('stop-generation', async (event) => {
  assertTrustedRenderer(event);
  if (activeWorkerPool) {
    await activeWorkerPool.stop();
    activeWorkerPool = null;
  }
  return { success: true };
});

// ---------------- History ----------------

ipcMain.handle('get-history', async (event, limit) => {
  assertTrustedRenderer(event);
  await dbService.ensureInit();
  return dbService.getHistory(validateNumericSetting(limit, 1, 1000, 300));
});

ipcMain.handle('retry-task', async (event, taskId) => {
  assertTrustedRenderer(event);
  await dbService.ensureInit();
  if (activeWorkerPool) {
    return { success: false, error: 'A generation run is already in progress. Wait for it to finish, then retry.' };
  }
  const task = dbService.getTask(String(taskId || ''));
  if (!task) return { success: false, error: 'Task not found.' };

  let settings = {};
  try { settings = JSON.parse(task.settings_json || '{}'); } catch (e) { settings = {}; }
  if (!settings.model) settings.model = task.model || 'Omni Flash';
  if (!settings.duration) settings.duration = task.duration || '6s';
  if (!settings.aspectRatio) settings.aspectRatio = task.aspect_ratio || '9:16';
  if (!settings.type) settings.type = 'Video';
  if (!settings.namingPattern) settings.namingPattern = currentNamingPattern();

  const downloadFolder = getDefaultDownloadFolder();
  if (!fs.existsSync(downloadFolder)) {
    try {
      fs.mkdirSync(downloadFolder, { recursive: true });
    } catch (e) {
      return { success: false, error: `Output folder banaya nahi ja saka (${downloadFolder}): ${e.message}` };
    }
  }

  const concurrency = validateNumericSetting(dbService.getSetting('concurrency', '3'), 1, 5, 3);
  activeWorkerPool = createPool(concurrency);
  const pool = activeWorkerPool;
  // v2.3.0: a retried task keeps its ORIGINAL tag + position, so its
  // video lands under the same tag name it should have had.
  launchPoolRun(pool, (p) => p.runQueue(
    [{ text: task.prompt_text, tag: task.prompt_tag || '', index: task.prompt_index }],
    settings,
    downloadFolder
  ), 'Retry');

  return { success: true };
});

// ---------------- v2.3.0: sequence integrity ----------------

/** Rows + report for the most recent run (report is recomputed from
 *  the DB and the DISK every time — never from cached task states). */
function lastRunReport() {
  if (!lastRunInfo || !Array.isArray(lastRunInfo.taskIds) || lastRunInfo.taskIds.length === 0) {
    return { rows: [], report: null };
  }
  const rows = lastRunInfo.taskIds.map(id => dbService.getTask(id)).filter(Boolean);
  if (rows.length === 0) return { rows, report: null };
  const report = buildSequenceReport(rows, {
    exists: (p) => { try { return fs.existsSync(p); } catch (e) { return false; } },
    namingMode: currentNamingPattern()
  });
  return { rows, report };
}

ipcMain.handle('get-sequence-report', async (event) => {
  assertTrustedRenderer(event);
  await dbService.ensureInit();
  const { report } = lastRunReport();
  return { success: true, report };
});

/**
 * [Sirf Missing Dobara Banao] — re-queues ONLY the sequence report's
 * missing tasks, with their original tags and positions. Which tasks
 * are missing is RECOMPUTED here from the DB + disk (the renderer's
 * list is never trusted), finished videos are never touched, and
 * credits are spent only on the missing prompts.
 */
ipcMain.handle('retry-missing-tasks', async (event, payload) => {
  assertTrustedRenderer(event);
  await dbService.ensureInit();
  if (activeWorkerPool) {
    return { success: false, error: 'A generation run is already in progress. Wait for it to finish, then retry.' };
  }
  const wanted = new Set((payload && Array.isArray(payload.taskIds)) ? payload.taskIds.map(v => String(v || '')).filter(Boolean) : []);
  if (wanted.size === 0) return { success: false, error: 'Missing tasks ki list khaali hai.' };

  const { rows, report } = lastRunReport();
  if (!report) return { success: false, error: 'Is session me abhi koi run nahi hua — pehle Generate chalao.' };
  // Intersect the renderer's ask with the RECOMPUTED report, by task
  // id — and rebuild each item from its DB row (asal tag + number).
  const byId = new Map(rows.map(r => [String(r.id), r]));
  const queueItems = report.missing
    .filter(m => wanted.has(String(m.taskId)))
    .map(m => {
      const row = byId.get(String(m.taskId));
      return row ? { text: row.prompt_text, tag: row.prompt_tag || '', index: row.prompt_index } : null;
    })
    .filter(i => i && i.text);
  if (queueItems.length === 0) {
    return { success: false, error: 'Dobara banane ke liye koi missing task nahi bacha (shayad sab ban gaye hain).' };
  }

  let settings = {};
  const firstRow = byId.get(String(report.missing[0].taskId)) || rows[0];
  try { settings = JSON.parse((firstRow && firstRow.settings_json) || '{}'); } catch (e) { settings = {}; }
  if (!settings.model) settings.model = (firstRow && firstRow.model) || 'Omni Flash';
  if (!settings.duration) settings.duration = (firstRow && firstRow.duration) || '6s';
  if (!settings.aspectRatio) settings.aspectRatio = (firstRow && firstRow.aspect_ratio) || '9:16';
  if (!settings.type) settings.type = 'Video';
  if (!settings.namingPattern) settings.namingPattern = currentNamingPattern();

  const downloadFolder = getDefaultDownloadFolder();
  if (!fs.existsSync(downloadFolder)) {
    try {
      fs.mkdirSync(downloadFolder, { recursive: true });
    } catch (e) {
      return { success: false, error: `Output folder banaya nahi ja saka (${downloadFolder}): ${e.message}` };
    }
  }

  const concurrency = validateNumericSetting(dbService.getSetting('concurrency', '3'), 1, 5, 3);
  activeWorkerPool = createPool(concurrency);
  const pool = activeWorkerPool;
  launchPoolRun(pool, (p) => p.runQueue(queueItems, settings, downloadFolder), 'RetryMissing');
  recordActivity({
    category: 'generation', level: 'info',
    stage: 'sequence',
    detail: `Sequence report ke ${queueItems.length} missing video dobara queue me gaye — sirf yahi prompts banege, unke asal tags ke saath (${queueItems.map(i => i.tag || `scene${String((i.index || 0) + 1).padStart(3, '0')}`).join(', ')}). Jo videos pehle se ban chuke hain unhe haath nahi laga; credits sirf inhi missing par lagenge.`,
    message: `Sirf Missing Dobara Banao: ${queueItems.length} missing prompt(s) dobara chal rahe hain`
  });
  return { success: true, totalPrompts: queueItems.length };
});

/**
 * Sequence report's one-click rename: a completed task's file sits
 * under the WRONG name — rename it (file + DB record) to its tag's
 * canonical name. Guards: the task must be completed with a tag, the
 * source must pass the media-roots check, and the target name must
 * be FREE — an existing file is never overwritten.
 */
ipcMain.handle('rename-task-file', async (event, payload) => {
  assertTrustedRenderer(event);
  await dbService.ensureInit();
  const taskId = String((payload && payload.taskId) || '');
  const task = dbService.getTask(taskId);
  if (!task) return { success: false, error: 'Task nahi mila.' };
  if (task.status !== 'completed' || !task.file_path) {
    return { success: false, error: 'Sirf complete hue task ki file ka naam badla ja sakta hai.' };
  }
  const tag = (task.prompt_tag || '').trim();
  const canonical = tag ? fileNameForTag(tag, path.extname(task.file_path).replace(/^\./, '') || 'mp4') : null;
  if (!canonical) return { success: false, error: 'Is task par koi tag nahi hai — tag-naam nahi ban sakta.' };
  if (path.basename(task.file_path) === canonical) {
    return { success: false, error: 'File pehle se hi sahi tag-naam par hai.' };
  }
  const mediaRoots = [getDefaultDownloadFolder(), path.join(os.homedir(), 'Downloads'), dbService.getDataDir()];
  let source;
  try {
    source = assertAllowedMediaFile(task.file_path, mediaRoots);
  } catch (e) {
    return { success: false, error: e.message };
  }
  if (!fs.existsSync(source)) return { success: false, error: 'File disk par nahi mili — pehle History/Report refresh karo.' };
  const target = path.join(path.dirname(source), canonical);
  if (fs.existsSync(target)) {
    return { success: false, error: `"${canonical}" naam ki file pehle se maujood hai — use overwrite nahi kiya jayega. Pehle usey kahin aur move karo.` };
  }
  try {
    try {
      fs.renameSync(source, target);
    } catch (renErr) {
      fs.copyFileSync(source, target);
      fs.unlinkSync(source);
    }
  } catch (e) {
    return { success: false, error: `Rename nahi ho paya: ${e.message}` };
  }
  dbService.updateTaskFile(taskId, target, canonical);
  try { dbService.persistNow(); } catch (e) {}
  recordActivity({
    category: 'system', level: 'info',
    stage: 'sequence',
    taskId,
    detail: `Ek video galat naam se save ho gaya tha ("${path.basename(source)}") — sequence report se use uske tag ke sahi naam "${canonical}" par rename kar diya gaya hai (file bhi, app ka record bhi). Koi file overwrite nahi hui.`,
    message: `Galat naam theek hua: ${path.basename(source)} → ${canonical} (Tag ${tag})`
  });
  return { success: true, fileName: canonical, filePath: target };
});

ipcMain.handle('clear-history', async (event) => {
  assertTrustedRenderer(event);
  await dbService.ensureInit();
  dbService.clearHistory();
  return { success: true };
});

/**
 * v2.2.0: History table bulk bar — delete the SELECTED rows AND their
 * video files. The renderer only calls this AFTER its in-app confirm
 * modal; the main side re-guards everything anyway: ids are validated,
 * only finished rows (completed/failed/cancelled) can go, and every
 * file path must pass the media-roots check before it is unlinked
 * (a path outside the allowed roots is NEVER deleted — its record
 * still is, and the refusal is reported back).
 */
ipcMain.handle('delete-history-tasks', async (event, payload) => {
  assertTrustedRenderer(event);
  await dbService.ensureInit();
  const ids = (payload && Array.isArray(payload.ids)) ? payload.ids.map(v => String(v || '')).filter(Boolean).slice(0, 500) : [];
  const deleteFiles = !!(payload && payload.deleteFiles);
  if (ids.length === 0) return { success: false, error: 'Kuch select nahi hua — pehle table me videos select karo.' };

  const mediaRoots = [getDefaultDownloadFolder(), path.join(os.homedir(), 'Downloads'), dbService.getDataDir ? dbService.getDataDir() : path.join(__dirname, 'data')];
  const skippedFiles = [];
  let filesDeleted = 0;
  if (deleteFiles) {
    for (const id of ids) {
      const task = dbService.getTask(id);
      if (!task || !task.file_path) continue;
      let resolved = null;
      try { resolved = assertAllowedMediaFile(task.file_path, mediaRoots); } catch (e) { resolved = null; }
      if (!resolved) { skippedFiles.push(task.file_name || task.file_path); continue; }
      try {
        if (fs.existsSync(resolved)) { fs.unlinkSync(resolved); filesDeleted++; }
      } catch (e) { skippedFiles.push(task.file_name || task.file_path); }
    }
  }
  const deleted = dbService.deleteHistoryTasks(ids);
  try { dbService.persistNow(); } catch (e) {}
  recordActivity({
    category: 'system', level: 'warn',
    stage: 'history',
    detail: deleteFiles
      ? `History table se ${deleted} record delete hue aur unki ${filesDeleted} video file(s) bhi disk se delete kar di gayin.${skippedFiles.length ? ` ${skippedFiles.length} file(s) allowed folder ke bahar thi ya delete nahi ho payi: ${skippedFiles.slice(0, 5).join(', ')}` : ''}`
      : `History table se ${deleted} record delete hue (files disk par hi hain).`,
    message: `History: ${deleted} selected record delete hue${deleteFiles ? ` · ${filesDeleted} file(s) bhi delete` : ''}`
  });
  return { success: true, deleted, filesDeleted, skippedFiles };
});

// ---------------- v1.8.0: queue resume + usage stats ----------------

ipcMain.handle('get-resumable-tasks', async (event) => {
  assertTrustedRenderer(event);
  await dbService.ensureInit();
  const tasks = dbService.getResumableTasks();
  return {
    total: tasks.length,
    needsCheck: tasks.filter(t => t.needs_check).length,
    tasks: tasks.map(t => ({ id: t.id, promptIndex: t.prompt_index, promptText: t.prompt_text, tag: t.prompt_tag || '', needsCheck: !!t.needs_check }))
  };
});

ipcMain.handle('resume-tasks', async (event) => {
  assertTrustedRenderer(event);
  await dbService.ensureInit();
  if (activeWorkerPool) {
    return { success: false, error: 'A generation run is already in progress. Stop it before resuming the queue.' };
  }
  const rows = dbService.getResumableTasks();
  if (rows.length === 0) {
    return { success: false, error: 'No pending prompts to resume.' };
  }

  const downloadFolder = getDefaultDownloadFolder();
  if (!fs.existsSync(downloadFolder)) {
    try {
      fs.mkdirSync(downloadFolder, { recursive: true });
    } catch (e) {
      return { success: false, error: `Output folder banaya nahi ja saka (${downloadFolder}): ${e.message}` };
    }
  }
  const concurrency = validateNumericSetting(dbService.getSetting('concurrency', '3'), 1, 5, 3);

  activeWorkerPool = createPool(concurrency);
  const pool = activeWorkerPool;
  launchPoolRun(pool, (p) => p.runQueue(null, null, downloadFolder, { existingTasks: rows }), 'Resume');

  return { success: true, totalPrompts: rows.length };
});

ipcMain.handle('get-usage-stats', async (event) => {
  assertTrustedRenderer(event);
  await dbService.ensureInit();
  return usageStats.getStats(dbService);
});

// ---------------- v2.0.0: activity, credits dashboard, preview, bulk ----------------

ipcMain.handle('get-activity', async (event, payload) => {
  assertTrustedRenderer(event);
  await dbService.ensureInit();
  const category = (payload && typeof payload.category === 'string') ? payload.category : 'all';
  const limit = validateNumericSetting(payload && payload.limit, 1, 500, 200);
  return getActivityStore().list({ category, limit });
});

ipcMain.handle('clear-activity', async (event) => {
  assertTrustedRenderer(event);
  await dbService.ensureInit();
  getActivityStore().clear();
  return { success: true };
});

ipcMain.handle('get-credit-dashboard', async (event) => {
  assertTrustedRenderer(event);
  await dbService.ensureInit();
  return creditWatch.getDashboard();
});

/**
 * In-app video preview: the task's local file opens in a small dedicated
 * window with a <video> player — no browser, no file manager. The path
 * comes from the DB row (never from the renderer) and must sit inside
 * the known media roots with an allowed extension.
 */
ipcMain.handle('preview-video', async (event, taskId) => {
  assertTrustedRenderer(event);
  await dbService.ensureInit();
  const task = dbService.getTask(String(taskId || ''));
  if (!task || !task.file_path) {
    return { success: false, error: 'Is task par koi video file nahi mili.' };
  }
  let resolved;
  try {
    resolved = assertAllowedMediaFile(task.file_path, [
      getDefaultDownloadFolder(),
      path.join(os.homedir(), 'Downloads'),
      dbService.getDataDir()
    ]);
  } catch (e) {
    return { success: false, error: e.message };
  }
  if (!fs.existsSync(resolved)) {
    return { success: false, error: 'Video file disk par nahi mili — shayad delete ya move ho gayi hai.' };
  }
  try {
    if (previewWindow && !previewWindow.isDestroyed()) previewWindow.close();
    previewWindow = new BrowserWindow({
      width: 450,
      height: 810,
      title: `Preview — ${path.basename(resolved)}`,
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false
      }
    });
    await previewWindow.loadFile(path.join(__dirname, 'renderer', 'preview.html'), {
      query: {
        src: pathToFileURL(resolved).toString(),
        autoplay: dbService.getSetting('preview_autoplay', '1') === '1' ? '1' : '0',
        title: path.basename(resolved),
        theme: dbService.getSetting('appearance', 'dark')
      }
    });
    previewWindow.on('closed', () => { previewWindow = null; });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Bulk prompts: read a .txt file (one prompt per line) into the editor.
ipcMain.handle('import-prompts-file', async (event) => {
  assertTrustedRenderer(event);
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select a prompts .txt file (one prompt per line)',
    properties: ['openFile'],
    filters: [
      { name: 'Text files', extensions: ['txt'] },
      { name: 'All files', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return { success: false, canceled: true };
  }
  try {
    const text = fs.readFileSync(result.filePaths[0], 'utf8');
    return { success: true, text, fileName: path.basename(result.filePaths[0]) };
  } catch (e) {
    return { success: false, error: `File padhi nahi ja saki: ${e.message}` };
  }
});

// Settings: pick a custom Chrome executable.
ipcMain.handle('select-chrome-path', async (event) => {
  assertTrustedRenderer(event);
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select chrome.exe',
    properties: ['openFile'],
    filters: [
      { name: 'Executables', extensions: ['exe'] },
      { name: 'All files', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return { success: false, canceled: true };
  }
  return { success: true, path: result.filePaths[0] };
});
