'use strict';

/**
 * FlowStudio Lite — plain-Node smoke tests (no Electron required).
 *
 * Covers the audit-mandated behaviors:
 *  1. Credit service rules (fix #2/#3/#4): no zeroing except explicit live
 *     0 / exhaustion banner; LowCredits keeps the real balance; ambiguous
 *     checks leave status and balance untouched; sign-out keeps balance.
 *  2. Queue rotation (workerPool's TaskQueue): an account that reports
 *     EXHAUSTED before firing re-queues its task at the front for the next
 *     account, and a task can be claimed for submission exactly once.
 *  3. Task-state recovery (fix #1; v1.8.0 semantics): a task left
 *     'running' by a crashed session returns to 'pending' flagged
 *     needs_check on the next boot (ZDola-style check-only recovery),
 *     tested against the REAL sql.js database across two child processes.
 *  5. v1.8.0 ZDola-logic: two-strike sign-out (Unconfirmed -> Need Login
 *     only on the second explicit sign-out), timed escalating cooldown
 *     rest, the verify-all classification pass (unknown retried once,
 *     sign-out confirmed twice), and counts-only usage stats.
 *  4. FFmpeg getVideoDimensions (fix): probe failure resolves null, never
 *     a fabricated 1080x1920.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${err.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n[1] Credit service rules (in-memory store)');

const { createCreditService } = require(path.join(ROOT, 'engine', 'creditService'));

function makeStore(initial) {
  const rows = new Map();
  for (const acc of initial) rows.set(acc.id, { ...acc });
  const writes = [];
  return {
    rows,
    writes,
    getAccount(id) {
      const r = rows.get(id);
      return r ? { ...r } : null;
    },
    updateAccountFields(id, fields) {
      writes.push({ id, fields: { ...fields } });
      const r = rows.get(id);
      Object.assign(r, fields);
      return { ...r };
    }
  };
}

test('live balance read updates credits + Ready', () => {
  const store = makeStore([{ id: 'acc_1', credits: null, status: 'Need Login' }]);
  const cs = createCreditService(store);
  const res = cs.applyLiveBalance('acc_1', 750);
  assert.strictEqual(res.outcome, 'ok');
  assert.strictEqual(store.rows.get('acc_1').credits, 750);
  assert.strictEqual(store.rows.get('acc_1').status, 'Ready');
});

test('explicit live read of 0 -> Exhausted with 0 (allowed zeroing path #1)', () => {
  const store = makeStore([{ id: 'acc_1', credits: 300, status: 'Ready' }]);
  const cs = createCreditService(store);
  const res = cs.applyLiveBalance('acc_1', 0);
  assert.strictEqual(res.outcome, 'exhausted');
  assert.strictEqual(store.rows.get('acc_1').credits, 0);
  assert.strictEqual(store.rows.get('acc_1').status, 'Exhausted');
});

test('exhaustion banner -> Exhausted with 0 (allowed zeroing path #2)', () => {
  const store = makeStore([{ id: 'acc_1', credits: 120, status: 'Ready' }]);
  const cs = createCreditService(store);
  cs.applyExhaustionBanner('acc_1');
  assert.strictEqual(store.rows.get('acc_1').credits, 0);
  assert.strictEqual(store.rows.get('acc_1').status, 'Exhausted');
});

test('LowCredits keeps the REAL balance intact (fix #2)', () => {
  const store = makeStore([{ id: 'acc_1', credits: 15, status: 'Ready' }]);
  const cs = createCreditService(store);
  const res = cs.applyLowCredits('acc_1', 20);
  assert.strictEqual(res.outcome, 'low-credits');
  assert.strictEqual(store.rows.get('acc_1').status, 'LowCredits');
  assert.strictEqual(store.rows.get('acc_1').credits, 15, 'balance must not be zeroed or changed');
});

test('estimated charge NEVER zeroes a balance (fix #2)', () => {
  const store = makeStore([{ id: 'acc_1', credits: 20, status: 'Ready' }]);
  const cs = createCreditService(store);
  const res = cs.applyEstimatedCharge('acc_1', 20);
  assert.strictEqual(res.outcome, 'needs-live-check');
  assert.strictEqual(store.rows.get('acc_1').credits, 20, 'estimated charge must not write 0');
  // A partial estimate is fine:
  const res2 = cs.applyEstimatedCharge('acc_1', 5);
  assert.strictEqual(res2.outcome, 'ok');
  assert.strictEqual(store.rows.get('acc_1').credits, 15);
});

test('ambiguous check leaves status AND credits unchanged (fix #3)', () => {
  const store = makeStore([{ id: 'acc_1', credits: 432, status: 'Ready' }]);
  const cs = createCreditService(store);
  const res = cs.applyAmbiguousCheck('acc_1');
  assert.strictEqual(res.outcome, 'unknown');
  assert.strictEqual(store.rows.get('acc_1').credits, 432);
  assert.strictEqual(store.rows.get('acc_1').status, 'Ready');
});

test('explicit sign-out sets Need Login but PRESERVES balance (fix #3)', () => {
  const store = makeStore([{ id: 'acc_1', credits: 999, status: 'Ready' }]);
  const cs = createCreditService(store);
  const res = cs.applyExplicitSignOut('acc_1');
  assert.strictEqual(res.outcome, 'need-login');
  assert.strictEqual(store.rows.get('acc_1').status, 'Need Login');
  assert.strictEqual(store.rows.get('acc_1').credits, 999);
});

test('all credit writes are targeted single-row updates (fix #4)', () => {
  const store = makeStore([
    { id: 'acc_1', credits: 100, status: 'Ready' },
    { id: 'acc_2', credits: 200, status: 'Ready' }
  ]);
  const cs = createCreditService(store);
  cs.applyLiveBalance('acc_1', 90);
  cs.applyLowCredits('acc_2', 500);
  assert.ok(store.writes.every(w => typeof w.id === 'string'), 'every write carries a single account id');
  assert.strictEqual(store.rows.get('acc_2').credits, 200, 'other row untouched in balance');
  assert.strictEqual(store.rows.get('acc_1').credits, 90);
});

// ---------------------------------------------------------------------------
console.log('\n[2] Queue rotation logic (TaskQueue)');

const { TaskQueue } = require(path.join(ROOT, 'engine', 'taskQueue'));

test('exhausted-before-firing -> task re-queued to FRONT for next account', () => {
  const q = new TaskQueue([
    { id: 'task_1', prompt_index: 0, prompt_text: 'one' },
    { id: 'task_2', prompt_index: 1, prompt_text: 'two' },
    { id: 'task_3', prompt_index: 2, prompt_text: 'three' }
  ]);

  // Worker A takes task_1, account runs out before firing.
  const takenByA = q.next();
  assert.strictEqual(takenByA.id, 'task_1');
  assert.strictEqual(q.claimForSubmission('task_1'), true, 'first claim ok');
  // ...submit returns EXHAUSTED pre-fire: pool releases claim + requeues front.
  q.releaseSubmission('task_1');
  assert.strictEqual(q.requeueFront(takenByA), true);

  // Worker B must receive task_1 FIRST (front of queue), not task_2.
  const takenByB = q.next();
  assert.strictEqual(takenByB.id, 'task_1');
  assert.strictEqual(q.size(), 2);
});

test('no duplicate submission: a task id can be claimed exactly once', () => {
  const q = new TaskQueue([{ id: 'task_1', prompt_index: 0, prompt_text: 'one' }]);
  const t = q.next();
  assert.strictEqual(q.claimForSubmission(t.id), true);
  assert.strictEqual(q.claimForSubmission(t.id), false, 'second claim must be refused');
  assert.strictEqual(q.isSubmitted(t.id), true);
});

test('requeueFront is idempotent — never creates duplicate entries', () => {
  const q = new TaskQueue([
    { id: 'task_1', prompt_index: 0, prompt_text: 'one' },
    { id: 'task_2', prompt_index: 1, prompt_text: 'two' }
  ]);
  const t = q.next();
  assert.strictEqual(q.requeueFront(t), true);
  assert.strictEqual(q.requeueFront(t), false, 'duplicate requeue refused');
  assert.strictEqual(q.size(), 2);
  assert.strictEqual(q.enqueue(t), false, 'duplicate enqueue refused');
});

test('FIFO order preserved for the remaining prompts', () => {
  const q = new TaskQueue([
    { id: 'a', prompt_index: 0, prompt_text: 'a' },
    { id: 'b', prompt_index: 1, prompt_text: 'b' },
    { id: 'c', prompt_index: 2, prompt_text: 'c' }
  ]);
  assert.strictEqual(q.next().id, 'a');
  assert.strictEqual(q.next().id, 'b');
  assert.strictEqual(q.next().id, 'c');
  assert.strictEqual(q.next(), null);
});

// ---------------------------------------------------------------------------
console.log('\n[3] Task-state recovery + credit rules on the REAL sql.js DB');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fslite-smoke-'));
const dbModulePath = path.join(ROOT, 'engine', 'db.js');
const creditModulePath = path.join(ROOT, 'engine', 'creditService.js');

const phase1 = `
  (async () => {
    const { dbService } = require(${JSON.stringify(dbModulePath)});
    await dbService.ensureInit();
    dbService.insertAccount({ id: 'acc_smoke', name: 'Smoke', email: 's@example.com', dirName: 'acc_smoke', status: 'Ready', credits: 500 });
    const tasks = dbService.createBatchTasks('batch_smoke', ['prompt one', 'prompt two'], { model: 'Omni Flash', duration: '6s', aspectRatio: '9:16' });
    dbService.updateTaskProgress(tasks[0].id, 'running', 'acc_smoke', 'Smoke');
    dbService.persistNow();
    console.log(JSON.stringify({ taskId: tasks[0].id, otherTaskId: tasks[1].id }));
  })().catch(e => { console.error(e); process.exit(1); });
`;

const phase2 = `
  (async () => {
    const { dbService } = require(${JSON.stringify(dbModulePath)});
    const { createCreditService } = require(${JSON.stringify(creditModulePath)});
    await dbService.ensureInit();
    const out = {};
    out.recovered = dbService.getRecoveredInterruptedCount();
    const tasks = dbService.query("SELECT * FROM queue_tasks WHERE batch_id = 'batch_smoke' ORDER BY prompt_index ASC");
    out.task0 = { status: tasks[0].status, error_reason: tasks[0].error_reason, needs_check: tasks[0].needs_check };
    out.task1 = { status: tasks[1].status, needs_check: tasks[1].needs_check };
    out.resumable = dbService.getResumableTasks().length;

    const cs = createCreditService(dbService);
    cs.applyAmbiguousCheck('acc_smoke');
    let acc = dbService.getAccount('acc_smoke');
    out.afterAmbiguous = { credits: acc.credits, status: acc.status };
    cs.applyLowCredits('acc_smoke', 600);
    acc = dbService.getAccount('acc_smoke');
    out.afterLow = { credits: acc.credits, status: acc.status };
    cs.applyLiveBalance('acc_smoke', 250);
    cs.applyExplicitSignOut('acc_smoke');
    acc = dbService.getAccount('acc_smoke');
    out.afterSignOut = { credits: acc.credits, status: acc.status };
    cs.applyLiveBalance('acc_smoke', 0);
    acc = dbService.getAccount('acc_smoke');
    out.afterLive0 = { credits: acc.credits, status: acc.status };
    dbService.persistNow();
    console.log(JSON.stringify(out));
  })().catch(e => { console.error(e); process.exit(1); });
`;

test('boot recovery (v1.8): running -> pending + needs_check; pending untouched; credit rules hold on real DB', () => {
  const env = { ...process.env, FLOW_LITE_DATA_DIR: tmpDir };
  execFileSync(process.execPath, ['-e', phase1], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const raw = execFileSync(process.execPath, ['-e', phase2], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const out = JSON.parse(raw.trim().split('\n').pop());

  assert.ok(out.recovered >= 1, `expected >=1 recovered task, got ${out.recovered}`);
  // v1.8.0 ZDola-style recovery: an interrupted task is NOT failed
  // outright — it returns to pending flagged needs_check, so Resume can
  // verify it in Flow before any re-run (no lost video, no double charge).
  assert.strictEqual(out.task0.status, 'pending');
  assert.strictEqual(out.task0.needs_check, 1);
  assert.ok(/interrupted/.test(out.task0.error_reason), 'recovery reason must mention interrupted');
  assert.strictEqual(out.task1.status, 'pending', 'pending tasks must not be touched by recovery');
  assert.strictEqual(out.task1.needs_check, 0, 'never-started tasks need no check');
  assert.ok(out.resumable >= 2, 'both tasks must be resumable after boot');
  assert.deepStrictEqual(out.afterAmbiguous, { credits: 500, status: 'Ready' });
  assert.deepStrictEqual(out.afterLow, { credits: 500, status: 'LowCredits' });
  assert.deepStrictEqual(out.afterSignOut, { credits: 250, status: 'Need Login' });
  assert.deepStrictEqual(out.afterLive0, { credits: 0, status: 'Exhausted' });
});

// ---------------------------------------------------------------------------
console.log('\n[5] Prompt BLOCK parsing (v1.1 fix B)');

const { parsePromptBlocks } = require(path.join(ROOT, 'renderer', 'promptParser'));

test('multi-line storyboard paragraphs stay ONE prompt each (blank line separates)', () => {
  const input = [
    '#07-04 A lioness stalks through tall grass,',
    'camera low, dust hanging in the air #00-00',
    'she freezes, ears up, tail still #00-08',
    '',
    '#07-05 The herd bolts across the river,',
    'water exploding around their legs #00-16'
  ].join('\n');
  const blocks = parsePromptBlocks(input);
  assert.strictEqual(blocks.length, 2, `expected 2 prompts, got ${blocks.length}`);
  assert.strictEqual(blocks[0], '#07-04 A lioness stalks through tall grass, camera low, dust hanging in the air #00-00 she freezes, ears up, tail still #00-08');
  assert.ok(blocks[1].startsWith('#07-05 The herd bolts'));
  assert.ok(!blocks.some(b => b.includes('\n')), 'internal newlines must be collapsed');
});

test('CRLF input, whitespace-only separator lines, and 2+ blank lines all split blocks', () => {
  const blocks = parsePromptBlocks('one prompt\r\nstill the same one\r\n\r\n   \r\n\r\nsecond prompt');
  assert.deepStrictEqual(blocks, ['one prompt still the same one', 'second prompt']);
});

test('single block and empty inputs behave', () => {
  assert.deepStrictEqual(parsePromptBlocks('  just one line  '), ['just one line']);
  assert.deepStrictEqual(parsePromptBlocks(''), []);
  assert.deepStrictEqual(parsePromptBlocks('\n\n\n'), []);
  assert.deepStrictEqual(parsePromptBlocks(null), []);
  assert.deepStrictEqual(parsePromptBlocks(undefined), []);
});

// ---------------------------------------------------------------------------
console.log('\n[6] Static guard: no synchronous blocking primitives on the app hot paths');

test('no Atomics.wait / execSync / spawnSync / execFileSync in main.js or engine/', () => {
  const files = [path.join(ROOT, 'main.js')];
  const engineDir = path.join(ROOT, 'engine');
  for (const f of fs.readdirSync(engineDir)) {
    if (f.endsWith('.js')) files.push(path.join(engineDir, f));
  }
  const banned = /Atomics\.wait|execSync|spawnSync|execFileSync/;
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    assert.ok(!banned.test(src), `${path.relative(ROOT, file)} contains a banned blocking primitive`);
  }
});

// ---------------------------------------------------------------------------
console.log('\n[8] Cookie file parser (v1.2 cookie import)');

const { parseCookieText, isGoogleCookieDomain } = require(path.join(ROOT, 'engine', 'cookieParser'));

test('domain filter: google.com subdomains + labs.google only', () => {
  assert.strictEqual(isGoogleCookieDomain('.google.com'), true);
  assert.strictEqual(isGoogleCookieDomain('accounts.google.com'), true);
  assert.strictEqual(isGoogleCookieDomain('flow.google.com'), true);
  assert.strictEqual(isGoogleCookieDomain('labs.google'), true);
  assert.strictEqual(isGoogleCookieDomain('.labs.google'), true);
  assert.strictEqual(isGoogleCookieDomain('evilgoogle.com'), false);
  assert.strictEqual(isGoogleCookieDomain('google.com.evil.com'), false);
  assert.strictEqual(isGoogleCookieDomain('example.com'), false);
  assert.strictEqual(isGoogleCookieDomain(''), false);
});

test('Netscape: comments skipped, #HttpOnly_ kept, non-Google filtered, session cookie has no expires', () => {
  const text = [
    '# Netscape HTTP Cookie File',
    '# This is a comment and must be ignored',
    '.google.com\tTRUE\t/\tTRUE\t1893456000\tSID\tsid-value',
    '#HttpOnly_.google.com\tTRUE\t/\tTRUE\t1893456000\tHSID\thsid-value',
    '.google.com\tTRUE\t/\tFALSE\t0\tSESSIONID\tsession-value',
    'accounts.google.com\tFALSE\t/\tTRUE\t1893456000\tOSID\tosid-value',
    '.example.com\tTRUE\t/\tTRUE\t1893456000\tTRACKER\tmust-be-dropped',
    ''
  ].join('\n');
  const out = parseCookieText(text);
  assert.strictEqual(out.format, 'netscape');
  assert.strictEqual(out.totalParsed, 5, 'comment lines are not cookies');
  assert.strictEqual(out.keptCount, 4, 'the example.com cookie must be filtered out');
  const byName = Object.fromEntries(out.cookies.map(c => [c.name, c]));
  assert.strictEqual(byName.SID.value, 'sid-value');
  assert.strictEqual(byName.SID.expires, 1893456000);
  assert.strictEqual(byName.SID.secure, true);
  assert.strictEqual(byName.HSID.httpOnly, true, '#HttpOnly_ prefix must set httpOnly');
  assert.ok(!('expires' in byName.SESSIONID), 'expires 0 in Netscape means a session cookie — omit expires');
  assert.strictEqual(byName.OSID.domain, 'accounts.google.com');
  assert.ok(!out.cookies.some(c => c.name === 'TRACKER'));
});

test('JSON array (EditThisCookie style): expirationDate floored, session omits expires, sameSite mapped', () => {
  const json = JSON.stringify([
    { domain: '.google.com', name: 'SID', value: 'abc', path: '/', expirationDate: 1893456000.9, secure: true, httpOnly: true, session: false, sameSite: 'no_restriction' },
    { domain: 'flow.google.com', name: 'FLOWSESS', value: 'xyz', path: '/', expirationDate: 1893456000, secure: true, httpOnly: false, session: true, sameSite: 'lax' },
    { domain: '.youtube.com', name: 'VISITOR', value: 'drop-me', path: '/', expirationDate: 1893456000, secure: false, httpOnly: false, session: false }
  ]);
  const out = parseCookieText(json);
  assert.strictEqual(out.format, 'json');
  assert.strictEqual(out.keptCount, 2, 'youtube cookie must be filtered out');
  const sid = out.cookies.find(c => c.name === 'SID');
  assert.strictEqual(sid.expires, 1893456000, 'expirationDate must be floored to epoch seconds');
  assert.strictEqual(sid.sameSite, 'None', "'no_restriction' must map to 'None'");
  const sess = out.cookies.find(c => c.name === 'FLOWSESS');
  assert.ok(!('expires' in sess), 'session:true must omit expires even if present');
  assert.strictEqual(sess.sameSite, 'Lax');
});

test('JSON object with a "cookies" array parses the same way', () => {
  const json = JSON.stringify({
    cookies: [
      { domain: 'labs.google', name: 'LABS', value: 'v1', path: '/', expirationDate: 1893456000, secure: true, httpOnly: true, session: false }
    ]
  });
  const out = parseCookieText(json);
  assert.strictEqual(out.format, 'json');
  assert.strictEqual(out.keptCount, 1);
  assert.strictEqual(out.cookies[0].name, 'LABS');
  assert.strictEqual(out.cookies[0].path, '/');
});

test('garbage input fails cleanly with an Error (no crash, no partial result)', () => {
  assert.throws(() => parseCookieText('hello world, this is not a cookie file'), /No cookies could be read/);
  assert.throws(() => parseCookieText(''), /empty/);
  assert.throws(() => parseCookieText('   \n\t\n'), /empty/);
  assert.throws(() => parseCookieText('{not valid json'), /could not be parsed/);
  assert.throws(() => parseCookieText('{"something": true}'), /Unrecognized cookie file/);
  assert.throws(() => parseCookieText(null), /empty/);
});

test('a file with cookies but NO Google cookies is rejected with a clear reason', () => {
  const json = JSON.stringify([
    { domain: '.example.com', name: 'A', value: '1', path: '/', expirationDate: 1893456000, secure: false, httpOnly: false, session: false }
  ]);
  assert.throws(() => parseCookieText(json), /No Google cookies found/);
});

// ---------------------------------------------------------------------------
console.log('\n[9] v1.3: background-mode pref writer + orphan matcher');

const { ensureBackgroundModeOff } = require(path.join(ROOT, 'engine', 'profilePrefs'));

test('background-mode pref: merges without clobbering other keys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fslite-prefs-'));
  const defDir = path.join(dir, 'Default');
  fs.mkdirSync(defDir, { recursive: true });
  const prefPath = path.join(defDir, 'Preferences');
  fs.writeFileSync(prefPath, JSON.stringify({
    profile: { name: 'Person 1' },
    background: { enabled: true, other_key: 'keep-me' },
    account_info: [{ email: 'x@example.com' }]
  }));
  const res = ensureBackgroundModeOff(dir);
  assert.strictEqual(res.applied, true);
  const after = JSON.parse(fs.readFileSync(prefPath, 'utf8'));
  assert.strictEqual(after.background.enabled, false, 'background mode must be turned off');
  assert.strictEqual(after.background.other_key, 'keep-me', 'sibling background keys preserved');
  assert.strictEqual(after.profile.name, 'Person 1', 'unrelated keys preserved');
  assert.strictEqual(after.account_info[0].email, 'x@example.com', 'account identity preserved');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
});

test('background-mode pref: idempotent — second run writes nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fslite-prefs-'));
  const prefPath = path.join(dir, 'Default', 'Preferences');
  fs.mkdirSync(path.dirname(prefPath), { recursive: true });
  fs.writeFileSync(prefPath, JSON.stringify({ background: { enabled: false }, custom: 1 }));
  const before = fs.readFileSync(prefPath, 'utf8');
  const res = ensureBackgroundModeOff(dir);
  assert.strictEqual(res.applied, false);
  assert.strictEqual(res.alreadySet, true);
  assert.strictEqual(fs.readFileSync(prefPath, 'utf8'), before, 'file content must be untouched');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
});

test('background-mode pref: missing Preferences created minimal; corrupt JSON left untouched', () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'fslite-prefs-'));
  const resA = ensureBackgroundModeOff(dirA);
  assert.strictEqual(resA.applied, true);
  const created = JSON.parse(fs.readFileSync(path.join(dirA, 'Default', 'Preferences'), 'utf8'));
  assert.strictEqual(created.background.enabled, false);

  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'fslite-prefs-'));
  const prefPathB = path.join(dirB, 'Default', 'Preferences');
  fs.mkdirSync(path.dirname(prefPathB), { recursive: true });
  fs.writeFileSync(prefPathB, 'not json {{');
  const resB = ensureBackgroundModeOff(dirB);
  assert.strictEqual(resB.applied, false);
  assert.strictEqual(resB.reason, 'corrupt-preferences');
  assert.strictEqual(fs.readFileSync(prefPathB, 'utf8'), 'not json {{', 'corrupt file must not be clobbered');
  try { fs.rmSync(dirA, { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(dirB, { recursive: true, force: true }); } catch (e) {}
});

test('orphan matcher: only automation-marked Chrome for THIS profile matches', () => {
  const { findOrphanAutomationProcesses } = require(path.join(ROOT, 'engine', 'processHelper'));
  const prof = path.join(os.tmpdir(), 'profiles', 'acc_TEST');
  const processes = [
    // The app's own orphaned headless check Chrome for THIS profile -> match.
    { pid: 101, commandLine: `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir="${prof}" --remote-debugging-pipe --headless=new --no-first-run` },
    // Interactive Chrome for the SAME profile (the Sign In window) -> NO match.
    { pid: 102, commandLine: `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir="${prof}" --no-first-run https://flow.google.com/` },
    // Automation Chrome for ANOTHER profile whose path starts with this
    // profile's path (prefix trap) -> NO match.
    { pid: 103, commandLine: `chrome.exe --user-data-dir="${prof}_OTHER" --remote-debugging-pipe --headless=new` },
    // Automation Chrome for an unrelated profile -> NO match.
    { pid: 104, commandLine: 'chrome.exe --user-data-dir="C:\\somewhere\\else" --headless=new' },
    // No command line at all -> NO match.
    { pid: 105, commandLine: null }
  ];
  const orphans = findOrphanAutomationProcesses(prof, processes);
  assert.deepStrictEqual(orphans.map(p => p.pid), [101], 'only the app orphan for this profile may match');
});

// ---------------------------------------------------------------------------
console.log('\n[4] FFmpeg getVideoDimensions fix');

(async () => {
  await testAsync('probe failure resolves null (never fabricated 1080x1920)', async () => {
    const { FFmpegService } = require(path.join(ROOT, 'engine', 'ffmpegService'));
    const dims = await FFmpegService.getVideoDimensions(path.join(tmpDir, 'does-not-exist.mp4'));
    assert.strictEqual(dims, null);
  });

  // -------------------------------------------------------------------------
  console.log('\n[7] Worker pool: persistent Chrome launch failure is BOUNDED (v1.1 freeze fix)');

  await testAsync('PROFILE_BUSY on every launch -> bounded attempts, tasks failed visibly, Error status', async () => {
    const poolTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fslite-pool-'));
    // Must be set before engine/db is first required in THIS process.
    process.env.FLOW_LITE_DATA_DIR = poolTmpDir;

    const { dbService } = require(path.join(ROOT, 'engine', 'db.js'));
    await dbService.ensureInit();
    dbService.insertAccount({ id: 'acc_pool', name: 'Pool', email: 'p@example.com', dirName: 'acc_pool', status: 'Ready', credits: 500 });

    const { FlowAutomationEngine } = require(path.join(ROOT, 'engine', 'flowAutomation'));
    let launchCalls = 0;
    FlowAutomationEngine.prototype.launchBrowserForAccount = async function () {
      launchCalls++;
      this.lastLaunchError = 'PROFILE_BUSY';
      return false;
    };

    const { WorkerPool } = require(path.join(ROOT, 'engine', 'workerPool'));
    const progressEvents = [];
    const taskEvents = [];
    const pool = new WorkerPool({
      concurrency: 1,
      maxLaunchAttempts: 2,
      launchBackoffMs: 5,
      onProgress: (d) => progressEvents.push(d),
      onTaskUpdate: (d) => taskEvents.push(d),
      onLog: () => {}
    });

    const hangGuard = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('runQueue did not finish within 20s — unbounded retry loop?')), 20000));
    await Promise.race([
      pool.runQueue(['prompt one', 'prompt two'],
        { model: 'Omni Flash', duration: '6s', aspectRatio: '9:16', type: 'Video', outputsCount: 1 },
        poolTmpDir),
      hangGuard
    ]);

    assert.ok(launchCalls >= 1 && launchCalls <= 2, `launch attempts must be bounded at 2, got ${launchCalls}`);
    const failedEvents = taskEvents.filter(e => e.status === 'failed');
    assert.strictEqual(failedEvents.length, 2, 'both prompts must be failed visibly');
    assert.ok(failedEvents.every(e => /busy/i.test(e.reason || '')), 'failure reason must name the busy-profile cause');
    assert.ok(progressEvents.some(e => typeof e.status === 'string' && e.status.startsWith('Error:')),
      'run must surface an Error: status to the renderer');
    const rows = dbService.query('SELECT status FROM queue_tasks ORDER BY prompt_index ASC');
    assert.strictEqual(rows.length, 2);
    assert.ok(rows.every(r => r.status === 'failed'), 'DB tasks must be failed, not stranded pending');

    try { fs.rmSync(poolTmpDir, { recursive: true, force: true }); } catch (e) {}
  });

  // -------------------------------------------------------------------------
  console.log('\n[8] Profile busy detection (v1.2.1): stale lock self-heals, un-removable lock stays busy');

  await testAsync('stale lock file, no holder process -> NOT busy after cleanup (self-heal)', async () => {
    const { checkProfileBusyAsync } = require(path.join(ROOT, 'engine', 'processHelper'));
    const profDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fslite-prof-'));
    const lockPath = path.join(profDir, 'lockfile');
    fs.writeFileSync(lockPath, 'stale');
    const res = await checkProfileBusyAsync(profDir);
    assert.strictEqual(res.busy, false, 'a removable stale lock must not report busy');
    assert.strictEqual(res.healed, true, 'the stale lock removal should be reported as a heal');
    assert.strictEqual(fs.existsSync(lockPath), false, 'the stale lock file should have been removed');
    try { fs.rmSync(profDir, { recursive: true, force: true }); } catch (e) {}
  });

  await testAsync('working copy: locks + caches excluded, session files included', async () => {
    const { buildProfileWorkingCopy, removeProfileWorkingCopy } = require(path.join(ROOT, 'engine', 'profileCopy'));
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'fslite-copy-src-'));
    const dest = path.join(os.tmpdir(), `fslite-copy-dest-${Date.now()}`);
    const w = (rel, content) => {
      const p = path.join(src, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    };
    w(path.join('Local State'), '{"os_crypt":{}}');
    w(path.join('Default', 'Preferences'), '{}');
    w(path.join('Default', 'Network', 'Cookies'), 'cookie-db');
    w('SingletonLock', 'lock');
    w(path.join('Default', 'lockfile'), 'lock');
    w(path.join('Default', 'Cache', 'junk.bin'), 'junk');
    w(path.join('Default', 'Code Cache', 'junk2'), 'junk');
    w(path.join('Default', 'GPUCache', 'junk3'), 'junk');
    w(path.join('Default', 'Service Worker', 'sw'), 'junk');
    w(path.join('Default', 'blob_storage', 'blob'), 'junk');

    await buildProfileWorkingCopy(src, dest);

    assert.ok(fs.existsSync(path.join(dest, 'Default', 'Network', 'Cookies')), 'Cookies must be copied');
    assert.ok(fs.existsSync(path.join(dest, 'Default', 'Preferences')), 'Preferences must be copied');
    assert.ok(fs.existsSync(path.join(dest, 'Local State')), 'Local State must be copied (cookie decryption key)');
    assert.ok(!fs.existsSync(path.join(dest, 'SingletonLock')), 'SingletonLock must be excluded');
    assert.ok(!fs.existsSync(path.join(dest, 'Default', 'lockfile')), 'lockfile must be excluded');
    assert.ok(!fs.existsSync(path.join(dest, 'Default', 'Cache')), 'Cache must be excluded');
    assert.ok(!fs.existsSync(path.join(dest, 'Default', 'Code Cache')), 'Code Cache must be excluded');
    assert.ok(!fs.existsSync(path.join(dest, 'Default', 'GPUCache')), 'GPUCache must be excluded');
    assert.ok(!fs.existsSync(path.join(dest, 'Default', 'Service Worker')), 'Service Worker must be excluded');
    assert.ok(!fs.existsSync(path.join(dest, 'Default', 'blob_storage')), 'blob_storage must be excluded');

    await removeProfileWorkingCopy(dest);
    assert.ok(!fs.existsSync(dest), 'working copy must be removed afterwards');
    try { fs.rmSync(src, { recursive: true, force: true }); } catch (e) {}
  });

  await testAsync('lock that cannot be removed -> busy (lock-heuristic fallback)', async () => {
    const { checkProfileBusyAsync } = require(path.join(ROOT, 'engine', 'processHelper'));
    const profDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fslite-prof-'));
    // A DIRECTORY named like a lock file cannot be removed by unlink, so it
    // survives cleanup. In this (Linux) test env the win32 process
    // cross-check is unavailable by design, so the lock heuristic governs
    // and the profile must report busy. (On Windows a surviving lock with
    // no holding chrome.exe process is cleared by the process check.)
    fs.mkdirSync(path.join(profDir, 'lockfile'));
    const res = await checkProfileBusyAsync(profDir);
    assert.strictEqual(res.busy, true, 'an un-removable lock must report busy when no process check can clear it');
    assert.strictEqual(res.confirmedBy, 'lock-heuristic');
    try { fs.rmSync(profDir, { recursive: true, force: true }); } catch (e) {}
  });

  // -------------------------------------------------------------------------
  console.log('\n[10] v1.4 ownership rule: partitionHolders + live registry + app-path boundary');

  test('partitionHolders: unregistered app-profile holder is reclaimable, registered is live, others ignored', () => {
    const { partitionHolders } = require(path.join(ROOT, 'engine', 'processHelper'));
    const prof = 'C:\\app\\profiles\\acc_1';
    const processes = [
      // The owner's actual blocker: the app's own Sign In Chrome in
      // background mode — NO automation markers, still reclaimable in v1.4.
      { pid: 201, commandLine: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir=C:\\app\\profiles\\acc_1 --no-first-run https://flow.google.com/' },
      // A registered live launch (a check/generation running right now).
      { pid: 202, commandLine: '"chrome.exe" --user-data-dir="C:\\app\\profiles\\acc_1" --headless=new --remote-debugging-pipe' },
      // Automation Chrome for a DIFFERENT account — not this profile.
      { pid: 203, commandLine: '"chrome.exe" --user-data-dir=C:\\app\\profiles\\acc_2 --headless=new' },
      // Prefix trap: acc_12 must never match profile acc_1.
      { pid: 204, commandLine: '"chrome.exe" --user-data-dir=C:\\app\\profiles\\acc_12 --headless=new' },
      // The user's personal Chrome (standard User Data dir) — never ours.
      { pid: 205, commandLine: '"chrome.exe" --user-data-dir=C:\\Users\\mohda\\AppData\\Local\\Google\\Chrome\\User Data' },
      { pid: 206, commandLine: null }
    ];
    const parts = partitionHolders(prof, processes, new Set([202]));
    assert.deepStrictEqual(parts.live.map(p => p.pid), [202], 'registered pid must be live');
    assert.deepStrictEqual(parts.reclaim.map(p => p.pid), [201], 'unregistered app-profile holder must be reclaimable');

    const noRegistry = partitionHolders(prof, processes, new Set());
    assert.deepStrictEqual(noRegistry.live.map(p => p.pid), [], 'empty registry -> nothing is live');
    assert.deepStrictEqual(noRegistry.reclaim.map(p => p.pid).sort(), [201, 202], 'both holders reclaimable without a registry');
  });

  test('liveBrowsers registry: register / unregister / login listing roundtrip', () => {
    const liveBrowsers = require(path.join(ROOT, 'engine', 'liveBrowsers'));
    liveBrowsers.register('acc_t', 555, 'login');
    liveBrowsers.register('acc_t', 556, 'automation');
    liveBrowsers.register('acc_u', 557, 'login');
    assert.ok(liveBrowsers.isRegistered('acc_t', 555));
    assert.deepStrictEqual([...liveBrowsers.getRegisteredPids('acc_t')].sort(), [555, 556]);
    assert.deepStrictEqual(liveBrowsers.listLoginProcesses().map(p => p.pid).sort(), [555, 557]);
    liveBrowsers.unregister('acc_t', 555);
    assert.ok(!liveBrowsers.isRegistered('acc_t', 555));
    assert.deepStrictEqual(liveBrowsers.listLoginProcesses().map(p => p.pid), [557]);
    liveBrowsers.unregister('acc_t', 556);
    liveBrowsers.unregister('acc_u', 557);
    assert.deepStrictEqual([...liveBrowsers.getRegisteredPids('acc_t')], []);
    // Garbage input must be ignored, not throw.
    liveBrowsers.register('acc_t', -1, 'login');
    liveBrowsers.register('', 123, 'login');
    assert.deepStrictEqual([...liveBrowsers.getRegisteredPids('acc_t')], []);
  });

  test('isAppProfilePath: only paths inside the app profiles root qualify', () => {
    const { isAppProfilePath } = require(path.join(ROOT, 'engine', 'processHelper'));
    const root = path.join(ROOT, 'profiles');
    assert.strictEqual(isAppProfilePath(path.join(root, 'acc_1')), true);
    assert.strictEqual(isAppProfilePath(root), true);
    assert.strictEqual(isAppProfilePath('C:\\Users\\mohda\\AppData\\Local\\Google\\Chrome\\User Data'), false);
    assert.strictEqual(isAppProfilePath(path.join(ROOT + '_evil', 'acc_1')), false);
    assert.strictEqual(isAppProfilePath(''), false);
    assert.strictEqual(isAppProfilePath(null), false);
  });

  // -------------------------------------------------------------------------
  console.log('\n[11] v1.4.1 classifyHolders: kinds, reclaimLogin, check watchdog');

  test('classifyHolders: login/generation/check/hung-check/leftover each land correctly', () => {
    const { classifyHolders } = require(path.join(ROOT, 'engine', 'processHelper'));
    const { CHECK_WATCHDOG_MS } = require(path.join(ROOT, 'engine', 'liveBrowsers'));
    const prof = 'C:\\app\\profiles\\acc_1';
    const now = 1000000000;
    const cmd = (pid) => `"chrome.exe" --user-data-dir=C:\\app\\profiles\\acc_1 --tag=${pid}`;
    const processes = [
      { pid: 301, commandLine: cmd(301) }, // login window
      { pid: 302, commandLine: cmd(302) }, // generation in progress
      { pid: 303, commandLine: cmd(303) }, // fresh check
      { pid: 304, commandLine: cmd(304) }, // hung check (older than watchdog)
      { pid: 305, commandLine: cmd(305) }  // unregistered leftover
    ];
    const entries = [
      { pid: 301, kind: 'login', since: now - 60000 },
      { pid: 302, kind: 'generation', since: now - 3600000 },
      { pid: 303, kind: 'check', since: now - 30000 },
      { pid: 304, kind: 'check', since: now - CHECK_WATCHDOG_MS - 1000 }
    ];

    // Default (Sync/login callers): login protected, hung check + leftover reclaimed.
    const dflt = classifyHolders(prof, processes, entries, {}, now);
    assert.deepStrictEqual(dflt.live.map(p => p.pid).sort(), [301, 302, 303], 'login + generation + fresh check stay live');
    assert.deepStrictEqual(dflt.reclaim.map(p => p.pid).sort(), [304, 305], 'hung check and leftover are reclaimable');

    // Generation caller (reclaimLogin): v1.5.1 — generation outranks the
    // Sign In window AND any running credit check; only another
    // generation stays protected.
    const gen = classifyHolders(prof, processes, entries, { reclaimLogin: true }, now);
    assert.deepStrictEqual(gen.live.map(p => p.pid).sort(), [302], 'only the other generation stays live under reclaimLogin');
    assert.deepStrictEqual(gen.reclaim.map(p => p.pid).sort(), [301, 303, 304, 305], 'login window and checks are reclaimed for generation');

    // A generation is NEVER watchdogged, however old.
    const old = classifyHolders(prof, processes, entries, { reclaimLogin: true }, now + 24 * 3600000);
    assert.ok(old.live.some(p => p.pid === 302), 'generation stays protected after 24h');
  });

  test('liveBrowsers entries carry kind + since; login listing still works', () => {
    const liveBrowsers = require(path.join(ROOT, 'engine', 'liveBrowsers'));
    liveBrowsers.register('acc_k', 777, 'check');
    const entries = liveBrowsers.getEntries('acc_k');
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].pid, 777);
    assert.strictEqual(entries[0].kind, 'check');
    assert.ok(typeof entries[0].since === 'number' && entries[0].since > 0);
    liveBrowsers.unregister('acc_k', 777);
    assert.deepStrictEqual(liveBrowsers.getEntries('acc_k'), []);
  });

  // -------------------------------------------------------------------------
  console.log('\n[12] v1.5.0 tileIdentity: multi-prompt tile assignment');

  const ti = require(path.join(ROOT, 'engine', 'tileIdentity'));
  const mkTask = (key, prompt, preExisting, locked) => ({
    key,
    promptWords: ti.significantWords(prompt),
    preExistingFingerprints: new Set(preExisting || []),
    lockedFingerprint: locked || null
  });
  const mkTile = (tileIndex, aria) => ({
    tileIndex,
    fingerprint: ti.tileFingerprint(aria, ''),
    words: ti.significantWords(aria)
  });

  test('tileIdentity: sibling prompts bind their OWN tiles, never each other\'s', () => {
    const pA = 'a lone elephant walks slowly toward a waterhole at golden hour, dust in warm light, long lens';
    const pB = 'a cheetah sprints after a gazelle across the savanna at dawn, dust clouds behind, long lens';
    const tasks = [mkTask('A', pA), mkTask('B', pB)];
    const tiles = [mkTile(0, pB), mkTile(1, pA)]; // grid order reversed vs task order
    const m = ti.assignTiles(tasks, tiles, new Set());
    assert.strictEqual(m.get('A').tileIndex, 1, 'elephant task must bind the elephant tile');
    assert.strictEqual(m.get('B').tileIndex, 0, 'cheetah task must bind the cheetah tile');
  });

  test('tileIdentity: a locked fingerprint survives grid insertion (index shift)', () => {
    const pA = 'a lone elephant walks slowly toward a waterhole at golden hour';
    const pB = 'a cheetah sprints after a gazelle across the savanna';
    const fpA = ti.tileFingerprint(pA, '');
    const tasks = [mkTask('A', pA, [], fpA), mkTask('B', pB)];
    // A new tile (B's) inserted at the TOP: A's tile moved from 0 to 1.
    const tiles = [mkTile(0, pB), mkTile(1, pA)];
    const m = ti.assignTiles(tasks, tiles, new Set());
    assert.strictEqual(m.get('A').tileIndex, 1, 'fingerprint binding must follow the tile, not the index');
    assert.strictEqual(m.get('B').tileIndex, 0);
  });

  test('tileIdentity: a pre-existing tile is never claimed, however strong the match', () => {
    const pA = 'a lone elephant walks slowly toward a waterhole at golden hour';
    const tasks = [mkTask('A', pA, [ti.tileFingerprint(pA, '')])];
    const tiles = [mkTile(0, pA)]; // identical prompt — but it predates this submission
    const m = ti.assignTiles(tasks, tiles, new Set());
    assert.strictEqual(m.has('A'), false, 'history must never be claimed as a fresh result');
  });

  test('tileIdentity: a weak two-word overlap no longer claims a tile (scored path)', () => {
    // The SCORED claim stays strict: a two-word overlap never binds.
    assert.strictEqual(ti.isStrongMatch({ matched: 2, precision: 1 }), false);
    assert.strictEqual(ti.isStrongMatch({ matched: 5, precision: 0.5 }), false);
    assert.strictEqual(ti.isStrongMatch({ matched: 5, precision: 0.8 }), true);
    // With a SIBLING also in flight, the v2.4.0 timing fallback is
    // fenced OFF — a weak-overlap tile remains unclaimed (it could
    // belong to either task; guessing is exactly what v1.5 banned).
    const tasks = [mkTask('A', 'the elephant and the waterhole'), mkTask('B', 'a cheetah sprints after a gazelle across the savanna')];
    const tiles = [mkTile(0, 'the lion and the zebra rest quietly')];
    const m = ti.assignTiles(tasks, tiles, new Set());
    assert.strictEqual(m.has('A'), false, 'weak overlap + sibling in flight: no claim');
    // And a tile from the task's own pre-submit snapshot is history,
    // never a fresh claim — fallback or not.
    const fpOld = ti.tileFingerprint('the lion and the zebra rest quietly', '');
    const solo = [mkTask('A', 'the elephant and the waterhole', [fpOld])];
    const m2 = ti.assignTiles(solo, tiles, new Set());
    assert.strictEqual(m2.has('A'), false, 'pre-existing tile: never claimed, even for a lone weak task');
  });

  test('tileIdentity v2.4.0: short-prompt timing fallback claims ONLY a lone in-flight task\u2019s new tile', () => {
    // The owner's exact case: "make a video" has ONE significant
    // word ('make') — no tile can ever score-match it.
    assert.deepStrictEqual([...ti.significantWords('make a video')], ['make']);
    assert.strictEqual(ti.isWeakTextPrompt(ti.significantWords('make a video')), true);
    assert.strictEqual(ti.isWeakTextPrompt(ti.significantWords('a golden dog running through a green park')), false);
    // Case 1: lone weak task + a NEW tile (not in its snapshot) ->
    // the fallback binds it by order/timing.
    const fpNew = ti.tileFingerprint('make a video', '');
    const solo = [mkTask('A', 'make a video', [ti.tileFingerprint('an older unrelated render', '')])];
    const m1 = ti.assignTiles(solo, [mkTile(0, 'make a video')], new Set());
    assert.ok(m1.has('A') && m1.get('A').fingerprint === fpNew, 'lone weak task claims the new tile');
    // Case 2: TWO weak tasks in flight -> the fallback stays OFF for
    // both (a new tile could be either one's; never guess).
    const two = [mkTask('A', 'make a video'), mkTask('B', 'make a clip')];
    const m2 = ti.assignTiles(two, [mkTile(0, 'make a video')], new Set());
    assert.strictEqual(m2.size, 0, 'parallel short prompts never steal a tile via the fallback');
    // Case 3: the only tile is externally claimed -> no fallback.
    const m3 = ti.assignTiles([mkTask('A', 'make a video')], [mkTile(0, 'make a video')], new Set([fpNew]));
    assert.strictEqual(m3.has('A'), false, 'an externally claimed tile is never taken');
    // Case 4: a STRONG task alone gets no fallback either — a tile
    // that does not score-match its prompt is not its render.
    const strong = [mkTask('A', 'a golden dog running through a green park on a sunny day')];
    const m4 = ti.assignTiles(strong, [mkTile(0, 'a red car in the rain')], new Set());
    assert.strictEqual(m4.has('A'), false, 'strong prompts still need a scored match');
  });

  test('tileIdentity: an exact tie between sibling tasks leaves the tile unclaimed', () => {
    const p = 'elephant waterhole golden dust light savanna river bank trees';
    const tasks = [mkTask('A', p), mkTask('B', p)];
    const tiles = [mkTile(0, p)];
    const m = ti.assignTiles(tasks, tiles, new Set());
    assert.strictEqual(m.size, 0, 'ambiguous tiles must wait for a clearer poll, not be guessed');
  });

  // -------------------------------------------------------------------------
  console.log('\n[13] v1.8.0 ZDola-logic: two-strike sign-out, timed rest, verify pass, usage counts');

  test('two-strike sign-out: first observation -> Unconfirmed (balance kept), second -> Need Login', () => {
    const store = makeStore([{ id: 'acc_1', credits: 640, status: 'Ready' }]);
    const cs = createCreditService(store);
    const first = cs.applySignOutObservation('acc_1');
    assert.strictEqual(first.outcome, 'unconfirmed');
    assert.strictEqual(store.rows.get('acc_1').status, 'Unconfirmed');
    assert.strictEqual(store.rows.get('acc_1').credits, 640, 'an unconfirmed sign-out must not touch the balance');
    const second = cs.applySignOutObservation('acc_1');
    assert.strictEqual(second.outcome, 'need-login');
    assert.strictEqual(store.rows.get('acc_1').status, 'Need Login');
    assert.strictEqual(store.rows.get('acc_1').credits, 640, 'even a confirmed sign-out preserves the balance (fix #3)');
  });

  test('a live confirmation clears sign-out strikes and any rest', () => {
    const store = makeStore([{ id: 'acc_1', credits: 100, status: 'Ready' }]);
    const cs = createCreditService(store);
    cs.applySignOutObservation('acc_1');
    cs.applyCooldown('acc_1');
    assert.strictEqual(store.rows.get('acc_1').status, 'Cooldown');
    cs.applyLiveBalance('acc_1', 90);
    const row = store.rows.get('acc_1');
    assert.strictEqual(row.status, 'Ready');
    assert.strictEqual(row.signoutStrikes, 0, 'strikes cleared by a live read');
    assert.strictEqual(row.restUntil, '', 'rest cleared by a live read');
    assert.strictEqual(row.cooldownLevel, 0, 'cooldown level reset by a live read');
  });

  test('timed cooldown: rest escalates 30m -> 2h and restUntil is in the future', () => {
    const store = makeStore([{ id: 'acc_1', credits: 100, status: 'Ready' }]);
    const cs = createCreditService(store);
    const r1 = cs.applyCooldown('acc_1');
    assert.strictEqual(r1.minutes, 30);
    assert.ok(Date.parse(r1.restUntil) > Date.now(), 'rest must end in the future');
    assert.strictEqual(store.rows.get('acc_1').status, 'Cooldown');
    assert.strictEqual(store.rows.get('acc_1').credits, 100, 'cooldown never touches credits');
    const r2 = cs.applyCooldown('acc_1');
    assert.strictEqual(r2.minutes, 120, 'second cooldown escalates to 2h');
    assert.strictEqual(store.rows.get('acc_1').cooldownLevel, 2);
  });

  test('accountHealth.isResting: future rest rests, expired rest frees, legacy rest parks', () => {
    const { isResting } = require(path.join(ROOT, 'engine', 'accountHealth'));
    const future = new Date(Date.now() + 60000).toISOString();
    const past = new Date(Date.now() - 60000).toISOString();
    assert.strictEqual(isResting({ status: 'Cooldown', restUntil: future }), true);
    assert.strictEqual(isResting({ status: 'Cooldown', restUntil: past }), false);
    assert.strictEqual(isResting({ status: 'Cooldown', restUntil: '' }), true, 'legacy cooldown without a clock stays parked');
    assert.strictEqual(isResting({ status: 'Ready', restUntil: future }), false);
  });

  await testAsync('verify pass: live / need-login (two strikes) / unknown retried exactly once', async () => {
    const { verifyAllAccounts } = require(path.join(ROOT, 'engine', 'accountHealth'));
    const rows = new Map([
      ['a_live', { id: 'a_live', name: 'Live', status: 'Ready', credits: 50 }],
      ['a_out', { id: 'a_out', name: 'Out', status: 'Ready', credits: 70 }],
      ['a_mystery', { id: 'a_mystery', name: 'Mystery', status: 'Ready', credits: null }]
    ]);
    const calls = new Map();
    const fetchCredits = async (id) => {
      calls.set(id, (calls.get(id) || 0) + 1);
      if (id === 'a_live') return { success: true };
      if (id === 'a_out') {
        // Simulate creditService's two-strike rule behind the fetch.
        if (calls.get(id) === 1) { rows.get(id).status = 'Unconfirmed'; return { success: false, explicitSignedOut: true }; }
        rows.get(id).status = 'Need Login'; return { success: false, explicitSignedOut: true };
      }
      return { success: false, error: 'page inconclusive' };
    };
    const { results, summary } = await verifyAllAccounts({
      fetchCredits,
      getAccount: (id) => rows.get(id) || null,
      listAccounts: () => [...rows.values()]
    }, { concurrency: 2, retryDelayMs: 1 });

    const byId = Object.fromEntries(results.map(r => [r.id, r]));
    assert.strictEqual(byId.a_live.outcome, 'live');
    assert.strictEqual(calls.get('a_live'), 1, 'a confirmed live account is checked once');
    assert.strictEqual(byId.a_out.outcome, 'need-login', 'sign-out must be confirmed by the second look');
    assert.strictEqual(calls.get('a_out'), 2, 'first-strike sign-out gets exactly one confirmation look');
    assert.strictEqual(byId.a_mystery.outcome, 'unknown');
    assert.strictEqual(calls.get('a_mystery'), 2, 'an inconclusive check is retried exactly once');
    assert.strictEqual(summary.live, 1);
    assert.strictEqual(summary.needLogin, 1);
    assert.strictEqual(summary.unknown, 1);
    assert.strictEqual(summary.total, 3);
  });

  test('usage stats: counts only — total / today / last7 move together', () => {
    const usageStats = require(path.join(ROOT, 'engine', 'usageStats'));
    const kv = new Map();
    const store = {
      getSetting: (k, d) => (kv.has(k) ? kv.get(k) : d),
      setSetting: (k, v) => kv.set(k, String(v))
    };
    assert.deepStrictEqual(usageStats.getStats(store), { total: 0, today: 0, last7Days: 0 });
    usageStats.recordSaved(store);
    usageStats.recordSaved(store);
    usageStats.recordSaved(store);
    assert.deepStrictEqual(usageStats.getStats(store), { total: 3, today: 3, last7Days: 3 });
  });

  // -------------------------------------------------------------------------
  console.log('\n[14] v1.8.0 resume: existing rows run in place; needs_check rows wait when the project cannot open');

  await testAsync('resume run: needs_check task stays pending+flagged, normal pending task fails visibly on busy launch', async () => {
    const resumeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fslite-resume-'));
    const dbPath = JSON.stringify(dbModulePath);
    const poolPath = JSON.stringify(path.join(ROOT, 'engine', 'workerPool.js'));
    const flowPath = JSON.stringify(path.join(ROOT, 'engine', 'flowAutomation.js'));
    const setup = `
      (async () => {
        const { dbService } = require(${dbPath});
        await dbService.ensureInit();
        dbService.insertAccount({ id: 'acc_r', name: 'Resume', email: 'r@example.com', dirName: 'acc_r', status: 'Ready', credits: 500 });
        const tasks = dbService.createBatchTasks('batch_r', ['prompt alpha', 'prompt beta'], { model: 'Omni Flash', duration: '6s', aspectRatio: '9:16', type: 'Video' });
        dbService.run("UPDATE queue_tasks SET needs_check = 1, assigned_account_id = 'acc_r', assigned_account_name = 'Resume' WHERE id = ?", [tasks[0].id]);
        dbService.persistNow();
        console.log(JSON.stringify({ t0: tasks[0].id, t1: tasks[1].id }));
      })().catch(e => { console.error(e); process.exit(1); });
    `;
    const run = `
      (async () => {
        const { dbService } = require(${dbPath});
        await dbService.ensureInit();
        const { FlowAutomationEngine } = require(${flowPath});
        FlowAutomationEngine.prototype.launchBrowserForAccount = async function () { this.lastLaunchError = 'PROFILE_BUSY'; this.lastBusyDetail = 'busy'; return false; };
        const { WorkerPool } = require(${poolPath});
        const rows = dbService.getResumableTasks();
        const pool = new WorkerPool({ concurrency: 1, maxLaunchAttempts: 1, launchBackoffMs: 1, onLog: () => {}, onProgress: () => {}, onTaskUpdate: () => {} });
        await pool.runQueue(null, null, ${JSON.stringify(resumeDir)}, { existingTasks: rows });
        const out = {};
        for (const r of dbService.query('SELECT * FROM queue_tasks ORDER BY prompt_index ASC')) {
          out[r.prompt_text] = { status: r.status, needs_check: r.needs_check };
        }
        out.resumableAfter = dbService.getResumableTasks().length;
        console.log(JSON.stringify(out));
      })().catch(e => { console.error(e); process.exit(1); });
    `;
    const env = { ...process.env, FLOW_LITE_DATA_DIR: resumeDir };
    const rawSetup = execFileSync(process.execPath, ['-e', setup], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    JSON.parse(rawSetup.trim().split('\n').pop());
    const raw = execFileSync(process.execPath, ['-e', run], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const out = JSON.parse(raw.trim().split('\n').pop());

    // The interrupted (needs_check) task: its project could not be
    // opened (launch busy), so it must WAIT — still pending, still
    // flagged, never submitted blind.
    assert.strictEqual(out['prompt alpha'].status, 'pending', 'needs_check task must stay pending when its project cannot be checked');
    assert.strictEqual(out['prompt alpha'].needs_check, 1, 'needs_check flag must survive a failed recovery attempt');
    // The never-started task ran through the normal path and, with the
    // launch bounded-busy, failed VISIBLY in the SAME original row.
    assert.strictEqual(out['prompt beta'].status, 'failed', 'normal pending task must be processed in place and fail visibly');
    assert.strictEqual(out.resumableAfter, 1, 'only the needs_check task remains resumable');
    try { fs.rmSync(resumeDir, { recursive: true, force: true }); } catch (e) {}
  });

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}

  // -------------------------------------------------------------------------
  console.log('\n[15] v2.0.0: activity store, cookie store, failover, credits watch, bulk lines');

  test('activity store: add/list/filter/cap/clear + broadcaster', () => {
    const { createActivityStore } = require(path.join(ROOT, 'engine', 'activityStore'));
    const kv = new Map();
    const store = { getSetting: (k, d) => (kv.has(k) ? kv.get(k) : d), setSetting: (k, v) => kv.set(k, String(v)) };
    const pushed = [];
    const act = createActivityStore(store, { maxEntries: 5, onEntry: (e) => pushed.push(e) });
    act.add({ category: 'login', level: 'success', message: 'Login ok' });
    act.add({ category: 'generation', message: 'Generation shuru' });
    act.add({ category: 'credits', level: 'warn', message: 'Low credits' });
    assert.strictEqual(act.count(), 3);
    assert.strictEqual(act.list()[0].message, 'Low credits', 'newest entry first');
    assert.strictEqual(act.list({ category: 'login' }).length, 1);
    assert.strictEqual(act.list({ category: 'login' })[0].level, 'success');
    assert.strictEqual(pushed.length, 3, 'broadcaster sees every stored entry');
    assert.strictEqual(act.add({ message: '   ' }), null, 'blank message is dropped, never stored');
    act.add({ category: 'errors', message: 'E1' });
    act.add({ message: 'E2' });
    act.add({ message: 'E3' });
    assert.strictEqual(act.count(), 5, 'cap holds at maxEntries (oldest dropped)');
    assert.strictEqual(act.list({ category: 'bogus' }).length, 0, 'unknown category lists nothing');
    act.clear();
    assert.strictEqual(act.count(), 0);
  });

  test('cookie store: save/load/has/delete roundtrip; invalid account id rejected', () => {
    const { createCookieStore } = require(path.join(ROOT, 'engine', 'cookieStore'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fslite-cookies-'));
    try {
      const cs = createCookieStore(dir);
      const cookies = [
        { name: 'SID', value: 'v1', domain: '.google.com', path: '/', secure: true, httpOnly: true },
        { name: 'HSID', value: 'v2', domain: '.google.com', path: '/' }
      ];
      assert.strictEqual(cs.hasSaved('acc_t1'), false);
      assert.strictEqual(cs.load('acc_t1'), null);
      assert.strictEqual(cs.save('acc_t1', cookies), 2);
      assert.strictEqual(cs.hasSaved('acc_t1'), true);
      assert.strictEqual(cs.savedCount('acc_t1'), 2);
      const loaded = cs.load('acc_t1');
      assert.strictEqual(loaded.length, 2);
      assert.strictEqual(loaded[0].name, 'SID');
      assert.strictEqual(loaded[0].domain, '.google.com');
      assert.strictEqual(cs.deleteSaved('acc_t1'), true);
      assert.strictEqual(cs.hasSaved('acc_t1'), false);
      assert.strictEqual(cs.load('acc_t1'), null);
      assert.throws(() => cs.save('bad id!', cookies), /Invalid account id/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('failover classify: policy/stop never move; account-level failures move with kinds', () => {
    const failover = require(path.join(ROOT, 'engine', 'failover'));
    assert.strictEqual(failover.classifyFailure('Google Safety / Policy Filter: prompt rejected').eligible, false, 'policy is prompt-level — never failovers');
    assert.strictEqual(failover.classifyFailure('Worker error: Stopped by user').eligible, false);
    assert.strictEqual(failover.classifyFailure('Render timed out — tile made no progress').eligible, true);
    assert.strictEqual(failover.classifyFailure('Render timed out — tile made no progress').kind, 'generation');
    assert.strictEqual(failover.classifyFailure('Google login required. Need Login.').kind, 'need-login');
    assert.strictEqual(failover.classifyFailure('Insufficient credits for this generation').kind, 'credits');
    assert.strictEqual(failover.classifyFailure('Download failed after the render completed').kind, 'download');
    assert.strictEqual(failover.classifyFailure('Google Flow: Unusual Activity (Cooldown / Delay required)').kind, 'cooldown');
  });

  test('failover tracker: a task gets at most 3 account tries, then fails for real', () => {
    const failover = require(path.join(ROOT, 'engine', 'failover'));
    const tr = failover.createFailoverTracker();
    tr.recordTry('t1', 'acc_a');
    assert.strictEqual(tr.tries('t1'), 1);
    assert.strictEqual(tr.hasTried('t1', 'acc_a'), true);
    assert.strictEqual(tr.hasTried('t1', 'acc_b'), false);
    assert.strictEqual(tr.canFailover('t1', 'Render timed out').ok, true);
    tr.recordTry('t1', 'acc_b');
    tr.recordTry('t1', 'acc_c');
    assert.strictEqual(tr.tries('t1'), 3);
    assert.strictEqual(tr.canFailover('t1', 'Render timed out').ok, false, 'budget spent — no loop');
    tr.recordTry('t2', 'acc_a');
    assert.strictEqual(tr.canFailover('t2', 'Google Safety / Policy Filter').ok, false, 'policy never moves even with budget left');
  });

  test('creditWatch dashboard: totals sum known balances, live count, low list skips Need Login', () => {
    const cw = require(path.join(ROOT, 'engine', 'creditWatch'));
    const dash = cw.computeDashboard([
      { id: 'a', name: 'A', status: 'Ready', credits: 50 },
      { id: 'b', name: 'B', status: 'Low Credits', credits: 5 },
      { id: 'c', name: 'C', status: 'Need Login', credits: 3 },
      { id: 'd', name: 'D', status: 'Ready', credits: null }
    ], { spendToday: 12, todayVideos: 2 });
    assert.strictEqual(dash.totalCredits, 58, 'null balance is unknown, never zero');
    assert.strictEqual(dash.liveCount, 3, 'live = Ready / Low Credits STATUS (balance unknown wala Ready bhi live hai)');
    assert.strictEqual(dash.accountCount, 4);
    assert.strictEqual(dash.lowAccounts.length, 1);
    assert.strictEqual(dash.lowAccounts[0].id, 'b');
    assert.strictEqual(dash.spendToday, 12);
    assert.strictEqual(dash.todayVideos, 2);
  });

  test('creditWatch spend: live-balance drop + estimated charge count; increases never count', () => {
    const cw = require(path.join(ROOT, 'engine', 'creditWatch'));
    const kv = new Map();
    const store = { getSetting: (k, d) => (kv.has(k) ? kv.get(k) : d), setSetting: (k, v) => kv.set(k, String(v)) };
    const watch = cw.createCreditWatch(store);
    assert.strictEqual(watch.todaySpend(), 0);
    assert.strictEqual(watch.observeLiveBalance('a', 100), 0, 'first pool read is a baseline, not spend');
    assert.strictEqual(watch.observeLiveBalance('a', 94), 6, 'a drop between pool reads is a charge');
    assert.strictEqual(watch.observeLiveBalance('a', 140), 0, 'a balance INCREASE (refresh) is never spend');
    assert.strictEqual(watch.todaySpend(), 6);
    assert.strictEqual(watch.observeEstimatedCharge('b', 10, 'ok'), 10);
    assert.strictEqual(watch.observeEstimatedCharge('b', 10, 'needs-live-check'), 10, 'a fired submission that zeroed the balance still spent');
    assert.strictEqual(watch.observeEstimatedCharge('b', 10, 'unknown'), 0, 'unknown outcome records nothing');
    assert.strictEqual(watch.todaySpend(), 26);
  });

  test('creditWatch alerts: below 10 alerts once per day per account; 10+ and Need Login never', () => {
    const cw = require(path.join(ROOT, 'engine', 'creditWatch'));
    const kv = new Map();
    const store = { getSetting: (k, d) => (kv.has(k) ? kv.get(k) : d), setSetting: (k, v) => kv.set(k, String(v)) };
    const watch = cw.createCreditWatch(store);
    const list = [
      { id: 'low1', name: 'Low One', status: 'Ready', credits: 5 },
      { id: 'ok1', name: 'Ok One', status: 'Ready', credits: 10 },
      { id: 'nl', name: 'Out', status: 'Need Login', credits: 0 },
      { id: 'zero', name: 'Zero', status: 'Exhausted', credits: 0 }
    ];
    const seen = [];
    const first = watch.checkLowAlerts(list, (a) => seen.push(a.id));
    assert.deepStrictEqual(first.map(a => a.id).sort(), ['low1', 'zero']);
    const second = watch.checkLowAlerts(list, (a) => seen.push(a.id));
    assert.strictEqual(second.length, 0, 'same account must not alert twice in one day (no spam)');
    assert.strictEqual(seen.length, 2);
  });

  test('bulk prompts: parsePromptLines — one line = one prompt, blanks skipped, markers kept', () => {
    const { parsePromptLines, parsePromptBlocks } = require(path.join(ROOT, 'renderer', 'promptParser'));
    assert.deepStrictEqual(
      parsePromptLines('one prompt\n\n  two prompt  \r\n#03 marker line\nthree'),
      ['one prompt', 'two prompt', '#03 marker line', 'three']
    );
    assert.deepStrictEqual(parsePromptLines(''), []);
    assert.deepStrictEqual(parsePromptLines(null), []);
    assert.deepStrictEqual(parsePromptLines('\n\n\n'), []);
    // Paragraph mode is untouched by the new parser.
    assert.strictEqual(parsePromptBlocks('a\nb\n\nc').length, 2);
  });

  await testAsync('pool v2.0.0: failover moves a failed task to the NEXT account; policy never moves; 3 tries max; parallel clamp 5', async () => {
    const foDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fslite-failover-'));
    const run = `
      (async () => {
        const { dbService } = require(${JSON.stringify(dbModulePath)});
        await dbService.ensureInit();
        for (const [id, name] of [['acc_fa', 'Fail A'], ['acc_fb', 'Good B'], ['acc_fc', 'Good C']]) {
          dbService.insertAccount({ id, name, email: id + '@example.com', dirName: id, status: 'Ready', credits: 100 });
        }
        const { FlowAutomationEngine } = require(${JSON.stringify(path.join(ROOT, 'engine', 'flowAutomation.js'))});
        const submits = {};
        FlowAutomationEngine.prototype.launchBrowserForAccount = async function (account) {
          this.currentAccount = account;
          this.browser = { mock: true };
          this.page = { isClosed: () => false };
          return true;
        };
        FlowAutomationEngine.prototype.openFlowStudio = async function () { return 'READY'; };
        FlowAutomationEngine.prototype.closeBrowser = async function () { this.browser = null; this.page = null; };
        FlowAutomationEngine.prototype.submitPrompt = async function (text, settings, idx) {
          const accId = this.currentAccount.id;
          (submits[text] = submits[text] || []).push(accId);
          return { status: 'SUBMITTED', videoId: 'v_' + accId, promptIndex: idx, promptText: text };
        };
        FlowAutomationEngine.prototype.waitForAccountTasks = async function (tasks) {
          for (const t of tasks) {
            if (t.completed || t.downloaded) continue;
            t.completed = true; t.downloaded = true;
            const accId = this.currentAccount.id;
            if (t.promptText.includes('always-fails')) {
              t.failed = true; this.onTaskFailed(t, 'Render timed out — no progress');
            } else if (t.promptText.includes('failover-me') && accId === 'acc_fa') {
              t.failed = true; this.onTaskFailed(t, 'Render timed out — no progress');
            } else if (t.promptText.includes('policy-bad')) {
              t.failed = true; this.onTaskFailed(t, 'Google Safety / Policy Filter: prompt rejected');
            } else {
              this.onTaskCompleted(t, { filePath: '/tmp/' + t.taskId + '.mp4', fileName: t.taskId + '.mp4', fileSizeMB: '1.0', downloadMethod: 'mock' });
            }
          }
        };
        const { WorkerPool } = require(${JSON.stringify(path.join(ROOT, 'engine', 'workerPool.js'))});
        const clamp = new WorkerPool({ concurrency: 9 }).concurrency;
        const settings = { model: 'Omni Flash', duration: '6s', aspectRatio: '9:16', type: 'Video' };

        const pool1 = new WorkerPool({ concurrency: 1, launchBackoffMs: 1, onLog: () => {}, onProgress: () => {}, onTaskUpdate: () => {} });
        await pool1.runQueue(['make a failover-me video', 'a policy-bad prompt'], settings, ${JSON.stringify(foDir)});

        const pool2 = new WorkerPool({ concurrency: 3, launchBackoffMs: 1, onLog: () => {}, onProgress: () => {}, onTaskUpdate: () => {} });
        await pool2.runQueue(['parallel one', 'parallel two', 'parallel three'], settings, ${JSON.stringify(foDir)});

        const pool3 = new WorkerPool({ concurrency: 1, launchBackoffMs: 1, onLog: () => {}, onProgress: () => {}, onTaskUpdate: () => {} });
        await pool3.runQueue(['always-fails forever'], settings, ${JSON.stringify(foDir)});

        const rows = {};
        for (const r of dbService.query('SELECT prompt_text, status, assigned_account_id FROM queue_tasks')) {
          rows[r.prompt_text] = { status: r.status, account: r.assigned_account_id };
        }
        let activity = [];
        try { activity = JSON.parse(dbService.getSetting('activity_v1', '[]')); } catch (e) {}
        dbService.persistNow();
        console.log(JSON.stringify({ clamp, submits, rows, activityCount: activity.length,
          hasFailoverEntry: activity.some(a => /Failover/.test(a.message || '')),
          hasDownloadEntry: activity.some(a => /Download complete/.test(a.message || '')) }));
      })().catch(e => { console.error(e); process.exit(1); });
    `;
    const env = { ...process.env, FLOW_LITE_DATA_DIR: foDir };
    const raw = execFileSync(process.execPath, ['-e', run], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
    const out = JSON.parse(raw.trim().split('\n').pop());
    try {
      assert.strictEqual(out.clamp, 5, 'v2.0.0 concurrency clamp is 5');
      assert.deepStrictEqual(out.submits['make a failover-me video'], ['acc_fa', 'acc_fb'], 'task fired first on A, then failed over to B');
      assert.strictEqual(out.rows['make a failover-me video'].status, 'completed');
      assert.strictEqual(out.rows['make a failover-me video'].account, 'acc_fb', 'completion is recorded against the account that actually produced it');
      assert.deepStrictEqual(out.submits['a policy-bad prompt'], ['acc_fa'], 'policy rejection must NEVER fail over');
      assert.strictEqual(out.rows['a policy-bad prompt'].status, 'failed');
      assert.deepStrictEqual(out.submits['always-fails forever'], ['acc_fa', 'acc_fb', 'acc_fc'], 'failover tries rotate across accounts');
      assert.strictEqual(out.rows['always-fails forever'].status, 'failed', 'after 3 account tries the task fails visibly — no loop');
      for (const p of ['parallel one', 'parallel two', 'parallel three']) {
        assert.strictEqual(out.rows[p].status, 'completed', `parallel task completed: ${p}`);
      }
      const parallelAccounts = new Set(['parallel one', 'parallel two', 'parallel three'].map(p => out.rows[p].account));
      assert.strictEqual(parallelAccounts.size, 3, '3 parallel tasks ran on 3 different accounts at once');
      assert.ok(out.hasFailoverEntry, 'failover wrote an Activity entry');
      assert.ok(out.hasDownloadEntry, 'a completed download wrote an Activity entry');
    } finally {
      try { fs.rmSync(foDir, { recursive: true, force: true }); } catch (e) {}
    }
  });

  // -------------------------------------------------------------------------
  console.log('\n[16] v2.1.0: no built-in dialogs, same-account retry, stall recovery, cookie auto-retry, activity detail');

  test('renderer JS: no built-in dialog calls (the Electron dead-button bug) in stripped source', () => {
    // Strip strings + comments first: UI copy legitimately contains
    // words like "prompt (har line…)" — only CODE is checked. A small
    // state machine handles ', ", ` (with ${} nesting) and comments.
    function stripJs(src) {
      let out = '';
      let i = 0;
      const stack = []; // 'line' | 'block' | 'sq' | 'dq' | 'tpl' | 'expr'
      while (i < src.length) {
        const c = src[i];
        const n = src[i + 1] || '';
        const top = stack[stack.length - 1];
        if (top === 'line') {
          if (c === '\n') { stack.pop(); out += c; }
          i++;
          continue;
        }
        if (top === 'block') {
          if (c === '*' && n === '/') { stack.pop(); i += 2; } else i++;
          continue;
        }
        if (top === 'sq' || top === 'dq') {
          const q = top === 'sq' ? "'" : '"';
          if (c === '\\') { i += 2; continue; }
          if (c === q) stack.pop();
          i++;
          continue;
        }
        if (top === 'tpl') {
          if (c === '\\') { i += 2; continue; }
          if (c === '`') { stack.pop(); i++; continue; }
          if (c === '$' && n === '{') { stack.push('expr'); out += ' '; i += 2; continue; }
          i++;
          continue;
        }
        // code (or inside a template ${} expression)
        if (c === '/' && n === '/') { stack.push('line'); i += 2; continue; }
        if (c === '/' && n === '*') { stack.push('block'); i += 2; continue; }
        if (c === "'") { stack.push('sq'); i++; continue; }
        if (c === '"') { stack.push('dq'); i++; continue; }
        if (c === '`') { stack.push('tpl'); i++; continue; }
        if (top === 'expr' && c === '}') { stack.pop(); i++; continue; }
        out += c;
        i++;
      }
      return out;
    }
    for (const rel of ['renderer/app.js', 'renderer/preview.js', 'renderer/promptParser.js']) {
      const stripped = stripJs(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
      assert.ok(!/\bprompt\s*\(/.test(stripped), `${rel}: built-in input dialog call found in code (Electron does not implement it — the button would die silently)`);
      assert.ok(!/\balert\s*\(/.test(stripped), `${rel}: built-in alert call found in code`);
      assert.ok(!/\bconfirm\s*\(/.test(stripped), `${rel}: built-in confirm call found in code`);
    }
    // And the in-app replacements actually exist.
    const appSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
    for (const fn of ['showInputModal', 'showConfirmModal', 'showInfoModal', 'showToast', 'copyTextToClipboard']) {
      assert.ok(appSrc.includes(`function ${fn}`) || appSrc.includes(`async function ${fn}`), `app.js must define ${fn}`);
    }
    const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
    assert.ok(html.includes('id="modal-overlay"'), 'index.html carries the in-app modal markup');
    assert.ok(html.includes('id="btn-copy-log"'), 'Generate page has the Copy Log button');
    assert.ok(html.includes('id="btn-copy-activity"'), 'Activity page has the Sab Copy Karo button');
  });

  test('failover tracker v2.1.0: per-account attempts + same-account retry budget + marks', () => {
    const failoverMod = require(path.join(ROOT, 'engine', 'failover'));
    const tr = failoverMod.createFailoverTracker();
    tr.recordTry('t1', 'acc_a');
    tr.recordTry('t1', 'acc_a');
    assert.strictEqual(tr.tries('t1'), 1, 'distinct accounts stay 1 on a single account');
    assert.strictEqual(tr.attempts('t1', 'acc_a'), 2, 'raw submissions on that account are 2');
    assert.strictEqual(tr.canSameAccountRetry('t1', 'acc_a', 'Render timed out — no progress').ok, true, 'retry allowed inside the per-account cap');
    tr.recordTry('t1', 'acc_a');
    assert.strictEqual(tr.attempts('t1', 'acc_a'), 3);
    assert.strictEqual(tr.canSameAccountRetry('t1', 'acc_a', 'Render timed out — no progress').ok, false, 'per-account cap (3 submissions) stops the loop');
    tr.recordTry('t2', 'acc_a');
    assert.strictEqual(tr.canSameAccountRetry('t2', 'acc_a', 'Google Safety / Policy Filter: prompt rejected').ok, false, 'policy never same-account retries');
    assert.strictEqual(tr.canSameAccountRetry('t2', 'acc_b', 'Render timed out').ok, false, 'an account the task never fired on is not a same-account retry');
    tr.markSameAccountRetry('t1', 'acc_a', 12345);
    assert.deepStrictEqual(tr.sameAccountRetry('t1'), { accountId: 'acc_a', dueAt: 12345 });
    tr.clearSameAccountRetry('t1');
    assert.strictEqual(tr.sameAccountRetry('t1'), null);
    tr.forget('t1');
    assert.strictEqual(tr.attempts('t1', 'acc_a'), 0, 'forget clears attempt counts too');
  });

  test('stallWatch: stall starts recovery (never an instant fail); tile found = recovered; window end = give-up once', () => {
    const sw = require(path.join(ROOT, 'engine', 'stallWatch'));
    const opts = { recoveryWindowMs: 60000, progressEveryMs: 30000 };
    const task = {};
    let a = sw.observeStall(task, { stalled: true, hasTile: false, now: 1000, ...opts });
    assert.strictEqual(a.type, 'recovery-started', 'first stall sighting starts recovery — the paid render is NOT failed');
    assert.strictEqual(sw.isInRecovery(task), true);
    a = sw.observeStall(task, { stalled: true, hasTile: false, now: 5000, ...opts });
    assert.strictEqual(a.type, 'recovery-progress');
    assert.strictEqual(a.logDue, false, 'no progress log before the cadence');
    a = sw.observeStall(task, { stalled: true, hasTile: false, now: 31500, ...opts });
    assert.strictEqual(a.type, 'recovery-progress');
    assert.strictEqual(a.logDue, true, 'progress log due at the 30s cadence');
    a = sw.observeStall(task, { stalled: false, hasTile: true, now: 33000, ...opts });
    assert.strictEqual(a.type, 'recovered', 'a tile appearing during recovery resolves it');
    assert.strictEqual(sw.isInRecovery(task), false);

    const task2 = {};
    assert.strictEqual(sw.observeStall(task2, { stalled: true, hasTile: false, now: 0, ...opts }).type, 'recovery-started');
    const g = sw.observeStall(task2, { stalled: true, hasTile: false, now: 61000, ...opts });
    assert.strictEqual(g.type, 'give-up', 'only the FULL window passing with no tile may fail the task');
    assert.strictEqual(sw.observeStall(task2, { stalled: true, hasTile: false, now: 62000, ...opts }).type, 'none', 'give-up fires exactly once');
    assert.strictEqual(sw.formatDuration(45), '45 s');
    assert.strictEqual(sw.formatDuration(65), '1 min 5 s');
    assert.strictEqual(sw.formatDuration(600), '10 min');
  });

  await testAsync('cookie check core: unconfirmed auto-retries once (then LIVE); double sign-out = need-login; busy profile never retried', async () => {
    const { runCookieCheckCore, cookieCheckState } = require(path.join(ROOT, 'engine', 'cookieImport'));
    // Case A — the owner's exact PC experience: first look says signed
    // out (strike 1 / Unconfirmed), the automatic second look is LIVE.
    {
      let calls = 0;
      let acc = { status: 'Unconfirmed', credits: null };
      const out = await runCookieCheckCore({
        retryDelayMs: 0,
        fetchOnce: async () => {
          calls++;
          if (calls === 1) return { success: false, explicitSignedOut: true };
          acc = { status: 'Ready', credits: 50 };
          return { success: true };
        },
        getAccount: () => acc
      });
      assert.strictEqual(calls, 2, 'an unconfirmed first look is re-checked exactly once, automatically');
      assert.strictEqual(out.attempts, 2);
      assert.strictEqual(out.outcome, 'live', 'the second look decides — LIVE, no manual Re-check needed');
      assert.strictEqual(out.check.state, 'live');
    }
    // Case B — signed out twice: two-strike lands on Need Login.
    {
      let calls = 0;
      let acc = { status: 'Unconfirmed', credits: 20 };
      const out = await runCookieCheckCore({
        retryDelayMs: 0,
        fetchOnce: async () => {
          calls++;
          if (calls === 2) acc = { status: 'Need Login', credits: 20 };
          return { success: false, explicitSignedOut: true };
        },
        getAccount: () => acc
      });
      assert.strictEqual(out.attempts, 2);
      assert.strictEqual(out.outcome, 'need-login');
      assert.strictEqual(out.check.state, 'fail');
    }
    // Case C — live on the first look: no retry spent.
    {
      let calls = 0;
      const out = await runCookieCheckCore({
        retryDelayMs: 0,
        fetchOnce: async () => { calls++; return { success: true }; },
        getAccount: () => ({ status: 'Ready', credits: 50 })
      });
      assert.strictEqual(calls, 1);
      assert.strictEqual(out.outcome, 'live');
    }
    // Case D — busy Chrome profile: retrying cannot help, so it is not retried.
    {
      let calls = 0;
      const out = await runCookieCheckCore({
        retryDelayMs: 0,
        fetchOnce: async () => { calls++; return { success: false, chromeOpen: true, error: 'busy' }; },
        getAccount: () => ({ status: 'Ready', credits: 50 })
      });
      assert.strictEqual(calls, 1, 'a busy profile is reported at once, never retried');
      assert.strictEqual(out.check.state, 'fail');
    }
    // The v2.1.0 unconfirmed wording reflects the automatic second look.
    assert.ok(/two checks/.test(cookieCheckState('unconfirmed', {}, {}).reason), 'unconfirmed reason says the check ran twice');
  });

  test('activity v2.1.0: detail/stage/reason/task fields stored; copy format carries the full story', () => {
    const { createActivityStore, formatEntryForCopy, formatEntriesForCopy } = require(path.join(ROOT, 'engine', 'activityStore'));
    const kv = new Map();
    const store = { getSetting: (k, d) => (kv.has(k) ? kv.get(k) : d), setSetting: (k, v) => kv.set(k, String(v)) };
    const act = createActivityStore(store, {});
    act.add({
      category: 'errors', level: 'error', message: 'Task FAIL: Prompt #2 — tile not found',
      accountName: 'Solo Account', stage: 'render-wait', taskId: 'task_9', promptIndex: 1,
      reason: 'Generation tile could not be identified',
      detail: 'Credits kat gaye the, tile nahi mili, recovery ke baad fail hua.'
    });
    act.add({ category: 'system', message: 'Purani tarz entry (bina detail)' });
    const entries = act.list();
    const rich = entries.find(e => e.taskId === 'task_9');
    assert.ok(rich, 'entry with detail fields is stored');
    assert.strictEqual(rich.stage, 'render-wait');
    assert.strictEqual(rich.promptIndex, 1);
    const copy = formatEntryForCopy(rich);
    assert.ok(copy.includes('Task FAIL: Prompt #2'), 'copy carries the message');
    assert.ok(copy.includes('Account: Solo Account'), 'copy carries the account');
    assert.ok(copy.includes('Prompt #: 2'), 'copy carries the 1-based prompt number');
    assert.ok(copy.includes('Stage: render-wait'), 'copy carries the stage (kahan ruka)');
    assert.ok(copy.includes('Detail: Credits kat gaye the'), 'copy carries the detail (kya hua)');
    assert.ok(copy.includes('Reason: Generation tile'), 'copy carries the reason (kyun hua)');
    const legacy = entries.find(e => !e.taskId);
    assert.ok(!formatEntryForCopy(legacy).includes('Detail:'), 'older entries copy whatever they have — no invented detail');
    const all = formatEntriesForCopy(entries);
    assert.strictEqual(all.split('\n\n').length, 2, 'copy-all joins entries with a blank line');
  });

  await testAsync('pool v2.1.0: SINGLE account — first attempt fails, same-account backoff retry succeeds; stubborn task capped at 3 submissions', async () => {
    const saDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fslite-solo-'));
    const run = `
      (async () => {
        const { dbService } = require(${JSON.stringify(dbModulePath)});
        await dbService.ensureInit();
        dbService.insertAccount({ id: 'acc_solo', name: 'Solo Account', email: 'solo@example.com', dirName: 'acc_solo', status: 'Ready', credits: 100 });
        const { FlowAutomationEngine } = require(${JSON.stringify(path.join(ROOT, 'engine', 'flowAutomation.js'))});
        const submits = {};
        const waitCalls = {};
        FlowAutomationEngine.prototype.launchBrowserForAccount = async function (account) {
          this.currentAccount = account;
          this.browser = { mock: true };
          this.page = { isClosed: () => false };
          return true;
        };
        FlowAutomationEngine.prototype.openFlowStudio = async function () { return 'READY'; };
        FlowAutomationEngine.prototype.closeBrowser = async function () { this.browser = null; this.page = null; };
        FlowAutomationEngine.prototype.submitPrompt = async function (text, settings, idx) {
          (submits[text] = submits[text] || []).push(this.currentAccount.id);
          return { status: 'SUBMITTED', videoId: 'v_' + idx + '_' + submits[text].length, promptIndex: idx, promptText: text };
        };
        FlowAutomationEngine.prototype.waitForAccountTasks = async function (tasks) {
          for (const t of tasks) {
            if (t.completed || t.downloaded) continue;
            t.completed = true; t.downloaded = true;
            waitCalls[t.promptText] = (waitCalls[t.promptText] || 0) + 1;
            if (t.promptText.includes('always-fails')) {
              t.failed = true; this.onTaskFailed(t, 'Render timed out — no progress');
            } else if (t.promptText.includes('retry-me') && waitCalls[t.promptText] === 1) {
              t.failed = true; this.onTaskFailed(t, 'Render timed out — no progress');
            } else {
              this.onTaskCompleted(t, { filePath: '/tmp/' + t.taskId + '.mp4', fileName: t.taskId + '.mp4', fileSizeMB: '1.0', downloadMethod: 'mock' });
            }
          }
        };
        const { WorkerPool } = require(${JSON.stringify(path.join(ROOT, 'engine', 'workerPool.js'))});
        const settings = { model: 'Omni Flash', duration: '6s', aspectRatio: '9:16', type: 'Video' };
        const pool = new WorkerPool({ concurrency: 1, launchBackoffMs: 1, sameAccountBackoffMs: 25, onLog: () => {}, onProgress: () => {}, onTaskUpdate: () => {} });
        await pool.runQueue(['a normal solo prompt', 'retry-me solo prompt', 'always-fails solo prompt'], settings, ${JSON.stringify(saDir)});
        const rows = {};
        for (const r of dbService.query('SELECT prompt_text, status, assigned_account_id, error_reason FROM queue_tasks')) {
          rows[r.prompt_text] = { status: r.status, account: r.assigned_account_id, error: r.error_reason || '' };
        }
        let activity = [];
        try { activity = JSON.parse(dbService.getSetting('activity_v1', '[]')); } catch (e) {}
        dbService.persistNow();
        const retryEntry = activity.find(a => /Same-account retry/.test(a.message || ''));
        console.log(JSON.stringify({ submits, rows,
          retryEntry: retryEntry ? { stage: retryEntry.stage || null, hasDetail: !!(retryEntry.detail && retryEntry.detail.length > 20), promptIndex: retryEntry.promptIndex } : null
        }));
      })().catch(e => { console.error(e); process.exit(1); });
    `;
    const env = { ...process.env, FLOW_LITE_DATA_DIR: saDir };
    const raw = execFileSync(process.execPath, ['-e', run], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
    const out = JSON.parse(raw.trim().split('\n').pop());
    try {
      assert.deepStrictEqual(out.submits['a normal solo prompt'], ['acc_solo'], 'normal prompt fired once');
      assert.strictEqual(out.rows['a normal solo prompt'].status, 'completed');
      assert.deepStrictEqual(out.submits['retry-me solo prompt'], ['acc_solo', 'acc_solo'], 'with no other account, the failed task retried on the SAME account');
      assert.strictEqual(out.rows['retry-me solo prompt'].status, 'completed', 'the same-account retry completed the task — no dead-end');
      assert.deepStrictEqual(out.submits['always-fails solo prompt'], ['acc_solo', 'acc_solo', 'acc_solo'], 'a stubborn task is capped at 3 submissions on the one account');
      assert.strictEqual(out.rows['always-fails solo prompt'].status, 'failed', 'after the cap the task fails VISIBLY');
      assert.ok(!/no usable account remained/.test(out.rows['always-fails solo prompt'].error), 'the failure reason is the real render failure, not the old dead-end wording');
      assert.ok(out.retryEntry, 'a Same-account retry Activity entry was recorded');
      assert.strictEqual(out.retryEntry.stage, 'failover');
      assert.strictEqual(out.retryEntry.hasDetail, true, 'the retry entry carries the full detail (Fix 5)');
    } finally {
      try { fs.rmSync(saDir, { recursive: true, force: true }); } catch (e) {}
    }
  });

  console.log('\n[17] v2.2.0: paste cookies, add-account shape, history table + delete guard, activity lines, browser mode, fit structure');

  test('cookie paste parse: valid Netscape + JSON accepted; garbage/empty/non-Google rejected by the shared parser', () => {
    const { parseCookieText } = require(path.join(ROOT, 'engine', 'cookieParser'));
    const netscape = [
      '# Netscape HTTP Cookie File',
      ['.google.com', 'TRUE', '/', 'TRUE', '1893456000', 'SID', 'abc123'].join('\t'),
      ['accounts.google.com', 'TRUE', '/', 'TRUE', '1893456000', 'SSID', 'zz'].join('\t'),
      ['.example.com', 'TRUE', '/', 'FALSE', '1893456000', 'OTHER', 'no'].join('\t')
    ].join('\n');
    const out = parseCookieText(netscape);
    assert.strictEqual(out.format, 'netscape');
    assert.strictEqual(out.keptCount, 2, 'only Google cookies are kept');
    assert.ok(!out.cookies.some(c => c.name === 'OTHER'));
    const json = JSON.stringify([{ domain: '.google.com', name: 'SID', value: 'v', path: '/', secure: true, httpOnly: true }]);
    const out2 = parseCookieText(json);
    assert.strictEqual(out2.format, 'json');
    assert.strictEqual(out2.keptCount, 1);
    assert.throws(() => parseCookieText(''), /empty/i);
    assert.throws(() => parseCookieText('bilkul garbage text hai'), /No cookies could be read/);
    assert.throws(() => parseCookieText(['.example.com', 'TRUE', '/', 'FALSE', '1893456000', 'X', 'y'].join('\t')), /No Google cookies/);
    assert.throws(() => parseCookieText('{bad json'), /could not be parsed/);
  });

  await testAsync('cookie paste import: bad paste creates NO account; valid paste creates account + saves cookies, check entered honestly', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fslite-paste-'));
    const run = `
      (async () => {
        const { dbService } = require(${JSON.stringify(dbModulePath)});
        await dbService.ensureInit();
        const ci = require(${JSON.stringify(path.join(ROOT, 'engine', 'cookieImport.js'))});
        const { getCookieStore } = require(${JSON.stringify(path.join(ROOT, 'engine', 'cookieStore.js'))});
        const before = dbService.getAccounts().length;
        const bad = await ci.importAccountFromCookieText({ text: 'ye koi cookie nahi hai', label: 'Bad' });
        const afterBad = dbService.getAccounts().length;
        const txt = ['.google.com', 'TRUE', '/', 'TRUE', '1893456000', 'SID', 'pastevalue'].join('\\t');
        const good = await ci.importAccountFromCookieText({ text: txt, label: 'Paste Acc' });
        const acc = good.account || dbService.getAccounts()[0];
        const saved = acc ? getCookieStore().load(acc.id) : null;
        console.log(JSON.stringify({ before, afterBad, badSuccess: bad.success,
          goodSuccess: good.success, goodError: good.error || '', accName: acc ? acc.name : '',
          savedCount: saved ? saved.length : 0, savedNames: saved ? saved.map(c => c.name) : [] }));
      })().catch(e => { console.error(e); process.exit(1); });
    `;
    const env = { ...process.env, FLOW_LITE_DATA_DIR: dir };
    const raw = execFileSync(process.execPath, ['-e', run], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
    const out = JSON.parse(raw.trim().split('\n').pop());
    try {
      assert.strictEqual(out.badSuccess, false);
      assert.strictEqual(out.afterBad, out.before, 'a bad paste must NOT leave a junk account behind');
      assert.strictEqual(out.accName, 'Paste Acc', 'a valid paste creates the account with the typed label');
      assert.ok(out.savedCount >= 1 && out.savedNames.includes('SID'), 'parsed cookies are saved per-account for Re-check');
      // This test env has no usable Chrome for Flow: the injection/check
      // must fail HONESTLY (never a fake success).
      assert.strictEqual(out.goodSuccess, false);
      assert.ok(/Chrome|cookie/i.test(out.goodError), 'the failure carries a plain reason');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    }
  });

  await testAsync('add-account: optional email stored via the {name,email} shape; deleteHistoryTasks touches ONLY finished rows', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fslite-addel-'));
    const run = `
      (async () => {
        const { dbService } = require(${JSON.stringify(dbModulePath)});
        await dbService.ensureInit();
        const store = require(${JSON.stringify(path.join(ROOT, 'engine', 'accountStore.js'))});
        const a1 = store.addAccount('Naam Wala', 'opt@example.com').account;
        const a2 = store.addAccount('Bina Email').account;
        const tasks = dbService.createBatchTasks('batch_v22', ['p done', 'p fail', 'p pending'], { model: 'Omni Flash', duration: '6s', aspectRatio: '9:16' });
        dbService.completeTask(tasks[0].id, { filePath: '/tmp/x/scene001.mp4', fileName: 'scene001.mp4', fileSizeMb: '2.3 MB' });
        dbService.failTask(tasks[1].id, 'boom');
        const deleted = dbService.deleteHistoryTasks([tasks[0].id, tasks[1].id, tasks[2].id]);
        const pending = dbService.getTask(tasks[2].id);
        console.log(JSON.stringify({ email1: a1.email, email2: a2.email, deleted,
          pendingStatus: pending ? pending.status : 'gone', histCount: dbService.getHistory(10).length }));
      })().catch(e => { console.error(e); process.exit(1); });
    `;
    const env = { ...process.env, FLOW_LITE_DATA_DIR: dir };
    const raw = execFileSync(process.execPath, ['-e', run], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
    const out = JSON.parse(raw.trim().split('\n').pop());
    try {
      assert.strictEqual(out.email1, 'opt@example.com', 'the optional email from the Add modal is stored');
      assert.strictEqual(out.email2, '', 'no email stays empty — it is optional, never required');
      assert.strictEqual(out.deleted, 2, 'completed + failed rows deleted');
      assert.strictEqual(out.pendingStatus, 'pending', 'a pending task is NEVER deleted by the history bulk action');
      assert.strictEqual(out.histCount, 0);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    }
  });

  test('history table mapping: name/folder/size/date/status + search & filters', () => {
    const ht = require(path.join(ROOT, 'engine', 'historyTable'));
    const done = ht.toHistoryRow({
      id: 't1', status: 'completed', file_name: 'scene001_3.mp4',
      file_path: path.join('C:', 'Users', 'x', 'Downloads', 'FlowBatch', 'scene001_3.mp4'),
      file_size_mb: '2.34 MB', completed_at: '2026-10-12 14:11:00', created_at: '2026-10-12 14:00:00',
      prompt_text: 'a tiger in the jungle', prompt_index: 0, assigned_account_name: 'Acc 1'
    });
    assert.strictEqual(done.status, 'done');
    assert.strictEqual(done.statusLabel, 'Done');
    assert.strictEqual(done.name, 'scene001_3.mp4');
    assert.strictEqual(done.folder, 'FlowBatch', 'folder = the output/batch directory name');
    assert.strictEqual(done.sizeText, '2.3 MB');
    assert.ok(/^\d{1,2} [A-Z][a-z]{2}, \d{1,2}:\d{2} [AP]M$/.test(done.dateText), `date shaped like the reference table: ${done.dateText}`);
    assert.strictEqual(done.hasFile, true);
    const failed = ht.toHistoryRow({
      id: 't2', status: 'failed', file_name: '', file_path: '', file_size_mb: '',
      completed_at: '2026-10-12 15:00:00', created_at: '2026-10-12 14:55:00',
      prompt_text: 'a whale underwater', error_reason: 'Render timed out', prompt_index: 1
    });
    assert.strictEqual(failed.status, 'failed');
    assert.strictEqual(failed.reason, 'Render timed out');
    assert.strictEqual(failed.sizeText, '—');
    assert.strictEqual(failed.folder, '—');
    const rows = [done, failed];
    assert.deepStrictEqual(ht.historyFolders(rows), ['FlowBatch']);
    assert.strictEqual(ht.filterHistoryRows(rows, { search: 'whale' }).length, 1, 'search matches the prompt');
    assert.strictEqual(ht.filterHistoryRows(rows, { search: 'SCENE001' }).length, 1, 'search matches the file name, case-insensitive');
    assert.strictEqual(ht.filterHistoryRows(rows, { status: 'done' }).length, 1);
    assert.strictEqual(ht.filterHistoryRows(rows, { status: 'failed' }).length, 1);
    assert.strictEqual(ht.filterHistoryRows(rows, { folder: 'FlowBatch' }).length, 1);
    assert.strictEqual(ht.formatHistorySize('0.05'), '51 KB');
    assert.strictEqual(ht.formatHistorySize(''), '—');
  });

  test('activity v2.2.0: Simple line = [time] icon message; Details line adds account/stage/wajah', () => {
    const { formatEntrySimple, formatEntryDetailLine, levelIcon } = require(path.join(ROOT, 'engine', 'activityStore'));
    assert.strictEqual(levelIcon('success'), '✔');
    assert.strictEqual(levelIcon('warn'), '⚠');
    assert.strictEqual(levelIcon('error'), '✘');
    const e = { time: '07:10 PM', level: 'success', message: 'Download complete: scene001_3.mp4' };
    assert.strictEqual(formatEntrySimple(e), '[07:10 PM] ✔ Download complete: scene001_3.mp4');
    assert.strictEqual(formatEntryDetailLine(e), '[07:10 PM] ✔ Download complete: scene001_3.mp4', 'no story fields — details line equals simple');
    const rich = { time: '07:12 PM', level: 'error', message: 'Cookie check FAIL', accountName: 'Acc 1', stage: 'cookie-check', reason: 'session dead' };
    const line = formatEntryDetailLine(rich);
    assert.ok(line.startsWith('[07:12 PM] ✘ Cookie check FAIL — '), 'details line keeps the simple head');
    assert.ok(line.includes('Account: Acc 1') && line.includes('Stage: cookie-check') && line.includes('Reason: session dead'));
    assert.strictEqual(formatEntrySimple(null), '');
  });

  test('browser mode: background = headed Chrome off-screen, NEVER headless, NEVER minimized (v2.6.0)', () => {
    const bm = require(path.join(ROOT, 'engine', 'browserMode'));
    assert.strictEqual(bm.resolveBackgroundEnabled(undefined), true, 'unset = background ON (the owner default)');
    assert.strictEqual(bm.resolveBackgroundEnabled('1'), true);
    assert.strictEqual(bm.resolveBackgroundEnabled('0'), false, "'0' = visible browser");
    assert.strictEqual(bm.resolveBackgroundEnabled('anything-else'), true);
    // v2.4.0: headless stalled Flow on the owner's PC — background is
    // the SAME headed Chrome, parked off-screen.
    // v2.6.0: the v2.4 minimize is GONE — the owner's v2.5.0 run froze
    // at 1% for 8+ minutes in a minimized window (Chrome throttles
    // occluded windows). The window now stays in the NORMAL state
    // off-screen, with the anti-throttling launch flags.
    const bg = bm.launchPlan(true);
    assert.strictEqual(bg.headless, false, 'background mode is NOT headless');
    assert.strictEqual(bg.windowMode, 'offscreen');
    assert.ok(bg.extraArgs.includes(bm.OFFSCREEN_POSITION), 'off-screen window position arg');
    assert.ok(bg.extraArgs.some(a => a.startsWith('--window-position=-')), 'position is far off any monitor');
    assert.strictEqual(bg.minimizeAfterLaunch, false, 'v2.6.0: the window is NEVER minimized');
    assert.strictEqual(bg.startMaximized, false);
    for (const flag of ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion']) {
      assert.ok(bg.antiThrottleArgs.includes(flag), `background plan carries the anti-throttling flag ${flag}`);
    }
    assert.strictEqual(bg.focusEmulation, true, 'background mode enables CDP focus emulation');
    const vis = bm.launchPlan(false);
    assert.strictEqual(vis.headless, false, 'visible mode is headed too');
    assert.strictEqual(vis.windowMode, 'visible');
    assert.deepStrictEqual(vis.extraArgs, []);
    assert.deepStrictEqual(vis.antiThrottleArgs, [], 'visible mode needs no anti-throttling flags');
    assert.strictEqual(vis.minimizeAfterLaunch, false);
    assert.strictEqual(vis.focusEmulation, false);
    assert.strictEqual(vis.startMaximized, true);
    // The engine consumes exactly this plan at launch:
    const fa = fs.readFileSync(path.join(ROOT, 'engine', 'flowAutomation.js'), 'utf8');
    assert.ok(fa.includes('browserMode.launchPlan(this.headless)'), 'launch builds its plan from browserMode');
    assert.ok(fa.includes('headless: plan.headless'), 'puppeteer receives the plan headless value');
    assert.ok(fa.includes('plan.antiThrottleArgs'), 'launch feeds the anti-throttling flags into the Chrome args');
    assert.ok(fa.includes('Emulation.setFocusEmulationEnabled'), 'background launch enables focus emulation on the page session');
    assert.ok(!fa.includes("windowState: 'minimized'"), 'v2.6.0: the CDP minimize call is GONE (it froze renders)');
    assert.ok(!/headless: this\.headless \? 'new' : false/.test(fa), 'the old headless:new launch is gone');
    const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    assert.ok(mainSrc.includes('browserMode.resolveBackgroundEnabled'), 'createPool feeds the pool from the setting');
  });

  await testAsync('browser mode plumbing: the pool headless flag reaches every engine it creates', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fslite-bg-'));
    const run = `
      (async () => {
        const { dbService } = require(${JSON.stringify(dbModulePath)});
        await dbService.ensureInit();
        dbService.insertAccount({ id: 'acc_bg', name: 'BG', email: 'bg@example.com', dirName: 'acc_bg', status: 'Ready', credits: 100 });
        const { FlowAutomationEngine } = require(${JSON.stringify(path.join(ROOT, 'engine', 'flowAutomation.js'))});
        const seen = [];
        FlowAutomationEngine.prototype.launchBrowserForAccount = async function (account) {
          seen.push(this.headless);
          this.currentAccount = account;
          this.browser = { mock: true };
          this.page = { isClosed: () => false };
          return true;
        };
        FlowAutomationEngine.prototype.openFlowStudio = async function () { return 'READY'; };
        FlowAutomationEngine.prototype.closeBrowser = async function () { this.browser = null; this.page = null; };
        FlowAutomationEngine.prototype.submitPrompt = async function (text, settings, idx) {
          return { status: 'SUBMITTED', videoId: 'v' + idx, promptIndex: idx, promptText: text };
        };
        FlowAutomationEngine.prototype.waitForAccountTasks = async function (tasks) {
          for (const t of tasks) {
            if (t.completed || t.downloaded) continue;
            t.completed = true; t.downloaded = true;
            this.onTaskCompleted(t, { filePath: '/tmp/' + t.taskId + '.mp4', fileName: t.taskId + '.mp4', fileSizeMB: '1.0', downloadMethod: 'mock' });
          }
        };
        const { WorkerPool } = require(${JSON.stringify(path.join(ROOT, 'engine', 'workerPool.js'))});
        const settings = { model: 'Omni Flash', duration: '6s', aspectRatio: '9:16', type: 'Video' };
        const poolBg = new WorkerPool({ concurrency: 1, launchBackoffMs: 1, headless: true, onLog: () => {}, onProgress: () => {}, onTaskUpdate: () => {} });
        await poolBg.runQueue(['bg prompt'], settings, ${JSON.stringify(dir)});
        const poolVis = new WorkerPool({ concurrency: 1, launchBackoffMs: 1, headless: false, onLog: () => {}, onProgress: () => {}, onTaskUpdate: () => {} });
        await poolVis.runQueue(['visible prompt'], settings, ${JSON.stringify(dir)});
        dbService.persistNow();
        console.log(JSON.stringify({ seen }));
      })().catch(e => { console.error(e); process.exit(1); });
    `;
    const env = { ...process.env, FLOW_LITE_DATA_DIR: dir };
    const raw = execFileSync(process.execPath, ['-e', run], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
    const out = JSON.parse(raw.trim().split('\n').pop());
    try {
      assert.ok(out.seen.length >= 2, 'both runs launched an engine');
      assert.strictEqual(out.seen[0], true, 'background run: engine created headless');
      assert.strictEqual(out.seen[out.seen.length - 1], false, 'visible run: engine created headful');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    }
  });

  test('delete-selected guard: the renderer can only reach the delete IPC through the confirm modal', () => {
    const appSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
    const callIdx = appSrc.indexOf('window.api.deleteHistoryTasks');
    assert.ok(callIdx > -1, 'renderer calls the delete IPC');
    assert.strictEqual(appSrc.split('deleteHistoryTasks').length - 1, 1, 'exactly one delete call site');
    const handlerStart = appSrc.lastIndexOf("getElementById('btn-delete-selected')", callIdx);
    const confirmIdx = appSrc.indexOf('showConfirmModal', handlerStart);
    assert.ok(handlerStart > -1 && confirmIdx > handlerStart && confirmIdx < callIdx,
      'the confirm modal is awaited inside the handler BEFORE the delete IPC fires');
    const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    assert.ok(mainSrc.includes('assertAllowedMediaFile'), 'main re-guards every file path before unlinking');
    assert.ok(mainSrc.includes('deleteHistoryTasks(ids)'), 'main deletes records through the guarded db method');
  });

  test('v2.2.0 structure: Import view, history table, activity modes, cookie modal, fit CSS, version sync', () => {
    const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
    for (const id of ['view-import', 'history-tbody', 'history-search', 'history-folder-filter', 'btn-delete-selected',
      'history-check-all', 'activity-mode-seg', 'btn-clear-log', 'cookie-modal-overlay', 'cookie-paste-text',
      'pref-browser-bg', 'modal-input2']) {
      assert.ok(html.includes(`id="${id}"`), `index.html carries #${id}`);
    }
    assert.ok(html.includes('data-view="import"'), 'nav has the Import tab');
    assert.ok(html.includes('id="strip-version">v2.20.0</span>'), 'strip badge is v2.19.0');
    assert.ok(!html.includes('id="history-list"'), 'the old card-style history list is gone (table now)');
    const appSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
    assert.ok(appSrc.includes('FlowStudio Lite v2.20.0'), 'About box is v2.20.0');
    assert.ok(appSrc.includes('importCookieText'), 'paste path wired in the renderer');
    assert.ok(appSrc.includes('Chrome ↗'), 'account cards carry the Chrome ↗ button');
    const css = fs.readFileSync(path.join(ROOT, 'renderer', 'styles.css'), 'utf8');
    assert.ok(/\.main \{[^}]*overflow: hidden/.test(css), 'main never scrolls as a whole (fit-to-screen)');
    assert.ok(css.includes('.scroll-region'), 'internal scroll regions exist');
    assert.ok(css.includes('.history-table'), 'history table styles exist');
    const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    assert.ok(mainSrc.includes("ipcMain.handle('import-cookie-text'"), 'paste IPC handler in main');
    assert.ok(mainSrc.includes("ipcMain.handle('delete-history-tasks'"), 'delete-selected IPC handler in main');
    assert.ok(mainSrc.includes('FLOW_LITE_FIT_TEST'), 'the fit-to-screen boot hook lives in main (run: npm run test:fit)');
    const preloadSrc = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
    assert.ok(/addAccount: \(name, email\) => ipcRenderer\.invoke\('add-account', \{ name/.test(preloadSrc), 'add-account IPC shape is {name, email}');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.version, '2.20.0');
  });

  console.log('\n[18] v2.3.0: smart parser, tag naming, sequence integrity, retry-missing');

  const { parsePromptsAuto, parsePromptsDetailed } = require(path.join(ROOT, 'renderer', 'promptParser'));

  test('parser: scene labels detected (scene1 / Scene 2 / SCENE 03), tags as written', () => {
    const r = parsePromptsAuto('scene1: A lighthouse in a storm\nScene 2 - A drone over a valley\nSCENE 03 A boat on a lake');
    assert.strictEqual(r.style, 'tags');
    assert.strictEqual(r.markerFamily, 'scene');
    assert.deepStrictEqual(r.items.map(i => i.tag), ['scene1', 'Scene 2', 'SCENE 03']);
    assert.deepStrictEqual(r.items.map(i => i.text), ['A lighthouse in a storm', 'A drone over a valley', 'A boat on a lake']);
  });

  test('parser: prompt labels detected (prompt1 / Prompt 2 / PROMPT #3)', () => {
    const r = parsePromptsAuto('prompt1 A cat sleeping\nPrompt 2: A bird flying\nPROMPT #3 A fish swimming');
    assert.strictEqual(r.markerFamily, 'prompt');
    assert.deepStrictEqual(r.items.map(i => i.tag), ['prompt1', 'Prompt 2', 'PROMPT #3']);
    assert.strictEqual(r.items.length, 3);
  });

  test('parser: plain numbers with punctuation (1. / 2) / 3:)', () => {
    const r = parsePromptsAuto('1. A red car\n2) A blue bus\n3: A green train');
    assert.strictEqual(r.markerFamily, 'number');
    assert.deepStrictEqual(r.items.map(i => i.tag), ['1', '2', '3']);
    assert.deepStrictEqual(r.items.map(i => i.text), ['A red car', 'A blue bus', 'A green train']);
  });

  test('parser: number alone on its own line starts the next prompt', () => {
    const r = parsePromptsAuto('1\nA red car in rain\n2\nA dog in a park');
    assert.strictEqual(r.markerFamily, 'number');
    assert.deepStrictEqual(r.items.map(i => i.text), ['A red car in rain', 'A dog in a park']);
  });

  test('parser: #N hash tags detected (#1 / #2 / #03)', () => {
    const r = parsePromptsAuto('#1 A red car in rain\n#2 A dog in a park\n#03 A balloon over hills');
    assert.strictEqual(r.markerFamily, 'hash');
    assert.deepStrictEqual(r.items.map(i => i.tag), ['#1', '#2', '#03']);
  });

  test('parser: #00-01 range tags detected; continuation lines join their prompt', () => {
    const r = parsePromptsAuto('#00-01 A lion runs across the savanna\n#00-02 A tiger sleeps\nunder a big tree\n#00-03 An elephant walks');
    assert.strictEqual(r.markerFamily, 'range');
    assert.deepStrictEqual(r.items.map(i => i.tag), ['#00-01', '#00-02', '#00-03']);
    assert.strictEqual(r.items[1].text, 'A tiger sleeps under a big tree');
  });

  test('parser: bare ascending numbers detected as numbered lines', () => {
    const r = parsePromptsAuto('1 A red car in rain\n2 A dog in a park\n3 A balloon over hills');
    assert.strictEqual(r.markerFamily, 'barenumber');
    assert.deepStrictEqual(r.items.map(i => i.tag), ['1', '2', '3']);
  });

  test('parser: paragraph fallback (blank line) with auto sceneNNN tags', () => {
    const r = parsePromptsAuto('A cinematic shot of a lighthouse\nduring a storm, waves crashing\n\nA drone flyover of a green valley\nat sunrise, mist lifting');
    assert.strictEqual(r.style, 'paragraph');
    assert.deepStrictEqual(r.items.map(i => i.tag), ['01', '02']);
    assert.strictEqual(r.items[0].text, 'A cinematic shot of a lighthouse during a storm, waves crashing');
  });

  test('parser: single-line fallback (one line = one prompt) with auto tags', () => {
    const r = parsePromptsAuto('A red car in the rain\nA dog running in a park\nA balloon over green hills');
    assert.strictEqual(r.style, 'lines');
    assert.deepStrictEqual(r.items.map(i => i.tag), ['01', '02', '03']);
  });

  test('parser: mixed markers — the most consistent family wins, the rest merge as text', () => {
    const r = parsePromptsAuto('scene1 A cat\n#9 A dog\nscene2 A bird\nscene3 A fish');
    assert.strictEqual(r.markerFamily, 'scene');
    assert.strictEqual(r.items.length, 3);
    assert.strictEqual(r.items[0].text, 'A cat #9 A dog', 'the lone #9 line is text inside scene1, not a split');
  });

  test('parser: numbers/hashtags INSIDE a prompt never split it', () => {
    const r = parsePromptsAuto('Ek larka apne dost se kehta hai mera #1 kaam ho gaya\n5 minute baad wo ghar gaya\n\nDusra paragraph bilkul alag hai');
    assert.strictEqual(r.style, 'paragraph', 'no marker family may claim this paste');
    assert.strictEqual(r.items.length, 2);
    assert.ok(r.items[0].text.includes('mera #1 kaam'), 'the #1 dialogue stays inside the prompt');
    assert.ok(r.items[0].text.includes('5 minute baad'), 'the number-led second line stays inside the prompt');
  });

  test('parser: duplicate tags are kept as separate items (naming suffixes them later)', () => {
    const r = parsePromptsAuto('#1 A cat\n#1 A dog');
    assert.strictEqual(r.items.length, 2);
    assert.deepStrictEqual(r.items.map(i => i.tag), ['#1', '#1']);
  });

  test('parser: v2.5.0 two modes (bulk/paragraph) + legacy migration, har item tagged', () => {
    const { normalizePromptMode } = require(path.join(ROOT, 'renderer', 'promptParser'));
    // Mode mapping — purani saved values safe girti hain:
    assert.strictEqual(normalizePromptMode('bulk'), 'bulk');
    assert.strictEqual(normalizePromptMode('paragraph'), 'paragraph');
    assert.strictEqual(normalizePromptMode('auto'), 'bulk', "purana 'auto' -> bulk (smart parser)");
    assert.strictEqual(normalizePromptMode('lines'), 'bulk', "purana 'lines' -> bulk (smart parser lines bhi detect karta hai)");
    assert.strictEqual(normalizePromptMode('blocks'), 'paragraph', "purana 'blocks' -> paragraph");
    assert.strictEqual(normalizePromptMode(undefined), 'bulk', 'default = bulk');
    // Paragraph mode (aur legacy 'blocks' bhi wahi):
    const p = parsePromptsDetailed('one\n\nprompt two', 'paragraph');
    assert.deepStrictEqual(p.items.map(i => i.tag), ['01', '02']);
    assert.deepStrictEqual(parsePromptsDetailed('one\n\nprompt two', 'blocks').items.map(i => i.text), ['one', 'prompt two']);
    // Bulk mode = SMART parser — tags andar detect hote hain:
    const b = parsePromptsDetailed('#07 marker line\nplain line', 'bulk');
    assert.strictEqual(b.items.length, 1, 'bulk me #07 ek tag hai, dusri line usi prompt ka hissa');
    assert.strictEqual(b.items[0].tag, '#07');
    assert.deepStrictEqual(parsePromptsDetailed('#07 marker line\nplain line', 'lines').items.map(i => i.tag), ['#07'], "legacy 'lines' bhi bulk/smart par");
    assert.deepStrictEqual(parsePromptsDetailed('#07 marker line\nplain line', 'auto').items.map(i => i.tag), ['#07'], "legacy 'auto' bhi bulk/smart par");
    assert.strictEqual(parsePromptsAuto('').items.length, 0);
    assert.strictEqual(parsePromptsAuto(null).items.length, 0);
  });

  test('tag naming: sanitize + file names (#00-01 -> #00-01.mp4 as written, scene3 -> scene3.mp4)', () => {
    const { sanitizeTagBase, fileNameForTag } = require(path.join(ROOT, 'engine', 'tagNaming'));
    assert.strictEqual(sanitizeTagBase('#00-01'), '#00-01');
    assert.strictEqual(sanitizeTagBase('scene3'), 'scene3');
    assert.strictEqual(sanitizeTagBase('Scene 1'), 'Scene1');
    assert.strictEqual(sanitizeTagBase('PROMPT #1'), 'PROMPT1');
    assert.strictEqual(sanitizeTagBase(''), '');
    assert.strictEqual(sanitizeTagBase('#'), '');
    assert.strictEqual(fileNameForTag('#00-01'), '#00-01.mp4');
    assert.strictEqual(fileNameForTag('scene3', 'png'), 'scene3.png');
    assert.strictEqual(fileNameForTag(''), null);
    assert.strictEqual(fileNameForTag(null), null);
  });

  test('tag naming: no-overwrite picker — foreign file -> -2, then -3; own save reusable', () => {
    const { pickFreeTagPath } = require(path.join(ROOT, 'engine', 'tagNaming'));
    const dir = '/videos';
    const onDisk = new Set([path.join(dir, '00-01.mp4')]);
    const exists = (p) => onDisk.has(p);
    assert.strictEqual(path.basename(pickFreeTagPath(dir, '00-02.mp4', exists, new Set())), '00-02.mp4', 'free name used as-is');
    assert.strictEqual(path.basename(pickFreeTagPath(dir, '00-01.mp4', exists, new Set())), '00-01-2.mp4', 'foreign 00-01.mp4 protected with -2');
    onDisk.add(path.join(dir, '00-01-2.mp4'));
    assert.strictEqual(path.basename(pickFreeTagPath(dir, '00-01.mp4', exists, new Set())), '00-01-3.mp4', 'next free suffix is -3');
    const own = new Set([path.join(dir, '00-01.mp4')]);
    assert.strictEqual(path.basename(pickFreeTagPath(dir, '00-01.mp4', exists, own)), '00-01.mp4', 'a path this run saved itself may be reused');
  });

  test('tag naming: the ENGINE names by tag in tag mode, falls back to scene, old mode ignores tags', () => {
    const { FlowAutomationEngine } = require(path.join(ROOT, 'engine', 'flowAutomation'));
    const eng = new FlowAutomationEngine({ onLog: () => {} }, {});
    assert.strictEqual(eng._fileNameForTask({ tag: '#00-01', promptIndex: 0 }, { type: 'Video', namingPattern: 'tag' }), '#00-01.mp4');
    assert.strictEqual(eng._fileNameForTask({ tag: 'scene3', promptIndex: 2 }, { type: 'Video', namingPattern: 'tag' }), 'scene3.mp4');
    assert.strictEqual(eng._fileNameForTask({ tag: '', promptIndex: 2 }, { type: 'Video', namingPattern: 'tag' }), 'scene003.mp4', 'no tag -> scene fallback');
    assert.strictEqual(eng._fileNameForTask({ tag: '#00-01', promptIndex: 0 }, { type: 'Video', namingPattern: 'scene' }), 'scene001.mp4', 'scene mode is the old naming, tag ignored');
    // Duplicate protection end-to-end at the engine: tag mode uses
    // the dash suffix, legacy mode keeps its underscore picker.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fslite-tag-'));
    try {
      fs.writeFileSync(path.join(dir, '00-01.mp4'), 'foreign');
      assert.strictEqual(path.basename(eng._resolveSavePath(dir, '00-01.mp4', { namingPattern: 'tag' })), '00-01-2.mp4');
      fs.writeFileSync(path.join(dir, 'scene001.mp4'), 'foreign');
      assert.strictEqual(path.basename(eng._resolveSavePath(dir, 'scene001.mp4', { namingPattern: 'scene' })), 'scene001_2.mp4', 'legacy picker untouched');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    }
  });

  test('sequence report: complete / missing / wrong-name cases from rows + disk truth', () => {
    const { buildSequenceReport, selectMissingItems } = require(path.join(ROOT, 'engine', 'sequenceReport'));
    const dir = '/videos';
    const onDisk = new Set([
      path.join(dir, '#00-01.mp4'),
      path.join(dir, '#00-02.mp4'),
      path.join(dir, 'scene003.mp4') // #00-03's video, wrong name
    ]);
    const exists = (p) => onDisk.has(p);
    const rows = [
      { id: 't1', prompt_text: 'alpha', prompt_index: 0, prompt_tag: '#00-01', status: 'completed', file_path: path.join(dir, '#00-01.mp4'), file_name: '#00-01.mp4' },
      { id: 't2', prompt_text: 'beta', prompt_index: 1, prompt_tag: '#00-02', status: 'completed', file_path: path.join(dir, '#00-02.mp4'), file_name: '#00-02.mp4' },
      { id: 't3', prompt_text: 'gamma', prompt_index: 2, prompt_tag: '#00-03', status: 'completed', file_path: path.join(dir, 'scene003.mp4'), file_name: 'scene003.mp4' },
      { id: 't4', prompt_text: 'delta', prompt_index: 3, prompt_tag: '#00-04', status: 'failed', error_reason: 'Render timed out', file_path: '', file_name: '' },
      { id: 't5', prompt_text: 'epsilon', prompt_index: 4, prompt_tag: '#00-05', status: 'completed', file_path: path.join(dir, '#00-05.mp4'), file_name: '#00-05.mp4' }
    ];
    const rep = buildSequenceReport(rows, { exists, namingMode: 'tag' });
    assert.strictEqual(rep.total, 5);
    assert.strictEqual(rep.presentCount, 2, 'only the two correctly-named existing files are present');
    assert.strictEqual(rep.complete, false);
    assert.deepStrictEqual(rep.wrongName.map(w => w.tag), ['#00-03']);
    assert.strictEqual(rep.wrongName[0].expectedName, '#00-03.mp4');
    assert.strictEqual(rep.wrongName[0].canRename, true, 'canonical name is free -> rename offered');
    assert.deepStrictEqual(rep.missing.map(m => m.tag), ['#00-04', '#00-05'], 'failed task AND vanished-file task are both missing');
    const items = selectMissingItems(rows, rep);
    assert.deepStrictEqual(items, [
      { text: 'delta', tag: '#00-04', index: 3 },
      { text: 'epsilon', tag: '#00-05', index: 4 }
    ], 'retry items carry ONLY the missing prompts with original tags + numbers');
    // All-correct run -> complete.
    const okRep = buildSequenceReport(rows.slice(0, 2), { exists, namingMode: 'tag' });
    assert.strictEqual(okRep.complete, true);
    assert.strictEqual(okRep.presentCount, 2);
    // Canonical occupied by a foreign file -> rename NOT offered.
    onDisk.add(path.join(dir, '#00-03.mp4'));
    const rep2 = buildSequenceReport(rows, { exists, namingMode: 'tag' });
    assert.strictEqual(rep2.wrongName[0].canRename, false);
    // Scene naming mode: names are not judged at all.
    const repScene = buildSequenceReport(rows.slice(0, 3), { exists, namingMode: 'scene' });
    assert.strictEqual(repScene.wrongName.length, 0);
    assert.strictEqual(repScene.presentCount, 3);
  });

  test('history table: rows carry the tag and search matches it', () => {
    const { toHistoryRow, filterHistoryRows } = require(path.join(ROOT, 'engine', 'historyTable'));
    const row = toHistoryRow({
      id: 'h1', status: 'completed', prompt_text: 'a lion runs', prompt_tag: '#00-07',
      file_name: '00-07.mp4', file_path: '/videos/00-07.mp4', file_size_mb: '2.0',
      completed_at: '2026-10-14 10:00:00', prompt_index: 6
    });
    assert.strictEqual(row.tag, '#00-07');
    const hits = filterHistoryRows([row], { search: '#00-07' });
    assert.strictEqual(hits.length, 1, 'searching the tag finds the video');
    assert.strictEqual(filterHistoryRows([row], { search: 'nahi-mila' }).length, 0);
  });

  await testAsync('pool v2.3.0: tags flow to downloads; sequence report finds the miss; retry-missing re-runs ONLY it, same tag + number', async () => {
    const tagDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fslite-tags-'));
    const run = `
      (async () => {
        const fs = require('fs');
        const path = require('path');
        const { dbService } = require(${JSON.stringify(dbModulePath)});
        await dbService.ensureInit();
        dbService.insertAccount({ id: 'acc_tag', name: 'Tag Account', email: 'tag@example.com', dirName: 'acc_tag', status: 'Ready', credits: 100 });
        const { FlowAutomationEngine } = require(${JSON.stringify(path.join(ROOT, 'engine', 'flowAutomation.js'))});
        const { fileNameForTag } = require(${JSON.stringify(path.join(ROOT, 'engine', 'tagNaming.js'))});
        const { buildSequenceReport, selectMissingItems } = require(${JSON.stringify(path.join(ROOT, 'engine', 'sequenceReport.js'))});
        let gammaFixed = false;
        const waitCalls = {};
        FlowAutomationEngine.prototype.launchBrowserForAccount = async function (account) {
          this.currentAccount = account;
          this.browser = { mock: true };
          this.page = { isClosed: () => false };
          return true;
        };
        FlowAutomationEngine.prototype.openFlowStudio = async function () { return 'READY'; };
        FlowAutomationEngine.prototype.closeBrowser = async function () { this.browser = null; this.page = null; };
        FlowAutomationEngine.prototype.submitPrompt = async function (text, settings, idx) {
          return { status: 'SUBMITTED', videoId: 'v_' + idx + '_' + Date.now(), promptIndex: idx, promptText: text };
        };
        FlowAutomationEngine.prototype.waitForAccountTasks = async function (tasks, downloadFolder) {
          for (const t of tasks) {
            if (t.completed || t.downloaded) continue;
            t.completed = true; t.downloaded = true;
            waitCalls[t.promptText] = (waitCalls[t.promptText] || 0) + 1;
            if (t.promptText.includes('gamma') && !gammaFixed) {
              t.failed = true; this.onTaskFailed(t, 'Render timed out — no progress');
            } else {
              const fileName = fileNameForTag(t.tag, 'mp4') || t.taskId + '.mp4';
              const filePath = path.join(downloadFolder, fileName);
              fs.writeFileSync(filePath, 'video');
              this.onTaskCompleted(t, { filePath, fileName, fileSizeMb: '1.0', downloadMethod: 'mock' });
            }
          }
        };
        const { WorkerPool } = require(${JSON.stringify(path.join(ROOT, 'engine', 'workerPool.js'))});
        const settings = { model: 'Omni Flash', duration: '6s', aspectRatio: '9:16', type: 'Video', namingPattern: 'tag' };
        const dir = ${JSON.stringify(tagDir)};
        const pool = new WorkerPool({ concurrency: 1, launchBackoffMs: 1, sameAccountBackoffMs: 25, onLog: () => {}, onProgress: () => {}, onTaskUpdate: () => {} });
        await pool.runQueue([
          { text: 'alpha video one', tag: '#00-01', index: 0 },
          { text: 'beta video two', tag: '#00-02', index: 1 },
          { text: 'gamma video three', tag: '#00-03', index: 2 }
        ], settings, dir);
        const rows1 = dbService.query('SELECT id, prompt_text, prompt_index, prompt_tag, status, file_name, file_path FROM queue_tasks ORDER BY prompt_index ASC');
        const report1 = buildSequenceReport(rows1, { exists: (p) => fs.existsSync(p), namingMode: 'tag' });
        const missingItems = selectMissingItems(rows1, report1);
        gammaFixed = true;
        const pool2 = new WorkerPool({ concurrency: 1, launchBackoffMs: 1, sameAccountBackoffMs: 25, onLog: () => {}, onProgress: () => {}, onTaskUpdate: () => {} });
        await pool2.runQueue(missingItems, settings, dir);
        const rows2 = dbService.query('SELECT prompt_text, prompt_index, prompt_tag, status, file_name FROM queue_tasks ORDER BY rowid ASC');
        dbService.persistNow();
        console.log(JSON.stringify({ rows1, report1: { total: report1.total, presentCount: report1.presentCount, missing: report1.missing.map(m => m.tag), complete: report1.complete }, missingItems, rows2, waitCalls }));
      })().catch(e => { console.error(e); process.exit(1); });
    `;
    const env = { ...process.env, FLOW_LITE_DATA_DIR: tagDir };
    const raw = execFileSync(process.execPath, ['-e', run], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
    const out = JSON.parse(raw.trim().split('\n').pop());
    try {
      assert.deepStrictEqual(out.rows1.map(r => r.prompt_tag), ['#00-01', '#00-02', '#00-03'], 'tags stored on the task rows');
      assert.strictEqual(out.rows1[0].file_name, '#00-01.mp4', 'download named by tag (as written, # kept)');
      assert.strictEqual(out.rows1[1].file_name, '#00-02.mp4');
      assert.strictEqual(out.rows1[2].status, 'failed');
      assert.deepStrictEqual(out.report1.missing, ['#00-03'], 'the sequence report names exactly the missing tag');
      assert.strictEqual(out.report1.presentCount, 2);
      assert.deepStrictEqual(out.missingItems, [{ text: 'gamma video three', tag: '#00-03', index: 2 }], 'retry list = only the missing prompt, original tag + number');
      const gammaRows = out.rows2.filter(r => r.prompt_text === 'gamma video three');
      assert.strictEqual(gammaRows.length, 2, 'original failed row + one retry row');
      const retryRow = gammaRows[1];
      assert.strictEqual(retryRow.status, 'completed', 'the missing scene completed on retry');
      assert.strictEqual(retryRow.prompt_tag, '#00-03', 'retry kept the ORIGINAL tag (no renumbering)');
      assert.strictEqual(retryRow.prompt_index, 2, 'retry kept the ORIGINAL position');
      assert.strictEqual(retryRow.file_name, '#00-03.mp4', 'retried video saved under its tag name (as written)');
      assert.strictEqual(out.rows2.filter(r => r.status === 'completed').length, 3, 'finished videos were not re-run (alpha/beta completed exactly once)');
      assert.strictEqual(out.waitCalls['alpha video one'], 1);
      assert.strictEqual(out.waitCalls['beta video two'], 1);
    } finally {
      try { fs.rmSync(tagDir, { recursive: true, force: true }); } catch (e) {}
    }
  });

  test('v2.3.0 structure: auto parser UI, sequence banner, naming selects, IPC wiring, version sync', () => {
    const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
    for (const id of ['sequence-banner', 'prompt-detect', 'btn-prompt-preview', 'prompt-preview', 'pref-naming']) {
      assert.ok(html.includes(`id="${id}"`), `index.html carries #${id}`);
    }
    assert.ok(html.includes('data-mode="bulk"') && html.includes('data-mode="paragraph"'), 'the two v2.5.0 modes are offered (Bulk default)');
    assert.ok(!html.includes('data-mode="auto"') && !html.includes('data-mode="lines"') && !html.includes('data-mode="blocks"'), 'purane teen mode buttons khatam');
    const appSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
    for (const needle of ['getSequenceReport', 'retryMissingTasks', 'renameTaskFile', 'parseCurrentPrompts', 'Detected:']) {
      assert.ok(appSrc.includes(needle), `app.js wires ${needle}`);
    }
    const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    for (const h of ['get-sequence-report', 'retry-missing-tasks', 'rename-task-file']) {
      assert.ok(mainSrc.includes(`ipcMain.handle('${h}'`), `main carries the ${h} IPC`);
    }
    assert.ok(mainSrc.includes('normalizePromptItems'), 'start-generation normalises {text, tag, index} items');
    const preloadSrc = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
    for (const api of ['getSequenceReport', 'retryMissingTasks', 'renameTaskFile']) {
      assert.ok(preloadSrc.includes(api), `preload exposes ${api}`);
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.version, '2.20.0');
  });

  console.log('\n[19] v2.4.0: short-prompt binding, tile states, heartbeat, duplicate guard, log hygiene, outputs lock, background plan, account rows');

  test('tileState: classifier names generating / failed / ready / absent-active / absent', () => {
    const ts = require(path.join(ROOT, 'engine', 'tileState'));
    assert.strictEqual(ts.classifyTaskTile({ tile: { isFailed: true, isReady: true } }), 'failed', 'failure wins over ready');
    assert.strictEqual(ts.classifyTaskTile({ tile: { isFailed: false, isReady: true } }), 'ready');
    assert.strictEqual(ts.classifyTaskTile({ tile: { isFailed: false, isReady: false, isGenerating: true } }), 'generating');
    assert.strictEqual(ts.classifyTaskTile({ tile: { isFailed: false, isReady: false } }), 'generating', 'a quiet bound tile still counts as rendering');
    assert.strictEqual(ts.classifyTaskTile({ tile: null, anyGenerating: true }), 'absent-active');
    assert.strictEqual(ts.classifyTaskTile({ tile: null, anyGenerating: false }), 'absent');
    // The plain lines the owner reads:
    assert.ok(ts.describeState('generating', { promptIndex: 0, elapsedSec: 75, percentage: '50%' }).includes('generating on Flow'), 'generating line is plain');
    assert.ok(ts.describeState('generating', { promptIndex: 0, elapsedSec: 75 }).includes('1 min 15 s'), 'elapsed is narrated');
    assert.ok(ts.describeState('failed', { promptIndex: 2, elapsedSec: 9 }).includes('marked this video as failed'), 'failed line is immediate, no long wait promised');
    assert.ok(ts.describeState('absent', { promptIndex: 0, elapsedSec: 65 }).includes('has not created any tile'), 'absent line names the likely cause');
    assert.ok(ts.describeState('absent-active', { promptIndex: 0, elapsedSec: 65 }).includes('something is generating on Flow'), 'absent-active line is distinct');
  });

  test('plainError: raw JS errors become plain lines, raw text preserved separately', () => {
    const pe = require(path.join(ROOT, 'engine', 'plainError'));
    const t1 = pe.translateError(new Error("Cannot read properties of null (reading 'evaluate')"));
    assert.strictEqual(t1.known, true);
    assert.ok(t1.plain.includes('page closed or changed midway'), "the owner's exact leaked error is translated");
    assert.ok(t1.raw.includes("reading 'evaluate'"), 'raw text is preserved for copy/details');
    assert.ok(!/Cannot read properties/.test(t1.plain), 'plain line never carries the raw wording');
    assert.ok(pe.translateError('Target closed').plain.includes('Chrome window closed midway'));
    assert.ok(pe.translateError('Waiting for selector ".ProseMirror" failed').plain.includes('did not load fully'));
    assert.ok(pe.translateError('Navigation timeout of 30000 ms exceeded').plain.includes('got stuck while opening'));
    const t5 = pe.translateError('some brand new internal fault xyz');
    assert.strictEqual(t5.known, false);
    assert.strictEqual(t5.plain, pe.GENERIC_PLAIN, 'unknown errors get the honest generic line');
    assert.strictEqual(t5.raw, 'some brand new internal fault xyz');
    assert.strictEqual(pe.translateError('').raw, '');
  });

  test('promptMatch: pending / needs_check / running duplicates are caught, others are not', () => {
    const pm = require(path.join(ROOT, 'engine', 'promptMatch'));
    const rows = [
      { id: 't1', prompt_text: 'Make a Video', status: 'pending', needs_check: 0, prompt_index: 0 },
      { id: 't2', prompt_text: 'a dog running in the park', status: 'pending', needs_check: 1, prompt_index: 1 },
      { id: 't3', prompt_text: 'a cat sleeping', status: 'running', needs_check: 0, prompt_index: 2 },
      { id: 't4', prompt_text: 'a bird flying', status: 'completed', needs_check: 0, prompt_index: 3 },
      { id: 't5', prompt_text: 'an old failed one', status: 'failed', needs_check: 0, prompt_index: 4 }
    ];
    const hits = pm.findPendingDuplicates(
      ['make a video!', 'A DOG RUNNING IN THE PARK', 'a cat sleeping', 'a bird flying', 'a dog running', 'brand new prompt'],
      rows
    );
    assert.deepStrictEqual(hits.map(h => h.index), [0, 1, 2], 'exact + case/punct-normalized matches only');
    assert.strictEqual(hits[0].taskId, 't1');
    assert.strictEqual(hits[1].needsCheck, true, 'the mid-flight (needs_check) one is flagged as such');
    assert.strictEqual(hits[2].status, 'running');
    // {text} item shape (the smart parser's) works too:
    const hits2 = pm.findPendingDuplicates([{ text: 'make a video', tag: '#1' }], rows);
    assert.strictEqual(hits2.length, 1);
    assert.strictEqual(pm.normalizePromptText('  Make   a  VIDEO!! '), 'make a video');
  });

  test('outputs lock v2.4.0: engine always charges x1; the select is gone', () => {
    const { FlowAutomationEngine } = require(path.join(ROOT, 'engine', 'flowAutomation.js'));
    const eng = new FlowAutomationEngine({ onLog: () => {} }, {});
    const base = { model: 'Omni Flash', duration: '6s', type: 'Video' };
    assert.strictEqual(eng.getRequiredCredits({ ...base, outputsCount: 1 }), 6);
    assert.strictEqual(eng.getRequiredCredits({ ...base, outputsCount: 3 }), 6, 'a saved x3 setting is silently read as x1');
    assert.strictEqual(eng.getRequiredCredits({ ...base, outputsCount: 4 }), eng.getRequiredCredits({ ...base, outputsCount: 1 }));
    const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
    assert.ok(!html.includes('id="setting-count"'), 'Generate has no Outputs select');
    assert.ok(!/>Outputs</.test(html), 'no Outputs label remains');
    const appSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
    assert.ok(!appSrc.includes('setting-count'), 'renderer never reads the removed select');
    const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    assert.ok(/outputsCount: 1,/.test(mainSrc), 'main forces outputsCount 1 for every new run');
  });

  test('log dedupe v2.4.0: engine pause/resume/stop are silent; the pool speaks once', () => {
    const { FlowAutomationEngine } = require(path.join(ROOT, 'engine', 'flowAutomation.js'));
    const lines = [];
    const eng = new FlowAutomationEngine({ onLog: (d) => lines.push(d) }, {});
    eng.pause(); eng.resume(); eng.stop();
    assert.strictEqual(lines.length, 0, 'engine pause/resume/stop emit NO log lines (the pool owns those announcements)');
    const fa = fs.readFileSync(path.join(ROOT, 'engine', 'flowAutomation.js'), 'utf8');
    assert.ok(!fa.includes('Queue rok di gayi hai (PAUSED)'), 'old engine pause line removed');
    assert.ok(!fa.includes('The queue has started again (RESUMED).'), 'old engine resume line removed');
    const wp = fs.readFileSync(path.join(ROOT, 'engine', 'workerPool.js'), 'utf8');
    assert.strictEqual((wp.match(/The whole queue has been stopped \(PAUSED\)/g) || []).length, 1, 'exactly one pool pause line exists');
    assert.strictEqual((wp.match(/The queue has started again \(RESUMED\)\./g) || []).length, 1, 'exactly one pool resume line exists');
    assert.strictEqual((wp.match(/The queue has been closed \(STOPPED\)/g) || []).length, 1, 'exactly one pool stop line exists');
  });

  test('v2.4.0 structure: duplicate guard IPC, account rows, heartbeat + state wiring, version sync', () => {
    const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    assert.ok(mainSrc.includes("ipcMain.handle('check-prompt-duplicates'"), 'main carries the duplicate-guard IPC');
    assert.ok(mainSrc.includes('findPendingDuplicates'), 'main matches via engine/promptMatch');
    assert.ok(mainSrc.includes('getOpenTasks'), 'main reads open tasks from the db');
    const preloadSrc = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
    assert.ok(preloadSrc.includes('checkPromptDuplicates'), 'preload exposes checkPromptDuplicates');
    const dbSrc = fs.readFileSync(path.join(ROOT, 'engine', 'db.js'), 'utf8');
    assert.ok(dbSrc.includes('getOpenTasks()'), 'db exposes getOpenTasks');
    assert.ok(dbSrc.includes('videosCount'), 'db accounts carry the videos count for the rows');
    const appSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
    assert.ok(appSrc.includes('checkPromptDuplicates'), 'renderer runs the guard before Generate');
    assert.ok(appSrc.includes('startResumeFlow'), 'the guard can route to Resume');
    assert.ok(appSrc.includes('Resume instead (recommended)'), 'Resume is the modal\u2019s primary (safe) choice');
    assert.ok(appSrc.includes('renderAccountLines') && appSrc.includes('ck-line'), 'accounts render as unified sidebar lines (v2.19.0)');
    assert.ok(appSrc.includes('taskStartTimes'), 'generating rows carry a live elapsed clock');
    const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
    assert.ok(html.includes('id="cookie-lines"'), 'the unified lines box is the accounts container (v2.19.0)');
    assert.ok(!html.includes('id="accounts-list"'), 'old accounts cards list GAYA (v2.19.0)');
    assert.ok(html.includes('id="strip-version">v2.20.0</span>'), 'strip badge is v2.19.0');
    const css = fs.readFileSync(path.join(ROOT, 'renderer', 'styles.css'), 'utf8');
    assert.ok(css.includes('.account-row'), 'row styles exist');
    const fa = fs.readFileSync(path.join(ROOT, 'engine', 'flowAutomation.js'), 'utf8');
    assert.ok(fa.includes('classifyTaskTile'), 'the monitor classifies tile states');
    assert.ok(fa.includes('onTaskHeartbeat'), 'state changes are reported for Activity');
    assert.ok(fa.includes('heartbeatEveryMs'), 'the heartbeat cadence is wired');
    assert.ok(fa.includes('translateError'), 'raw errors are translated before they can reach the log');
    const wp = fs.readFileSync(path.join(ROOT, 'engine', 'workerPool.js'), 'utf8');
    assert.ok(wp.includes('onTaskHeartbeat'), 'the pool turns state changes into Activity entries');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.version, '2.20.0');
  });

  console.log('\n[20] v2.5.0: prompt-entry root cause pin, accounts box, live-only selection, settings concurrency');

  test('v2.5.0 REGRESSION PIN: renderer helper ka naam parser global se kabhi na mile', () => {
    const appSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
    // v2.4.0 ka asal bug: app.js ka top-level `function
    // parsePromptsDetailed` window.parsePromptsDetailed ko overwrite
    // karke khud ko bulata raha (RangeError har keystroke par).
    assert.ok(!/function\s+parsePromptsDetailed\s*\(/.test(appSrc), 'app.js must NOT declare a top-level parsePromptsDetailed (window-global collision)');
    assert.ok(appSrc.includes('function parseCurrentPrompts'), 'renderer helper ka naam alag hai (parseCurrentPrompts)');
    const parserSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'promptParser.js'), 'utf8');
    assert.ok(parserSrc.includes('window.parsePromptsDetailed = parsePromptsDetailed'), 'parser apna window global rakhta hai');
    assert.ok(!parserSrc.includes('window.parseCurrentPrompts'), 'parser renderer helper ko nahi chhoota');
  });

  test('v2.5.0 structure: accounts box, do prompt modes, workers box gaya, version sync', () => {
    const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
    for (const id of ['btn-accounts-sync-selected',
      'btn-accounts-delete-selected', 'btn-accounts-clear-selection', 'accounts-status-line', 'accounts-live-only', 'gen-live-note']) {
      assert.ok(html.includes(`id="${id}"`), `index.html carries #${id}`);
    }
    // v2.19.0: the old accounts filter tabs are GONE — the status
    // buttons above the unified lines (All/Checking/Live/Fail) are
    // the only filter now.
    assert.ok(!html.includes('id="account-filter-seg"'), 'purana accounts filter seg GAYA (v2.19.0)');
    assert.ok(!html.includes('id="accounts-nomatch"'), 'accounts-nomatch GAYA (v2.19.0)');
    assert.ok(!html.includes('data-filter="ready"'), 'purane filter tabs GAYA (v2.19.0)');
    assert.ok(!html.includes('id="setting-concurrency"'), 'Generate se workers select GAYA (Settings-only ab)');
    assert.ok(!html.includes('workers-box'), 'Generate se gold workers box GAYA');
    assert.ok(!html.includes('Accounts khud rotate hote hain'), 'faltu samjhane wala paragraph GAYA');
    assert.ok(html.includes('id="setting-parallel"'), 'Generate VIDEO SETTINGS box me Parallel Browsers control maujood hai (v2.11 final)');
    const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    assert.ok(mainSrc.includes("live_only_accounts"), 'createPool live-only setting padhta hai');
    assert.ok(mainSrc.includes('FLOW_LITE_UI_TEST'), 'the prompt-entry boot UI hook lives in main (run: npm run test:ui)');
    const appSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
    assert.ok(appSrc.includes('lineMatchesFilter'), 'renderer filter predicate wired hai (v2.19.0: unified line filter)');
    assert.ok(appSrc.includes('selectedAccounts'), 'renderer tick-selection wired hai');
    assert.ok(appSrc.includes('readSavedConcurrency'), 'Generate run saved concurrency padhta hai');
  });

  await testAsync('live-only selection: ON = sirf Ready/Low Credits, OFF = purana bartav', async () => {
    const loTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fslite-liveonly-'));
    const script = `
      (async () => {
        const { dbService } = require(${JSON.stringify(dbModulePath)});
        await dbService.ensureInit();
        dbService.insertAccount({ id: 'acc_pending', name: 'Pending', email: 'n@example.com', dirName: 'acc_pending', status: 'Pending', credits: 500 });
        dbService.insertAccount({ id: 'acc_ready', name: 'Ready', email: 'r@example.com', dirName: 'acc_ready', status: 'Ready', credits: 500 });
        dbService.insertAccount({ id: 'acc_low', name: 'Low', email: 'l@example.com', dirName: 'acc_low', status: 'Low Credits', credits: 500 });
        dbService.insertAccount({ id: 'acc_unconf', name: 'Unconf', email: 'u@example.com', dirName: 'acc_unconf', status: 'Unconfirmed', credits: 500 });
        const { WorkerPool } = require(${JSON.stringify(path.join(ROOT, 'engine', 'workerPool.js'))});
        const rows = ['acc_pending', 'acc_ready', 'acc_low', 'acc_unconf'].map(id => dbService.getAccount(id));
        const on = new WorkerPool({ concurrency: 1, liveOnly: true });
        const off = new WorkerPool({ concurrency: 1, liveOnly: false });
        const out = {};
        const pick1 = on._findNextAvailableAccount(rows, 0, new Set(), null);
        out.onFirst = pick1 ? pick1.id : null;
        const blocked = new Set(['acc_ready']);
        const pick2 = on._findNextAvailableAccount(rows, 0, blocked, null);
        out.onSecond = pick2 ? pick2.id : null;
        const pick3 = on._findNextAvailableAccount(rows.filter(r => r.id === 'acc_pending' || r.id === 'acc_unconf'), 0, new Set(), null);
        out.onNoLive = pick3 ? pick3.id : null;
        const pickOff = off._findNextAvailableAccount(rows, 0, new Set(), null);
        out.offFirst = pickOff ? pickOff.id : null;
        out.liveReadySet = [...WorkerPool.LIVE_READY_STATUSES].sort();
        console.log(JSON.stringify(out));
      })().catch(e => { console.error(e); process.exit(1); });
    `;
    const env = { ...process.env, FLOW_LITE_DATA_DIR: loTmpDir };
    const raw = execFileSync(process.execPath, ['-e', script], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const out = JSON.parse(raw.trim().split('\n').pop());
    assert.strictEqual(out.onFirst, 'acc_ready', 'liveOnly ON: Pending wala skip, pehla Live/Ready account');
    assert.strictEqual(out.onSecond, 'acc_low', 'liveOnly ON: Low Credits bhi live-ready hai');
    assert.strictEqual(out.onNoLive, null, 'liveOnly ON: koi live account na ho to koi selection nahi');
    assert.strictEqual(out.offFirst, 'acc_pending', 'liveOnly OFF: purana bartav — pehla eligible account (Pending bhi)');
    assert.deepStrictEqual(out.liveReadySet, ['Low Credits', 'Ready'], 'live-ready ki paribhasha ek hi hai');
    try { fs.rmSync(loTmpDir, { recursive: true, force: true }); } catch (e) {}
  });

  console.log('\n[21] v2.6.0: render-stall watchdog, saaf run status, Accounts sections');
  test('watchdog: 3 minute tak % na badle to EK chetaavni; % badle to ghadi reset', () => {
    const watch = require(path.join(ROOT, 'engine', 'renderProgressWatch'));
    const task = {};
    const T0 = 1000000;
    // Tile mil gayi, generating, 1% — pehli nazar ghadi chalati hai.
    assert.strictEqual(watch.observeProgress(task, { state: 'generating', percentage: '1%', now: T0 }).type, 'none');
    // 2 minute baad bhi wahi % — abhi khamosh.
    assert.strictEqual(watch.observeProgress(task, { state: 'generating', percentage: '1%', now: T0 + 120000 }).type, 'none');
    // Theek 3 minute par — chetaavni, sahi detail ke saath.
    const stalled = watch.observeProgress(task, { state: 'generating', percentage: '1%', now: T0 + 180000, tileText: 'your video is in queue' });
    assert.strictEqual(stalled.type, 'stalled');
    assert.strictEqual(stalled.stuckForSec, 180);
    assert.strictEqual(stalled.lastPct, '1%');
    assert.ok(/queue/.test(stalled.queueHint || ''), 'tile ka queue text hint ban kar aata hai');
    // Dobara poll — doosri chetaavni NAHI (ek episode = ek awaaz).
    assert.strictEqual(watch.observeProgress(task, { state: 'generating', percentage: '1%', now: T0 + 200000 }).type, 'none');
    // % badla — progress, ghadi reset, agli chetaavni ke liye tayaar.
    assert.strictEqual(watch.observeProgress(task, { state: 'generating', percentage: '2%', now: T0 + 210000 }).type, 'progress');
    assert.strictEqual(watch.observeProgress(task, { state: 'generating', percentage: '2%', now: T0 + 210000 + 179000 }).type, 'none');
    assert.strictEqual(watch.observeProgress(task, { state: 'generating', percentage: '2%', now: T0 + 210000 + 180000 }).type, 'stalled', 'naya freeze = nayi chetaavni');
    // % kabhi dikha hi nahi — ghadi pehli nazar se chalti hai, lastPct null.
    const task2 = {};
    watch.observeProgress(task2, { state: 'generating', percentage: null, now: 5000 });
    const s2 = watch.observeProgress(task2, { state: 'generating', percentage: null, now: 5000 + 180000 });
    assert.strictEqual(s2.type, 'stalled');
    assert.strictEqual(s2.lastPct, null);
    // Generating na ho to ghadi reset — wapas aane par poora budget phir se.
    const task3 = {};
    watch.observeProgress(task3, { state: 'generating', percentage: '5%', now: 0 });
    assert.strictEqual(watch.observeProgress(task3, { state: 'absent', percentage: null, now: 100000 }).type, 'none');
    watch.observeProgress(task3, { state: 'generating', percentage: '5%', now: 100001 });
    assert.strictEqual(watch.observeProgress(task3, { state: 'generating', percentage: '5%', now: 100001 + 179000 }).type, 'none', 'state badalne ke baad ghadi nayi banti hai');
    // Queue-hint shabdkosh:
    assert.strictEqual(watch.queueHintFromText('a calm meadow at dawn'), null);
    assert.ok(/high-demand/.test(watch.queueHintFromText('High demand right now') || ''));
    assert.strictEqual(watch.DEFAULT_STALL_AFTER_MS, 180000, 'production budget 3 minute hai');
  });

  test('run status: saaf shabd, sirf is run ki ginati, purana (2/4) fraction gaya', () => {
    const { WorkerPool } = require(path.join(ROOT, 'engine', 'workerPool'));
    // Owner ka asal case: 2 prompts, 2 ban rahe hain — purana text
    // "Running (2/4)" dikhata tha jahan 4 burst ki seema thi.
    assert.strictEqual(
      WorkerPool.buildRunStatusText({ total: 2, active: 2, done: 0, failed: 0 }),
      'Running — 2 generating · 0 complete · total 2 prompts'
    );
    assert.strictEqual(
      WorkerPool.buildRunStatusText({ total: 5, active: 1, done: 3, failed: 1 }),
      'Running — 1 generating · 3 complete · total 5 prompts · 1 fail'
    );
    assert.ok(!WorkerPool.buildRunStatusText({ total: 9, active: 9, done: 0, failed: 0 }).includes('/'), 'status me koi fraction nahi bacha');
    const wp = fs.readFileSync(path.join(ROOT, 'engine', 'workerPool.js'), 'utf8');
    assert.ok(!wp.includes('Running (${activeWorkerTasks.length'), 'burst-fraction status template gaya');
    assert.ok(wp.includes('buildRunStatusText(runStats)'), 'pool status is builder se banta hai');
    assert.ok(wp.includes("stage: 'render-stall'"), 'pool watchdog ko render-stall Activity me badalta hai');
    assert.ok(wp.includes('onRenderStall'), 'pool engine ko onRenderStall deta hai');
    const fa = fs.readFileSync(path.join(ROOT, 'engine', 'flowAutomation.js'), 'utf8');
    assert.ok(fa.includes('renderProgressWatch.observeProgress'), 'monitor watchdog ko har poll par bulata hai');
  });

  test('v2.10.0 structure: sidebar VERTICAL BOX (ZDola) — accounts sections sidebar me, alag Accounts view gaya', () => {
    const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
    // Alag Accounts PAGE khatam — nav me accounts nahi, view bhi nahi.
    assert.ok(!html.includes('id="view-accounts"'), 'alag Accounts view gaya');
    assert.ok(!html.includes('data-view="accounts"'), 'nav se Accounts button gaya');
    // Saare accounts sections SIDEBAR ke andar hain, ZDola ki tartib me.
    const side = html.slice(html.indexOf('<aside class="sidebar">'), html.indexOf('</aside>'));
    assert.ok(side.includes('accounts-box side-box'), 'sidebar me vertical accounts box hai');
    assert.ok(!side.includes('Your Accounts'), 'v2.11 final: Your Accounts heading text gaya');
    assert.ok(side.includes('side-tabs'), 'v2.11 final: Generate/Settings tabs box ke andar hain');
    assert.ok(side.includes('id="btn-select-all-accounts"'), 'ZDola-style Select all link');
    assert.ok(side.includes('accounts-add-bar'), 'box ke upar bada add-account ilaaka');
    assert.ok(side.includes('accounts-action-grid'), 'neeche do-column action grid');
    assert.ok(!side.includes('rotation-box'), 'v2.11 final: Account rotation section GAYA');
    assert.ok(side.includes('id="btn-add-account"') && side.includes('id="btn-import-cookie"'), 'dono add buttons box ke andar (ids barkarar)');
    assert.ok(side.includes('id="btn-sync-all"'), 'Verify All grid me maujood (id barkarar)');
    assert.ok(!side.includes('id="side-stats-line"'), 'v2.19.0: purani stats line GAYA (totals sirf strip me)');
    assert.ok(!side.includes('id="accounts-list"'), 'v2.19.0: purana cards list GAYA — ek hi unified lines box');
    // Tartib: head → add-bar → status buttons → lines → action grid.
    const order = ['side-tabs', 'side-box-head', 'accounts-add-bar', 'cookie-filter-seg', 'cookie-lines', 'accounts-action-grid'];
    for (let i = 1; i < order.length; i++) {
      assert.ok(side.indexOf(order[i - 1]) > -1 && side.indexOf(order[i - 1]) < side.indexOf(order[i]), `box ki tartib: ${order[i - 1]} < ${order[i]}`);
    }
    // Generate ab default (active) view hai.
    assert.ok(html.includes('<section id="view-generate" class="view active">'), 'Generate default active view');
    const appSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
    assert.ok(appSrc.includes('not confirmed'), 'status line me not-confirmed ginati');
    assert.ok(appSrc.includes('of ${counts.all} selected'), 'status line English me (v2.11)');
    assert.ok(appSrc.includes('btn-select-all-accounts'), 'Select all ki wiring app.js me hai');
    assert.ok(appSrc.includes('side-stats-line'), 'refreshDashboard stats line likhta hai');
    assert.ok(!appSrc.includes('dash-total'), 'purani dash cards ki references gayi');
    const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    assert.ok(mainSrc.includes("const views = ['generate', 'history', 'activity', 'import', 'settings']"), 'fit hook ke views me accounts nahi');
    assert.ok(html.includes('id="strip-version">v2.20.0</span>'), 'strip badge v2.19.0');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.version, '2.20.0');
  });

  console.log('\n[22] v2.7.0: download kai-ranneeti, download-fail = resubmit NAHI, log saafai, accounts ginati');

  test('v2.7.0 structure: download orchestrator + retry + stage + ginati line + fit teen sizes', () => {
    const fa = fs.readFileSync(path.join(ROOT, 'engine', 'flowAutomation.js'), 'utf8');
    assert.ok(fa.includes('downloadTaskMedia'), 'engine me download orchestrator hai');
    assert.ok(fa.includes('retryDownloadForTask'), 'engine me sirf-download retry hai');
    assert.ok(fa.includes('_nativeEditorForm') && fa.includes('_nativeMenuForm'), 'native UI ke roop hain (editor/menu)');
    // v2.8.0 (inspection hissa 2): hover wala roop GAYA — tile par
    // hover se download button aata hi nahi; purana assert ulta kiya.
    assert.ok(!fa.includes('_nativeHoverForm'), 'hover download roop hata diya gaya (inspection: hover par download hota hi nahi)');
    assert.ok(fa.includes('_findEditorDownloadControl'), 'editor ki top bar ke "Download media" ka finder hai');
    assert.ok(fa.includes('currentSrc'), 'tile ke video element ka currentSrc bhi padha jata hai');
    assert.ok(fa.includes("task.failureStage = 'download'"), 'monitor download fail par stage lagata hai');
    assert.ok(fa.includes('task.mediaSaved'), 'asal success ka nishan mediaSaved hai');
    assert.ok(!fa.includes('Video ban raha hai: ${bestTile.percentage}'), 'purani do-foldi % wali log line BAND hai (progress ki ek hi awaaz)');
    for (const eng of ['Clicking Flow Settings Pill', 'Switching Mode to', 'Selecting AI Model', 'Focusing prompt editor', 'Inserting prompt:', 'no longer on the canvas', 'Native download timed out', 'identity-verified sources exhausted']) {
      assert.ok(!fa.includes(eng), `angrezi technical log line gayi: ${eng}`);
    }
    const wp = fs.readFileSync(path.join(ROOT, 'engine', 'workerPool.js'), 'utf8');
    assert.ok(wp.includes('deferredDownloadRetries'), 'pool me download-retry ki deferred list hai');
    assert.ok(wp.includes("opts.stage === 'download'"), 'pool failure ka stage padhta hai');
    assert.ok(wp.includes('Limit (from Settings):'), 'pool run-start par saaf ginati bolta hai');
    assert.ok(wp.includes('liveAccounts: pool.length'), 'progress payload me live ginati jati hai');
    const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
    assert.ok(html.includes('gen-settings-grid'), 'Generate me compact settings grid hai');
    assert.ok(!html.includes('id="setting-folder"') && html.includes('id="pref-folder"'), 'v2.20.0: folder kataar ab Settings me hai, Generate par OUTPUT box nahi');
    assert.ok(html.includes('id="gen-live-note" class="run-accounts-line"'), 'ginati line pinned footer me hai');
    assert.ok(fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8').includes('Parallel browsers: ${seema} · Mode:'), 'ginati line ki tay shakal (v2.11 English) app.js me hai');
    const appSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
    assert.ok(appSrc.includes('renderGenAccountsLine'), 'renderer ginati line ko pool ki ginati se taaza karta hai');
    const fit = fs.readFileSync(path.join(ROOT, 'tests', 'fitcheck.js'), 'utf8');
    assert.ok(fit.includes('1000x650'), 'fit test ab teen sizes par hai (1000x650 samet)');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.version, '2.20.0');
  });

  test('failover stage: download fail ki pehchan (kind download) barkarar', () => {
    const failoverMod = require(path.join(ROOT, 'engine', 'failover'));
    const cls = failoverMod.classifyFailure('Download failed: video ban gaya tha, lekin file save nahi ho payi');
    assert.strictEqual(cls.kind, 'download', 'download wajah kind=download me aati hai');
    assert.strictEqual(cls.eligible, true);
  });

  await testAsync('pool v2.7.0: download fail = resubmit KABHI nahi (submit count pin) + 2-worker saboot', async () => {
    const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fslite-dlretry-'));
    const run = `
      (async () => {
        const { dbService } = require(${JSON.stringify(dbModulePath)});
        await dbService.ensureInit();
        for (const [id, name] of [['acc_dl1', 'DL One'], ['acc_dl2', 'DL Two']]) {
          dbService.insertAccount({ id, name, email: id + '@example.com', dirName: id, status: 'Ready', credits: 500 });
        }
        const { FlowAutomationEngine } = require(${JSON.stringify(path.join(ROOT, 'engine', 'flowAutomation.js'))});
        const submits = {};
        const retryCalls = {};
        let retryMode = 'downloaded';
        FlowAutomationEngine.prototype.launchBrowserForAccount = async function (account) {
          this.currentAccount = account;
          this.browser = { mock: true };
          this.page = { isClosed: () => false };
          return true;
        };
        FlowAutomationEngine.prototype.openFlowStudio = async function () { return 'READY'; };
        FlowAutomationEngine.prototype.closeBrowser = async function () { this.browser = null; this.page = null; };
        FlowAutomationEngine.prototype.submitPrompt = async function (text, settings, idx) {
          (submits[text] = submits[text] || []).push(this.currentAccount.id);
          return { status: 'SUBMITTED', videoId: 'v_' + idx + '_' + text.length, promptIndex: idx, promptText: text };
        };
        FlowAutomationEngine.prototype.waitForAccountTasks = async function (tasks) {
          for (const t of tasks) {
            if (t.completed || t.downloaded) continue;
            t.completed = true; t.downloaded = true;
            if (t.promptText.includes('dl-fail')) {
              t.failed = true;
              t.failureStage = 'download';
              t.downloadAttempts = [
                { strategy: 'tile-src', ok: false, note: 'tile par media URL nahi mila' },
                { strategy: 'native-editor', ok: false, note: 'editor toolbar par download button nahi mila' }
              ];
              this.onTaskFailed(t, 'Download failed: video ban gaya tha, lekin file save nahi ho payi');
            } else {
              this.onTaskCompleted(t, { filePath: '/tmp/' + t.taskId + '.mp4', fileName: t.taskId + '.mp4', fileSizeMb: '1.0', videoUrl: '' });
            }
          }
        };
        FlowAutomationEngine.prototype.retryDownloadForTask = async function (task) {
          retryCalls[task.promptText] = (retryCalls[task.promptText] || 0) + 1;
          if (retryMode === 'downloaded') {
            this.onTaskCompleted(task, { filePath: '/tmp/retry-' + task.taskId + '.mp4', fileName: 'retry-' + task.taskId + '.mp4', fileSizeMb: '1.0', videoUrl: '' });
            return { status: 'downloaded', attempts: [{ strategy: 'native-menu', ok: true, note: 'menu se file aa gayi' }] };
          }
          if (retryMode === 'missing') return { status: 'tile-missing', attempts: [] };
          return { status: 'download-failed', attempts: [{ strategy: 'tile-src', ok: false, note: 'URL nahi mila' }] };
        };
        const { WorkerPool } = require(${JSON.stringify(path.join(ROOT, 'engine', 'workerPool.js'))});
        const settings = { model: 'Omni Flash', duration: '6s', aspectRatio: '9:16', type: 'Video' };
        const logs = [];
        const progress = [];
        const mkPool = (concurrency) => new WorkerPool({ concurrency, launchBackoffMs: 1, onLog: (d) => logs.push(d.message), onProgress: (d) => progress.push(d), onTaskUpdate: () => {} });

        retryMode = 'downloaded';
        await mkPool(1).runQueue(['ek dl-fail prompt jo retry me banega'], settings, ${JSON.stringify(dlDir)});
        retryMode = 'missing';
        await mkPool(1).runQueue(['ek dl-fail prompt jiska render kho gaya'], settings, ${JSON.stringify(dlDir)});
        retryMode = 'stillfails';
        await mkPool(1).runQueue(['ek dl-fail prompt jiska download baaki hai'], settings, ${JSON.stringify(dlDir)});
        await mkPool(2).runQueue(['worker check pehla prompt', 'worker check dusra prompt'], settings, ${JSON.stringify(dlDir)});

        const rows = {};
        for (const r of dbService.query('SELECT prompt_text, status, needs_check, error_reason FROM queue_tasks')) {
          rows[r.prompt_text] = { status: r.status, needs_check: r.needs_check, error: r.error_reason || '' };
        }
        let activity = [];
        try { activity = JSON.parse(dbService.getSetting('activity_v1', '[]')); } catch (e) {}
        dbService.persistNow();
        console.log(JSON.stringify({
          submits, retryCalls, rows, logs,
          startLine2: logs.some(l => l.includes('Limit (from Settings): 2') && l.includes('Live available: 2')),
          progress2: progress.some(p => p.seema === 2 && p.liveAccounts === 2 && p.workersActive === 2),
          dlStageEntries: activity.filter(a => a.stage === 'download').length,
          dlFailEntry: activity.some(a => a.stage === 'download' && /^Download fail:/.test(a.message || '')),
          lostEntry: activity.some(a => a.stage === 'download' && /^Lost render:/.test(a.message || ''))
        }));
      })().catch(e => { console.error(e); process.exit(1); });
    `;
    const env = { ...process.env, FLOW_LITE_DATA_DIR: dlDir };
    const raw = execFileSync(process.execPath, ['-e', run], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
    const out = JSON.parse(raw.trim().split('\n').pop());
    try {
      // Scenario 1: download fail → sirf-download retry safal.
      const p1 = 'ek dl-fail prompt jo retry me banega';
      assert.deepStrictEqual(out.submits[p1], ['acc_dl1'], 'download fail ke baad prompt EK hi baar submit hua (dobara charge zero)');
      assert.strictEqual(out.retryCalls[p1], 1, 'sirf-download retry ek baar chala');
      assert.strictEqual(out.rows[p1].status, 'completed', 'download-retry safal → task completed');
      assert.strictEqual(out.rows[p1].needs_check, 0, 'safal retry ke baad needs_check saaf');
      // Scenario 2: tile gayab → lost-render fail, phir bhi resubmit nahi.
      const p2 = 'ek dl-fail prompt jiska render kho gaya';
      assert.deepStrictEqual(out.submits[p2], ['acc_dl1'], 'lost-render par bhi submit count 1 hi raha');
      assert.strictEqual(out.rows[p2].status, 'failed', 'tile gayab → task fail (lost render)');
      assert.ok(/lost render/i.test(out.rows[p2].error), 'fail ki wajah me lost render saaf likha hai');
      // Scenario 3: tile hai, download phir fail → pending + needs_check.
      const p3 = 'ek dl-fail prompt jiska download baaki hai';
      assert.deepStrictEqual(out.submits[p3], ['acc_dl1'], 'download baaki wale par bhi submit count 1');
      assert.strictEqual(out.rows[p3].status, 'pending', 'tile maujood + download fail → task fail NAHI, pending rehta hai');
      assert.strictEqual(out.rows[p3].needs_check, 1, 'task needs_check (download-retry) me hai');
      assert.ok(out.logs.some(l => l.includes('download is still remaining')), 'run ke aakhir me sach wali note line aayi');
      // Scenario 4: 2 accounts + seema 2 → 2 workers asal me chale.
      const w1 = out.submits['worker check pehla prompt'] || [];
      const w2 = out.submits['worker check dusra prompt'] || [];
      assert.strictEqual(w1.length, 1, 'worker-check prompt 1 ek baar submit');
      assert.strictEqual(w2.length, 1, 'worker-check prompt 2 ek baar submit');
      assert.notStrictEqual(w1[0], w2[0], 'do prompts DO alag accounts par gaye — 2 workers sach me parallel chale');
      assert.ok(out.startLine2, 'run-start log line me saaf ginati: Seema 2 · Live uplabdh 2');
      assert.ok(out.progress2, 'progress payload me seema=2, liveAccounts=2, workersActive=2 gaya');
      // Activity: download stage ki entries.
      assert.ok(out.dlStageEntries >= 3, `download stage ki Activity entries aayi (${out.dlStageEntries})`);
      assert.ok(out.dlFailEntry, 'Activity me "Download fail" entry (stage download) hai');
      assert.ok(out.lostEntry, 'Activity me "Lost render" entry (stage download) hai');
    } finally {
      try { fs.rmSync(dlDir, { recursive: true, force: true }); } catch (e) {}
    }
  });

  console.log('\n[23] v2.8.0: backend network capture (workflowId/FIFE), backend-first download, hover hata, exact labels');

  test('networkCapture: patterns + extraction (inspection hissa 1 VERIFIED)', () => {
    const nc = require(path.join(ROOT, 'engine', 'networkCapture.js'));
    assert.ok(nc.CAPTURE_PATTERNS.apiHosts.includes('aisandbox-pa.googleapis.com'), 'API host aisandbox-pa.googleapis.com hai');
    assert.ok(nc.CAPTURE_PATTERNS.mediaHosts.includes('googleusercontent.com'), 'FIFE media host googleusercontent.com hai');
    assert.ok(nc.CAPTURE_PATTERNS.idFieldNames.includes('workflowId'), 'pehchan ka field workflowId hai');
    // FIFE link bina .mp4 extension ke bhi media hai (host se pehchan).
    assert.strictEqual(nc.isMediaUrl('https://lh3.googleusercontent.com/a1b2c3d4e5=s0'), true, 'bina extension wala FIFE link media hai');
    assert.strictEqual(nc.isMediaUrl('https://cdn.example.com/x/video.mp4'), true, 'generic .mp4 link bhi media hai');
    assert.strictEqual(nc.isMediaUrl('https://flow.google.com/project/abc'), false, 'aam page URL media NAHI hai');
    // grpc-web ke binary frame jaisi text se bhi URL/ID nikalta hai.
    const frame = '\x00\x01\xff{"workflowId": "wf_frame1"}\x00https://lh3.googleusercontent.com/zz99=s0\x00\x02';
    const urls = nc.extractUrlsFromText(frame);
    assert.ok(urls.some(u => u.includes('googleusercontent.com')), 'binary frame se FIFE URL nikla');
    assert.deepStrictEqual(nc.extractWorkflowIdsFromText(frame), ['wf_frame1'], 'binary frame se workflowId nikla');
    // JSON deep-walk: media field ka naam kuch bhi ho, link milta hai.
    const body = Buffer.from(JSON.stringify({ workflow_id: 'wf_deep1', result: { outputs: [{ mediaUri: 'https://lh3.googleusercontent.com/deep=s0' }] } }), 'utf8');
    const found = nc.scanBodyForCapture(body);
    assert.ok(found.ids.includes('wf_deep1'), 'JSON walk: workflow_id (snake) se ID mila');
    assert.ok(found.mediaUrls.some(u => u.includes('deep=s0')), 'JSON walk: alag field-naam (mediaUri) se bhi link mila');
  });

  test('networkCapture: workflowId bandhan + ulte kram me bhi sahi pehchan', () => {
    const ncMod = require(path.join(ROOT, 'engine', 'networkCapture.js'));
    const fired = [];
    const cap = new ncMod.NetworkCapture({ onMediaBound: (k, u, v) => fired.push([k, u, v]) });
    const apiUrl = 'https://aisandbox-pa.googleapis.com/v1/flow';
    cap.beginSubmission('kA', 1000);
    cap.beginSubmission('kB', 2000);
    cap.ingestResponse({ url: apiUrl, bodyBuffer: Buffer.from('{"workflowId":"wf_AAAAAA"}'), at: 3000 });
    cap.ingestResponse({ url: apiUrl, bodyBuffer: Buffer.from('{"workflowId":"wf_BBBBBB"}'), at: 4000 });
    assert.strictEqual(cap.keyById.get('wf_AAAAAA'), 'kA', 'pehla ID pehle submission se bandha');
    assert.strictEqual(cap.keyById.get('wf_BBBBBB'), 'kB', 'dusra ID dusre submission se bandha');
    // ULTA KRAM: B pehle complete hota hai — phir bhi B ka link B ko hi.
    cap.ingestResponse({ url: apiUrl, bodyBuffer: Buffer.from('{"workflowId":"wf_BBBBBB","videoUrl":"https://lh3.googleusercontent.com/BBB=s0"}'), at: 5000 });
    assert.strictEqual(cap.urlForKey('kB').url, 'https://lh3.googleusercontent.com/BBB=s0', 'ulte kram: B ka link B se bandha');
    assert.strictEqual(cap.urlForKey('kA'), null, 'ulte kram: A abhi bandha nahi');
    cap.ingestResponse({ url: apiUrl, bodyBuffer: Buffer.from('{"workflowId":"wf_AAAAAA","videoUrl":"https://lh3.googleusercontent.com/AAA=s0"}'), at: 6000 });
    assert.strictEqual(cap.urlForKey('kA').url, 'https://lh3.googleusercontent.com/AAA=s0', 'ulte kram: A ka link A se bandha (galat video kabhi nahi)');
    assert.strictEqual(fired.length, 2, 'onMediaBound do baar chala (har bandhan par ek)');
    assert.deepStrictEqual(fired[0], ['kB', 'https://lh3.googleusercontent.com/BBB=s0', 'workflow-id'], 'pehla bandhan B ka, via workflow-id');
  });

  test('networkCapture: hifazat — purana link kabhi nahi, kram sirf kataar ke aage wale ko, currentSrc pushti', () => {
    const ncMod = require(path.join(ROOT, 'engine', 'networkCapture.js'));
    // (a) Submit se PEHLE dekha gaya link us task ko kabhi nahi milta.
    const capA = new ncMod.NetworkCapture({});
    capA.ingestResponse({ url: 'https://lh3.googleusercontent.com/OLD=s0', bodyBuffer: null, at: 500 });
    capA.beginSubmission('kX', 100000);
    assert.strictEqual(capA.claimByOrder('kX', 101000), null, 'submit se pehle ka link kram se bhi NAHI milta (purana project)');
    // (b) Kram: kataar me peeche wala task aage wale ka link nahi le sakta.
    const capB = new ncMod.NetworkCapture({});
    capB.beginSubmission('k1', 1000);
    capB.beginSubmission('k2', 2000);
    capB.ingestResponse({ url: 'https://lh3.googleusercontent.com/NEW=s0', bodyBuffer: null, at: 3000 });
    assert.strictEqual(capB.claimByOrder('k2', 3500), null, 'kram: peeche wala task (k2) aage wale ka link nahi le sakta');
    const got = capB.claimByOrder('k1', 3500);
    assert.ok(got && got.url.includes('NEW=s0') && got.via === 'order', 'kram: sabse aage wala task (k1) bin-bandha link leta hai');
    // (c) currentSrc pushti: bina submission wali key kuch nahi le sakti.
    const capC = new ncMod.NetworkCapture({});
    capC.beginSubmission('kk', 1000);
    capC.ingestResponse({ url: 'https://lh3.googleusercontent.com/CS=s0', bodyBuffer: null, at: 2000 });
    assert.strictEqual(capC.claimByCurrentSrc('anjaan-key', 'https://lh3.googleusercontent.com/CS=s0', 2500), null, 'currentSrc: bina submission wali key ko kuch nahi');
    const cs = capC.claimByCurrentSrc('kk', 'https://lh3.googleusercontent.com/CS=s0', 2500);
    assert.ok(cs && cs.via === 'currentSrc', 'currentSrc: network par dekha link tile ki pushti se bandha');
  });

  test('v2.8.0 structure: capture wiring + backend-first tartib + exact labels + version', () => {
    const fa = fs.readFileSync(path.join(ROOT, 'engine', 'flowAutomation.js'), 'utf8');
    assert.ok(fa.includes("require('./networkCapture')"), 'engine networkCapture jodta hai');
    assert.ok(fa.includes('netCapture.attach'), 'launch par capture listeners lagte hain');
    assert.ok(fa.includes('netCapture.detach'), 'band hone par capture listeners saaf hote hain');
    const beginAt = fa.indexOf('netCapture.beginSubmission');
    const fireAt = fa.indexOf('Firing Generation');
    assert.ok(beginAt > -1 && fireAt > -1 && beginAt < fireAt, 'capture submission se PEHLE armed hota hai (beginSubmission fire se pehle)');
    assert.ok(fa.includes('captureKey: videoId'), 'submit ka natija captureKey le jata hai');
    assert.ok(fa.includes('_tryBackendDownload'), 'backend download ki ranneeti hai');
    const orchAt = fa.indexOf('async _downloadTaskMediaInner');
    assert.ok(orchAt > -1 && fa.indexOf('await this._tryBackendDownload', orchAt) > -1 && fa.indexOf('await this._tryBackendDownload', orchAt) < fa.indexOf('await this._downloadViaNativeUi', orchAt), 'orchestrator me backend UI se PEHLE aata hai');
    // v2.10.0: matcher ab saaf karke pehchanta hai — asal menu item
    // ke icon ligature text ki wajah se raw exact match owner ke PC
    // par tootta tha; nishana wahi exact "Download" item hi hai.
    assert.ok(fa.includes("hasWord(full, 'download')"), 'menu ka matcher saaf karke "Download" pehchanta hai (v2.10.0)');
    assert.ok(fa.includes("includes('download media')"), 'editor ka matcher "Download media" hai (inspection hissa 2)');
    const wp = fs.readFileSync(path.join(ROOT, 'engine', 'workerPool.js'), 'utf8');
    assert.ok(wp.includes('onBackendMedia'), 'pool backend bandhan ko Activity me badalta hai');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.version, '2.20.0');
  });

  await testAsync('engine v2.8.0: backend bandhan se seedha download + fetch-fail par grid ki taraf (submit engine se bahar hi nahi)', async () => {
    const { FlowAutomationEngine } = require(path.join(ROOT, 'engine', 'flowAutomation.js'));
    const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fslite-backend-'));
    try {
      // (a) Bandha hua backend link: downloadTaskMedia seedha backend se jeet-ti hai, native UI chalta hi nahi.
      const eng = new FlowAutomationEngine({ onLog: () => {} }, {});
      let nativeCalled = false;
      eng._downloadViaNativeUi = async () => { nativeCalled = true; return false; };
      eng.downloadFromCapturedStream = async (t) => { t.mediaSaved = true; t.downloaded = true; t.completed = true; return true; };
      const task = {
        videoId: 'cap_k1', captureKey: 'cap_k1', promptIndex: 0, promptText: 'backend wala prompt',
        startTime: Date.now(), preExistingVideoUrls: new Set(),
        backendVideoUrl: 'https://lh3.googleusercontent.com/fife=s0', backendUrlVia: 'workflow-id'
      };
      const res = await eng.downloadTaskMedia(task, dlDir, { type: 'Video' });
      assert.strictEqual(res.ok, true, 'backend bandhan: download safal');
      assert.strictEqual(res.strategy, 'backend-fetch', 'backend bandhan: jeetne wali ranneeti backend-fetch hai');
      assert.strictEqual(nativeCalled, false, 'backend bandhan: native UI chala hi nahi (button/menu ki jung khatam)');
      assert.strictEqual(task.completedVideoUrl, 'https://lh3.googleusercontent.com/fife=s0', 'backend bandhan: task ka URL wahi backend link hai');

      // (b) Fetch fail: retryDownloadForTask pehle backend try karta hai (2 koshish: asal + ek dobara), phir grid wala rasta — aur wahan tile nahi to tile-missing.
      const eng2 = new FlowAutomationEngine({ onLog: () => {} }, {});
      let fetchCalls = 0;
      eng2.downloadFromCapturedStream = async () => { fetchCalls++; return false; };
      const task2 = {
        videoId: 'cap_k2', captureKey: 'cap_k2', promptIndex: 1, promptText: 'fetch fail wala prompt',
        startTime: Date.now(), preExistingVideoUrls: new Set(),
        backendVideoUrl: 'https://lh3.googleusercontent.com/dead=s0', backendUrlVia: 'workflow-id'
      };
      const r2 = await eng2.retryDownloadForTask(task2, dlDir, { type: 'Video' });
      assert.strictEqual(fetchCalls, 2, 'fetch-fail: backend fetch 2 baar try hua (asal + ek dobara koshish)');
      assert.strictEqual(r2.status, 'tile-missing', 'fetch-fail + tile nahi: natija tile-missing (grid wala rasta chala)');
      assert.ok(r2.attempts[0] && r2.attempts[0].strategy === 'backend-fetch', 'fetch-fail: attempts me sabse pehle backend-fetch hai');

      // (c) Kram wala bandhan download ke pal par: bandha link nahi, tile par URL nahi — network ka bin-bandha link kram se is task ko.
      const eng3 = new FlowAutomationEngine({ onLog: () => {} }, {});
      eng3.netCapture.beginSubmission('cap_k3', 1000);
      eng3.netCapture.ingestResponse({ url: 'https://aisandbox-pa.googleapis.com/v1/flow', bodyBuffer: Buffer.from('{"note":"https://lh3.googleusercontent.com/ORD=s0"}'), at: 2000 });
      let fetchedUrl = null;
      eng3.downloadFromCapturedStream = async (t) => { fetchedUrl = t.completedVideoUrl; t.mediaSaved = true; t.downloaded = true; return true; };
      const task3 = {
        videoId: 'cap_k3', captureKey: 'cap_k3', promptIndex: 2, promptText: 'kram wala prompt',
        startTime: Date.now(), preExistingVideoUrls: new Set()
      };
      const r3 = await eng3.downloadTaskMedia(task3, dlDir, { type: 'Video' });
      assert.strictEqual(r3.ok, true, 'kram bandhan: download safal');
      assert.strictEqual(r3.strategy, 'backend-fetch', 'kram bandhan: ranneeti backend-fetch');
      assert.strictEqual(fetchedUrl, 'https://lh3.googleusercontent.com/ORD=s0', 'kram bandhan: wahi bin-bandha link fetch hua');
      assert.strictEqual(task3.backendUrlVia, 'order', 'kram bandhan: via order likha hai');
    } finally {
      try { fs.rmSync(dlDir, { recursive: true, force: true }); } catch (e) {}
    }
  });

  console.log('\n[24] v2.9.0: failure saboot ka dayra — jhootha "Safety Filter" fail khatam');

  test('failureEvidence: owner ka popover majmua (jhootha saboot) refusal NAHI hai', () => {
    const fe = require(path.join(ROOT, 'engine', 'failureEvidence.js'));
    // Owner ke screenshot (2026-10-15) ki HAR TAS ki wajah — account/
    // credits popover ka kata hua majmua, footer ke "Privacy Policy /
    // Terms of Service" ke saath.
    const garbage = 'closeMohd AslamMohda.ktanwar@gmail.com Switch account movie_filter_auto46 Google Flow creditsCredits refresh daily at 9:02 AM Upgrade personCreate avatar Privacy Policy Terms of Service';
    assert.strictEqual(fe.findRefusal(garbage), null, 'popover majmua refusal NAHI hai (purana scan yahi par trigger hota tha)');
    assert.strictEqual(fe.isAccountChromeText(garbage), true, 'popover account/credits chrome pehchana gaya');
    // Akele shabd kabhi saboot nahi — koi bhi roop me.
    for (const w of ['safety', 'policy', 'Privacy Policy', 'Terms of Service', 'something went wrong', 'filter', 'blocked', 'terms', 'violation']) {
      assert.strictEqual(fe.findRefusal(w), null, `akela shabd "${w}" refusal NAHI hai`);
    }
    // Icon ligature ke naam ke andar chhupa khatarnaak shabd bhi nahi.
    assert.strictEqual(fe.findRefusal(fe.stripIconLigatures('safety_check content_policy movie_filter_auto')), null, 'ligature tokens saaf hone ke baad koi refusal nahi bachta');
    assert.strictEqual(fe.isAccountChromeText('This video could not be generated'), false, 'aam text chrome NAHI hai');
  });

  test('failureEvidence: asal refusal jumle pakde jate hain, wajah wahi saaf jumla hai', () => {
    const fe = require(path.join(ROOT, 'engine', 'failureEvidence.js'));
    const r1 = fe.findRefusal("Couldn't generate this video. It may violate our content policy. Try another prompt.");
    assert.ok(r1 && /violate our content policy|couldn't generate/i.test(r1.snippet), `policy wala jumla snippet me hai (got ${r1 && r1.snippet})`);
    assert.ok(fe.findRefusal('Failed to generate this video'), 'failed to generate pakda gaya');
    assert.ok(fe.findRefusal("We can't generate that"), 'generate-negation pakda gaya');
    assert.ok(fe.findRefusal('This request goes against our policies'), 'against our policies pakda gaya');
    assert.ok(fe.findRefusal('Your generation was blocked'), 'generation blocked pakda gaya');
    assert.ok(fe.findRefusal('This is a policy violation'), 'policy violation pakda gaya');
    // Snippet sirf wahi jumla — aas-paas ka kachra wajah nahi banta.
    const longText = 'Mohd Aslam Switch account 46 credits refresh daily. '.repeat(3) + "It may violate our content policy.";
    const r2 = fe.findRefusal(longText);
    assert.ok(r2 && r2.snippet.includes('violate our content policy'), 'lambi text me bhi snippet wahi jumla hai');
    assert.ok(!/Switch account/.test(r2.snippet), 'snippet me aas-paas ka chrome majmua NAHI hai');
    assert.ok(r2.snippet.length <= 140, 'snippet cap 140 ke andar hai');
  });

  test('failureEvidence: tile classification — safety / unusual / tile-error / sehatmand', () => {
    const fe = require(path.join(ROOT, 'engine', 'failureEvidence.js'));
    const healthy = fe.classifyTileEvidence({ text: ' 50% play_circle 720p', hasErrorIcon: false });
    assert.strictEqual(healthy.isFailed, false, 'generating tile (icon ligatures ke saath) fail NAHI hai');
    const iconOnly = fe.classifyTileEvidence({ text: ' 720p', hasErrorIcon: true });
    assert.strictEqual(iconOnly.isFailed, true, 'error icon wali tile fail hai');
    assert.strictEqual(iconOnly.kind, 'tile-error', 'icon-akela saboot = tile-error (safety NAHI)');
    assert.strictEqual(iconOnly.reason, null, 'tile-error ki wajah apusht hai — blanket label nahi banta');
    const refusal = fe.classifyTileEvidence({ text: " couldn't generate. it may violate our content policy.", hasErrorIcon: true });
    assert.strictEqual(refusal.kind, 'safety', 'tile par asal jumla = safety fail');
    assert.ok(refusal.reason && refusal.reason.includes('violate our content policy'), 'safety wajah tile ka asal jumla hai');
    const unusual = fe.classifyTileEvidence({ text: ' unusual activity', hasErrorIcon: false });
    assert.strictEqual(unusual.kind, 'unusual', 'unusual activity apni class hai');
  });

  test('v2.9.0 structure: saboot wiring + modal blast-radius bandh + version', () => {
    const fa = fs.readFileSync(path.join(ROOT, 'engine', 'flowAutomation.js'), 'utf8');
    assert.ok(fa.includes("require('./failureEvidence')"), 'engine failureEvidence jodta hai');
    const wirings = (fa.match(/failureEvidence\.patternSources\(\)/g) || []).length;
    assert.ok(wirings >= 3, `pattern sources teeno scans ko jate hain (immediate/canvas/modal) — got ${wirings}`);
    assert.ok(fa.includes('ACCOUNT_CHROME_MARKERS'), 'account chrome markers scans ko jate hain');
    assert.ok(fa.includes('modalVictim'), 'modal refusal sirf EK victim task ko fail karta hai');
    assert.ok(!fa.includes("txt.includes('something went wrong')"), 'purana bare-substring modal trigger GAYA');
    assert.ok(!fa.includes('(d.innerText'), 'dialog ka poora innerText wajah ban-na GAYA');
    assert.ok(!fa.includes(": 'Google Safety / Policy Filter'"), 'blanket "Google Safety / Policy Filter" wajah GAYA');
    assert.ok(fa.includes("failureKind === 'safety'"), 'tile fail ki wajah failureKind se banti hai');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.version, '2.20.0');
  });

  test('v2.9.0 hifazat: apusht wajah = bounded retry mumkin, sabit jumla = prompt-level pakka', () => {
    const failover = require(path.join(ROOT, 'engine', 'failover.js'));
    // Icon-akeli (apusht) fail ki nayi imaandaar wajah failover me
    // generation-level hai — bounded retry/failover band NAHI hota.
    const weak = failover.classifyFailure('Flow ne tile par error dikhaya, lekin wajah ka koi saaf jumla tile par nahi mila');
    assert.strictEqual(weak.eligible, true, 'apusht tile-error wajah par failover mumkin hai (hamesha ke liye band NAHI)');
    // Jumla-sabit refusal prompt-level hi rehta hai — har account par
    // yahi hoga, dobara fire se credits barbaad honge.
    const proven = failover.classifyFailure("Google Safety Filter: It may violate our content policy.");
    assert.strictEqual(proven.eligible, false, 'jumla-sabit safety refusal prompt-level hai (failover kabhi nahi)');
    assert.strictEqual(proven.kind, 'prompt-policy', 'sabit refusal ki class prompt-policy hai');
  });

  console.log('\n[25] v2.10.0: download pakka (in-page fetch, cookie scope, menu/editor saafai), sequence suffix, capture diagnostics, sidebar vertical box');

  test('v2.10.0 sequence: app ka apna -2 suffix = POORA (GALAT NAAM nahi), ajnabi naam = GALAT NAAM hi', () => {
    const seq = require(path.join(ROOT, 'engine', 'sequenceReport.js'));
    const onDisk = new Set(['/out/scene001.mp4', '/out/scene001-2.mp4', '/out/scene002.mp4', '/out/kuch-aur.mp4']);
    const exists = (p) => onDisk.has(p);
    const rows = [
      { id: 't1', prompt_index: 0, prompt_tag: 'scene001', prompt_text: 'a', status: 'completed', file_path: '/out/scene001-2.mp4' },
      { id: 't2', prompt_index: 1, prompt_tag: 'scene002', prompt_text: 'b', status: 'completed', file_path: '/out/scene002.mp4' },
      { id: 't3', prompt_index: 2, prompt_tag: 'scene003', prompt_text: 'c', status: 'completed', file_path: '/out/kuch-aur.mp4' }
    ];
    const rep = seq.buildSequenceReport(rows, { exists, namingMode: 'tag' });
    assert.strictEqual(rep.presentCount, 2, 'suffix wali + saaf naam wali — dono poori ginati');
    const suf = rep.present.find(p => p.tag === 'scene001');
    assert.ok(suf && suf.suffixNote === true && suf.fileName === 'scene001-2.mp4', 'scene001 suffixNote ke saath present hai');
    assert.strictEqual(rep.wrongName.length, 1, 'ajnabi naam GALAT NAAM hi hai');
    assert.strictEqual(rep.wrongName[0].tag, 'scene003');
    assert.strictEqual(rep.complete, false, 'ajnabi naam ki wajah se complete nahi');
    // Sirf suffix + saaf naam hon to sequence POORI hai (owner ke
    // v2.8.0 run ka jhoota "0 poore" banner ab mumkin nahi).
    const rep2 = seq.buildSequenceReport(rows.slice(0, 2), { exists, namingMode: 'tag' });
    assert.strictEqual(rep2.complete, true, 'suffix wali file ke saath bhi sequence poori');
    assert.strictEqual(rep2.presentCount, 2);
  });

  await testAsync('v2.10.0 capture diagnostics: unarmed bhi ginati banti hai, ingestion armed par hi hoti hai', async () => {
    const { NetworkCapture } = require(path.join(ROOT, 'engine', 'networkCapture.js'));
    const cap = new NetworkCapture({});
    const handlers = {};
    const fakePage = { on: (ev, fn) => { handlers[ev] = fn; }, removeListener: () => {} };
    assert.strictEqual(cap.attach(fakePage), true, 'capture fake page par laga');
    const res = { url: () => 'https://lh3.googleusercontent.com/abc123', headers: () => ({}), buffer: async () => Buffer.from('') };
    await handlers.response(res);
    const snap = cap.statsSnapshot();
    assert.strictEqual(snap.responsesSeen, 1, 'unarmed jawab bhi gina gaya — listener ki zindagi ka saboot');
    assert.strictEqual(snap.mediaResponsesSeen, 1, 'media jawab gina gaya');
    assert.strictEqual(snap.mediaUrlsSeen, 0, 'unarmed ingestion NAHI hui (koi sighting nahi bani)');
    assert.ok(String(snap.topHosts).includes('lh3.googleusercontent.com'), 'diagnostics me sirf host ka naam hai');
  });

  test('v2.10.0 structure: download pakka wiring (in-page fetch, cookie scope, status, menu, editor)', () => {
    const fa = fs.readFileSync(path.join(ROOT, 'engine', 'flowAutomation.js'), 'utf8');
    assert.ok(fa.includes('page.cookies(scope)'), 'Node fetch ke cookies ab media host ke scope se bhi aate hain');
    assert.ok(fa.includes('HTTP ${resp.status}'), 'Node fetch ka HTTP status log hota hai (khamoshi khatam)');
    assert.ok(fa.includes("credentials: 'include'"), 'in-page fetch browser ke apne jar se chalta hai');
    assert.ok(fa.includes('in-browser fetch'), 'in-page fetch ki saaf log line hai');
    assert.ok(fa.includes("hasWord(full, 'download')"), 'menu matcher saaf karke shabd pehchanta hai (icon ligature se nahi tootta)');
    assert.ok(!fa.includes("aria === 'download' || t === 'download'"), 'purana exact-only menu match gaya');
    assert.ok(fa.includes('_inEditorView'), 'editor ki jaanch ab URL se hoti hai');
    assert.ok(fa.includes("u.includes('/edit/')"), 'editor = /edit/ wala URL');
    assert.ok(fa.includes("location.pathname.includes('/edit/')"), 'grid ki jaanch editor ki strip se dhokha nahi khati');
    assert.ok(fa.includes('Network check'), 'backend khabar ke saath capture diagnostics bhi log hote hain');
    const appSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
    assert.ok(appSrc.includes('suffixNote'), 'renderer suffix wali poori files ki line dikhata hai');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.version, '2.20.0');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
