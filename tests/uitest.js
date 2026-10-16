'use strict';

/**
 * FlowStudio Lite — prompt-entry BOOT UI test (v2.5.0).
 *
 * WHY THIS EXISTS: in v2.4.0 the owner's prompts never registered —
 * counter stuck on "Prompts: 0", Generate a dead click. Root cause:
 * renderer/app.js declared a top-level function with the SAME name as
 * the parser's window global (parsePromptsDetailed), overwriting it
 * and recursing into "RangeError: Maximum call stack size exceeded"
 * on every keystroke. The Node-side suites could never see it: they
 * never load both renderer scripts into one window. This test boots
 * the REAL app in Electron (FLOW_LITE_UI_TEST=1 hook in main.js),
 * seeds a throwaway account, and drives the Generate page like a
 * user — counter in BOTH modes, then a REAL Generate click; main
 * reads the created queue rows back from the DB to prove prompts +
 * tags travelled the whole IPC intact (window.api cannot be stubbed:
 * contextBridge objects are frozen).
 *
 * RUN B repeats the boot with FLOW_LITE_UI_TEST_GUARD_FAIL=1, which
 * makes the duplicate-guard IPC throw on purpose: the batch must
 * STILL be created and the skip must be visible in the log — the
 * guard is a salaah, not a gate.
 *
 * Run: npm run test:ui   (uses xvfb-run automatically when headless)
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const electronPath = require('electron');

let failures = 0;
function check(name, cond, detail) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` — ${detail || ''}`}`);
  if (!cond) failures++;
}

function runApp(extraEnv) {
  return new Promise((resolve) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fslite-ui-'));
    const env = {
      ...process.env,
      FLOW_LITE_UI_TEST: '1',
      FLOW_LITE_DATA_DIR: dataDir,
      ELECTRON_DISABLE_SANDBOX: '1',
      ...extraEnv
    };
    const useXvfb = !process.env.DISPLAY && process.platform === 'linux';
    const cmd = useXvfb ? 'xvfb-run' : electronPath;
    const args = useXvfb
      ? ['-a', '-s', '-screen 0 1280x900x24', electronPath, 'main.js', '--disable-gpu', '--no-sandbox']
      : ['main.js', '--disable-gpu', '--no-sandbox'];
    const child = spawn(cmd, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    const killer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (e) {}
    }, 120000);
    child.on('close', () => {
      clearTimeout(killer);
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
      const consoleLines = out.split('\n').filter(l => l.startsWith('RENDERER_CONSOLE'));
      const line = out.split('\n').find(l => l.startsWith('UI_RESULT '));
      if (!line) {
        resolve({ fatal: `no UI_RESULT. console=${consoleLines.slice(-5).join(' | ')} err=${err.split('\n').slice(-5).join(' | ')}` });
        return;
      }
      try { resolve({ result: JSON.parse(line.slice('UI_RESULT '.length)), consoleLines }); }
      catch (e) { resolve({ fatal: `unparseable UI_RESULT: ${line.slice(0, 200)}` }); }
    });
  });
}

(async () => {
  console.log('[uitest] RUN A — normal boot, real Generate click…');
  const a = await runApp({});
  if (a.fatal) {
    check('Run A: app ne UI_RESULT diya', false, a.fatal);
  } else {
    const r = a.result;
    const s = r.steps || {};
    check('Run A: renderer me koi error nahi (v2.4.0 wala RangeError khatam)', (r.errors || []).length === 0 && (a.consoleLines || []).length === 0,
      `errors=${JSON.stringify((r.errors || []).slice(0, 2))} console=${(a.consoleLines || []).slice(0, 2).join(' | ')}`);
    check('Run A: default mode = Bulk Prompt', s.initialMode === 'bulk', `initialMode=${s.initialMode}`);
    check('Run A: sirf DO modes offered: bulk + paragraph', JSON.stringify(s.offeredModes) === JSON.stringify(['bulk', 'paragraph']),
      `offered=${JSON.stringify(s.offeredModes)}`);
    check('Run A: Bulk mode me paragraph-text = 2 prompts (smart fallback)', s.defaultModeParagraphText && s.defaultModeParagraphText.count === 'Prompts: 2', JSON.stringify(s.defaultModeParagraphText));
    check('Run A: Bulk mode me #00-01 tag-text = 2 prompts', s.defaultModeTagText && s.defaultModeTagText.count === 'Prompts: 2', JSON.stringify(s.defaultModeTagText));
    check('Run A: Bulk mode — 2 lines = 2, 2 paragraphs = 2', s.modes && s.modes.bulk && s.modes.bulk.twoLines === 'Prompts: 2' && s.modes.bulk.twoParas === 'Prompts: 2', JSON.stringify(s.modes && s.modes.bulk));
    check('Run A: Paragraph mode — 2 lines (blank line nahi) = 1, 2 paragraphs = 2', s.modes && s.modes.paragraph && s.modes.paragraph.twoLines === 'Prompts: 1' && s.modes.paragraph.twoParas === 'Prompts: 2', JSON.stringify(s.modes && s.modes.paragraph));
    check('Run A: Generate se pehle counter = Prompts: 3', s.beforeGenerate && s.beforeGenerate.count === 'Prompts: 3', JSON.stringify(s.beforeGenerate));
    const tasks = r.dbTasks || [];
    check('Run A: Generate ne DB me 3 queue tasks banaye (asal IPC)', tasks.length === 3, `dbTasks=${JSON.stringify(tasks)} dbError=${r.dbError || ''}`);
    check('Run A: tags DB tak salamat: #00-01/#00-02/#00-03', JSON.stringify(tasks.map(t => t.tag)) === JSON.stringify(['#00-01', '#00-02', '#00-03']), JSON.stringify(tasks.map(t => t.tag)));
    check('Run A: prompt texts DB tak salamat', tasks.length === 3 && tasks[0].text.includes('lighthouse') && tasks[2].text.includes('cat sleeping'), JSON.stringify(tasks.map(t => t.text)));
    check('Run A: concurrency Settings se save hui (start-generation ne persist ki)', ['1', '2', '3', '4', '5'].includes(String(r.savedConcurrency)), `savedConcurrency=${r.savedConcurrency}`);
  }

  console.log('[uitest] RUN B — duplicate-guard IPC zabardasti fail…');
  const b = await runApp({ FLOW_LITE_UI_TEST_GUARD_FAIL: '1' });
  if (b.fatal) {
    check('Run B: app ne UI_RESULT diya', false, b.fatal);
  } else {
    const r = b.result;
    const s = r.steps || {};
    const tasks = r.dbTasks || [];
    check('Run B: guard down hone par bhi batch bana (3 tasks DB me)', tasks.length === 3, `dbTasks=${JSON.stringify(tasks)}`);
    check('Run B: guard skip log me dikha (khamosh nahi)', s.logHasGuardSkip === true, `logHasGuardSkip=${s.logHasGuardSkip}`);
    check('Run B: renderer me koi error nahi', (r.errors || []).length === 0, JSON.stringify((r.errors || []).slice(0, 2)));
  }

  console.log(failures === 0 ? '\nUI TEST PASS — prompt entry pipeline zinda hai, dono modes me, guard ke bagair bhi' : `\nUI TEST FAIL — ${failures} check(s) fail`);
  process.exit(failures === 0 ? 0 : 1);
})();
