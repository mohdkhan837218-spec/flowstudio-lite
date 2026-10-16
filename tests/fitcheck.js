'use strict';

/**
 * FlowStudio Lite — fit-to-screen boot test (v2.2.0; v2.6.0: two
 * window sizes).
 *
 * Launches the REAL app in Electron with FLOW_LITE_FIT_TEST=1 at
 * EACH size in SIZES (1100x750 — a typical small laptop window —
 * 1024x700, the owner's smaller window, and 1000x650 — v2.7.0: the
 * smallest window the Generate page must still fit whole). The hook in main.js
 * opens every view in turn (Accounts · Generate · History · Activity
 * · Import · Settings) and FAILS the run if, on any view:
 *   - the document itself would scroll (body scroll), or
 *   - the view overflows its box, or
 *   - fixed chrome (toolbar / stats / bulk bar / actions) is pushed
 *     outside the window.
 * Internal list regions scrolling is the design, not a failure.
 * A single size can be forced with FLOW_LITE_FIT_SIZES=1024x700.
 *
 * Run: npm run test:fit   (uses xvfb-run automatically when headless)
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const electronPath = require('electron');

const SIZES = (process.env.FLOW_LITE_FIT_SIZES || '1100x750,1024x700,1000x650')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(s => {
    const [w, h] = s.split('x').map(n => parseInt(n, 10));
    return { w: w || 1100, h: h || 750 };
  });

const useXvfb = !process.env.DISPLAY && process.platform === 'linux';

function runOne(size) {
  return new Promise((resolve) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fslite-fit-'));
    const env = {
      ...process.env,
      FLOW_LITE_FIT_TEST: '1',
      FLOW_LITE_FIT_WIDTH: String(size.w),
      FLOW_LITE_FIT_HEIGHT: String(size.h),
      FLOW_LITE_DATA_DIR: dataDir,
      ELECTRON_DISABLE_SANDBOX: '1'
    };
    const cmd = useXvfb ? 'xvfb-run' : electronPath;
    const args = useXvfb
      ? ['-a', '-s', '-screen 0 1280x900x24', electronPath, 'main.js', '--disable-gpu', '--no-sandbox']
      : ['main.js', '--disable-gpu', '--no-sandbox'];

    console.log(`[fitcheck] launching Electron at ${size.w}x${size.h}${useXvfb ? ' under xvfb' : ''}…`);
    const child = spawn(cmd, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });

    const killer = setTimeout(() => {
      console.error(`[fitcheck] TIMEOUT at ${size.w}x${size.h} — the app did not report within 120s`);
      try { child.kill('SIGKILL'); } catch (e) {}
      resolve(false);
    }, 120000);

    child.on('close', (code) => {
      clearTimeout(killer);
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
      const line = out.split('\n').find(l => l.startsWith('FIT_RESULT '));
      if (!line) {
        console.error(`[fitcheck] FAIL at ${size.w}x${size.h} — no FIT_RESULT from the app.`);
        if (err) console.error(err.split('\n').slice(-15).join('\n'));
        return resolve(false);
      }
      let result;
      try { result = JSON.parse(line.slice('FIT_RESULT '.length)); } catch (e) {
        console.error(`[fitcheck] FAIL at ${size.w}x${size.h} — unparseable FIT_RESULT:`, line);
        return resolve(false);
      }
      for (const [view, r] of Object.entries(result.views || {})) {
        const ok = r.docOverflow <= 2 && r.viewOverflow <= 2 && (!r.offenders || r.offenders.length === 0);
        console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${view}: body-overflow=${r.docOverflow}px view-overflow=${r.viewOverflow}px pushed-out=${(r.offenders || []).join(', ') || 'none'}`);
      }
      if (result.error) console.error('[fitcheck] app error:', result.error);
      console.log(result.pass && code === 0
        ? `  → ${size.w}x${size.h}: FIT PASS`
        : `  → ${size.w}x${size.h}: FIT FAIL`);
      resolve(!!(result.pass && code === 0));
    });
  });
}

(async () => {
  let allOk = true;
  for (const size of SIZES) {
    const ok = await runOne(size);
    if (!ok) allOk = false;
  }
  console.log(allOk
    ? `\nFIT PASS — every view fits at ${SIZES.map(s => `${s.w}x${s.h}`).join(' and ')} with no body scroll`
    : '\nFIT FAIL');
  process.exit(allOk ? 0 : 1);
})();
