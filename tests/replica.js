'use strict';
/**
 * FlowStudio Lite — REPLICA harness (v1.7.0).
 *
 * Drives the REAL engine methods against a local HTML page that mimics
 * Flow's project grid — including DECOY elements ([role="gridcell"],
 * div.tile-*) interleaved between the real tiles, which is exactly
 * what broke the pre-v1.7 media extraction (its broad selector list
 * shifted a remembered index onto a neighbour's tile).
 *
 * Not part of tests/smoke.js (it needs a Chromium). Run manually:
 *   REPLICA_CHROME=/path/to/chrome node tests/replica.js
 * Exits 0 on PASS, 1 on FAIL, 2 when no browser is available (skip).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let puppeteer;
try { puppeteer = require('puppeteer-core'); } catch (e) {
  console.log('REPLICA SKIP: puppeteer-core not installed');
  process.exit(2);
}
const { FlowAutomationEngine } = require('../engine/flowAutomation');
const tileIdentity = require('../engine/tileIdentity');

const HTML = `<!doctype html><html><body>
<div class="tile-card decoy"><video src="https://cdn.example/DECOY.mp4"></video></div>
<flow-grid-tile-container aria-label="A red car driving through a rainy city street at night cinematic"><video src="https://cdn.example/CAR.mp4"></video></flow-grid-tile-container>
<div role="gridcell" class="tile-wrap"><video src="https://cdn.example/DECOY2.mp4"></video></div>
<flow-grid-tile-container aria-label="A golden dog running in a green park on a sunny day"><video src="https://cdn.example/DOG.mp4"></video></flow-grid-tile-container>
</body></html>`;

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
  console.log('  PASS  ' + msg);
}

(async () => {
  const executablePath = process.env.REPLICA_CHROME || '/opt/meta-chromium/chrome';
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath,
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    });
  } catch (e) {
    console.log('REPLICA SKIP: could not launch Chromium at ' + executablePath + ' (' + e.message + ')');
    process.exit(2);
  }
  try {
    const page = await browser.newPage();
    await page.setContent(HTML, { waitUntil: 'load' });

    const eng = new FlowAutomationEngine({ onLog: () => {} }, {});
    eng.page = page;

    const fpDog = tileIdentity.tileFingerprint('A golden dog running in a green park on a sunny day', '');

    // 1. Fingerprint-first location beats a WRONG remembered index
    //    (0 points at the car tile in the canonical list).
    const idx = await eng._resolveTileIndexForTask({ lockedTileFingerprint: fpDog }, 0);
    assert(idx === 1, `resolver: dog fingerprint resolves to canonical index 1 despite fallback 0 (got ${idx})`);

    // 2. Extraction returns the DOG's URL even when handed the car's
    //    index — the pre-v1.7 broad-selector evaluate returned a
    //    neighbour/decoy URL here.
    const url = await eng._extractTileMediaUrl({ lockedTileFingerprint: fpDog }, 0, false);
    assert(url === 'https://cdn.example/DOG.mp4', `extraction: dog tile URL returned (got ${url})`);

    // 3. Without a fingerprint, the canonical index is honoured.
    const url0 = await eng._extractTileMediaUrl({}, 0, false);
    assert(url0 === 'https://cdn.example/CAR.mp4', `extraction: canonical index 0 returns the car URL (got ${url0})`);

    // 4. Birth-binding scoring: a sibling's tile must NOT strongly
    //    match this task's prompt; its own tile must.
    const dogWords = tileIdentity.significantWords('make a video of a golden dog running in a park');
    const carFp = tileIdentity.tileFingerprint('A red car driving through a rainy city street at night cinematic', '');
    assert(!tileIdentity.isStrongMatch(tileIdentity.scoreTileForPrompt(dogWords, tileIdentity.significantWords(carFp))),
      'birth binding: dog prompt does not bind the car tile');
    assert(tileIdentity.isStrongMatch(tileIdentity.scoreTileForPrompt(dogWords, tileIdentity.significantWords(fpDog))),
      'birth binding: dog prompt binds the dog tile');

    // 5. Save-name protection: a foreign scene001.mp4 is never
    //    overwritten; our own earlier save may be replaced.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsl-replica-'));
    fs.writeFileSync(path.join(dir, 'scene001.mp4'), 'foreign');
    const picked = eng._pickFreeFilePath(dir, 'scene001.mp4');
    assert(path.basename(picked) === 'scene001_2.mp4', `save: foreign file protected, suffixed name chosen (got ${path.basename(picked)})`);
    eng.savedThisSession.add(path.join(dir, 'scene002.mp4'));
    fs.writeFileSync(path.join(dir, 'scene002.mp4'), 'ours');
    const own = eng._pickFreeFilePath(dir, 'scene002.mp4');
    assert(path.basename(own) === 'scene002.mp4', 'save: own session file may be overwritten');
    fs.rmSync(dir, { recursive: true, force: true });

    // 6. BURST: six tasks, six tiles in shuffled grid order — including
    //    a same-template sibling pair (cheetah/gazelle vs lion/zebra)
    //    that differs in only two subject words. Every task must claim
    //    its OWN tile and extract its OWN URL.
    const burst = [
      { prompt: 'A cheetah sprinting across the savanna chasing a gazelle at sunrise, dust flying, photorealistic wildlife footage', aria: 'A cheetah sprinting across the savanna chasing a gazelle at sunrise, dust flying', url: 'https://cdn.example/CHEETAH.mp4' },
      { prompt: 'A lion sprinting across the savanna chasing a zebra at sunrise, dust flying, photorealistic wildlife footage', aria: 'A lion sprinting across the savanna chasing a zebra at sunrise, dust flying', url: 'https://cdn.example/LION.mp4' },
      { prompt: 'A majestic elephant walking toward a waterhole at golden hour in the savanna', aria: 'A majestic elephant walking toward a waterhole at golden hour', url: 'https://cdn.example/ELEPHANT.mp4' },
      { prompt: 'A red sports car driving through a rainy city street at night', aria: 'A red sports car driving through a rainy city street at night', url: 'https://cdn.example/CAR2.mp4' },
      { prompt: 'A golden retriever dog running through a green park on a sunny day', aria: 'A golden retriever dog running through a green park on a sunny day', url: 'https://cdn.example/DOG2.mp4' },
      { prompt: 'A colorful hot air balloon floating over green hills at sunrise', aria: 'A colorful hot air balloon floating over green hills at sunrise', url: 'https://cdn.example/BALLOON.mp4' }
    ];
    const order = [3, 0, 5, 1, 4, 2];
    const burstHtml = order.map(i => `<flow-grid-tile-container aria-label="${burst[i].aria}"><video src="${burst[i].url}"></video></flow-grid-tile-container>`).join('\n');
    await page.setContent(`<!doctype html><html><body>${burstHtml}</body></html>`, { waitUntil: 'load' });
    const domTiles = await page.evaluate(() => Array.from(document.querySelectorAll('flow-grid-tile-container')).map((c, i) => ({ tileIndex: i, aria: c.getAttribute('aria-label') || '' })));
    const descriptors = domTiles.map(t => ({ tileIndex: t.tileIndex, fingerprint: tileIdentity.tileFingerprint(t.aria, ''), words: tileIdentity.significantWords(t.aria) }));
    const burstTasks = burst.map((b, i) => ({ key: 'task' + i, promptWords: tileIdentity.significantWords(b.prompt), preExistingFingerprints: new Set(), lockedFingerprint: null }));
    const assignments = tileIdentity.assignTiles(burstTasks, descriptors, new Set());
    assert(assignments.size === 6, `burst: all 6 tasks claimed a tile (got ${assignments.size})`);
    for (let i = 0; i < 6; i++) {
      const tile = assignments.get('task' + i);
      assert(tile && tile.fingerprint === tileIdentity.tileFingerprint(burst[i].aria, ''), `burst: task ${i + 1} (${burst[i].url.split('/').pop()}) claimed its own tile`);
      const url = await eng._extractTileMediaUrl({ lockedTileFingerprint: tile.fingerprint }, tile.tileIndex, false);
      assert(url === burst[i].url, `burst: task ${i + 1} extraction returns its own URL (${burst[i].url.split('/').pop()})`);
    }

    // 7. v1.8.0 check-only recovery scan: a prompt finds its OWN tile +
    //    URL on the existing grid; an absent prompt finds NOTHING (the
    //    recovery path must never guess — a wrong guess would download
    //    someone else's video or hide a double charge).
    await page.setContent(HTML, { waitUntil: 'load' });
    const scan = await eng._scanGridForPrompt('make a video of a golden dog running in a park');
    assert(scan && scan.url === 'https://cdn.example/DOG.mp4', `recovery scan: dog prompt finds its own tile URL (got ${scan && scan.url})`);
    assert(scan && scan.tileIndex === 1, `recovery scan: dog tile is canonical index 1 (got ${scan && scan.tileIndex})`);
    const noScan = await eng._scanGridForPrompt('a purple elephant flying over the moon at midnight');
    assert(noScan === null, 'recovery scan: absent prompt returns null (never guesses)');

    // 8. v2.1.0 STUCK-RENDER RECOVERY (the owner's PC bug): a task is
    //    SUBMITTED (credits charged) but its tile does not exist yet.
    //    The old monitor failed it at the 120s anti-stall guard. Now the
    //    monitor must enter stall recovery (onTaskStalled fires, NO
    //    failure), and when the tile finally appears — first generating,
    //    then ready — the task downloads and completes.
    {
      await page.setContent('<!doctype html><html><body><div id="grid"></div></body></html>', { waitUntil: 'load' });
      const events = { failed: [], stalled: 0, completed: [] };
      const eng2 = new FlowAutomationEngine({
        onLog: () => {},
        onTaskFailed: (t, reason) => events.failed.push(reason),
        onTaskStalled: () => { events.stalled++; },
        onTaskCompleted: (t, result) => events.completed.push(result)
      }, { stallTimeoutSec: 2, recoveryWindowSec: 60, recoveryScanEveryMs: 1000 });
      eng2.page = page;
      eng2.currentAccount = { id: 'acc_replica', name: 'Replica Account' };
      // The download plumbing itself is covered elsewhere; here only
      // the MONITOR's decision matters, so the stream download is a
      // stand-in that completes the task like the real one does.
      eng2.downloadViaFlowNativeMenu = async () => false;
      eng2.downloadFromCapturedStream = async (task) => {
        task.downloaded = true;
        task.completed = true;
        eng2.onTaskCompleted(task, { filePath: '/tmp/robot.mp4', fileName: 'robot.mp4', fileSizeMb: '1.0' });
        return true;
      };
      const stallTask = {
        videoId: 'v_stall_1',
        promptText: 'a silver robot dancing on a rooftop at sunset cinematic',
        promptIndex: 0,
        startTime: Date.now(),
        tileIndex: -1,
        preExistingFingerprints: []
      };
      const aria = 'A silver robot dancing on a rooftop at sunset';
      const monitorPromise = eng2.waitForAccountTasks([stallTask], os.tmpdir(), { type: 'Video' }, false);
      // t+5s: the tile finally appears, still generating (50%).
      setTimeout(() => {
        page.evaluate((label) => {
          const c = document.createElement('flow-grid-tile-container');
          c.setAttribute('aria-label', label);
          const s = document.createElement('span');
          s.textContent = '50%';
          c.appendChild(s);
          document.getElementById('grid').appendChild(c);
        }, aria).catch(() => {});
      }, 5000);
      // t+9s: render finishes — badge + video, no percentage.
      setTimeout(() => {
        page.evaluate(() => {
          const c = document.querySelector('flow-grid-tile-container');
          if (!c) return;
          c.innerHTML = '';
          const v = document.createElement('video');
          v.src = 'https://cdn.example/ROBOT.mp4';
          c.appendChild(v);
          const s = document.createElement('span');
          s.textContent = '360p';
          c.appendChild(s);
        }).catch(() => {});
      }, 9000);
      await monitorPromise;
      assert(events.failed.length === 0, `stall recovery: a late tile is NOT a failure (failures: ${JSON.stringify(events.failed)})`);
      assert(events.stalled >= 1, 'stall recovery: onTaskStalled fired when the tile stayed missing');
      assert(stallTask.downloaded === true && events.completed.length === 1, 'stall recovery: the late tile downloaded and the task completed');
    }

    // 9. v2.1.0 stall give-up: the tile NEVER appears. The task must
    //    survive well past the old instant-fail moment and fail only
    //    after the recovery window, with a reason that says the
    //    in-project recovery search happened.
    {
      await page.setContent('<!doctype html><html><body><div id="grid"></div></body></html>', { waitUntil: 'load' });
      const events = { failed: [], stalled: 0 };
      const eng3 = new FlowAutomationEngine({
        onLog: () => {},
        onTaskFailed: (t, reason) => events.failed.push(reason),
        onTaskStalled: () => { events.stalled++; }
      }, { stallTimeoutSec: 2, recoveryWindowSec: 8, recoveryScanEveryMs: 1000 });
      eng3.page = page;
      eng3.currentAccount = { id: 'acc_replica', name: 'Replica Account' };
      const lostTask = {
        videoId: 'v_stall_2',
        promptText: 'a purple elephant flying over the moon at midnight',
        promptIndex: 0,
        startTime: Date.now(),
        tileIndex: -1,
        preExistingFingerprints: []
      };
      const t0 = Date.now();
      await eng3.waitForAccountTasks([lostTask], os.tmpdir(), { type: 'Video' }, false);
      const elapsedSec = (Date.now() - t0) / 1000;
      assert(events.failed.length === 1, `stall give-up: exactly one failure after the window (got ${events.failed.length})`);
      assert(/recovery search/.test(events.failed[0] || ''), `stall give-up: the reason names the recovery search (got: ${events.failed[0]})`);
      assert(elapsedSec >= 9, `stall give-up: no early fail — waited ${elapsedSec.toFixed(1)}s (stall at 2s + 8s window)`);
      assert(events.stalled >= 1, 'stall give-up: recovery had begun before the failure');
    }

    // 10. v2.4.0 SHORT-PROMPT BINDING, end to end (the owner's exact
    //     bug): the prompt is "make a video" — ONE significant word,
    //     so no tile can ever score-match it. The grid already holds
    //     an OLD tile (in the task's pre-submit snapshot). A NEW tile
    //     appears after submit, generating then ready. The lone
    //     in-flight task must claim the NEW tile by order/timing —
    //     and never the old one.
    {
      const oldAria = 'An old unrelated render about elephants at a waterhole';
      await page.setContent(`<!doctype html><html><body><div id="grid"><flow-grid-tile-container aria-label="${oldAria}"><video src="https://cdn.example/OLD.mp4"></video></flow-grid-tile-container></div></body></html>`, { waitUntil: 'load' });
      const events = { failed: [], completed: [], heartbeats: [] };
      let downloadSawFingerprint = null;
      const eng4 = new FlowAutomationEngine({
        onLog: () => {},
        onTaskFailed: (t, reason) => events.failed.push(reason),
        onTaskCompleted: (t, result) => events.completed.push(result),
        onTaskHeartbeat: (t, info) => events.heartbeats.push(info.state)
      }, { stallTimeoutSec: 3, recoveryWindowSec: 60, recoveryScanEveryMs: 1000, heartbeatEveryMs: 1000 });
      eng4.page = page;
      eng4.currentAccount = { id: 'acc_replica', name: 'Replica Account' };
      eng4.downloadViaFlowNativeMenu = async () => false;
      eng4.downloadFromCapturedStream = async (task) => {
        downloadSawFingerprint = task.lockedTileFingerprint;
        task.downloaded = true;
        task.completed = true;
        eng4.onTaskCompleted(task, { filePath: '/tmp/short.mp4', fileName: 'short.mp4', fileSizeMb: '1.0' });
        return true;
      };
      const shortTask = {
        videoId: 'v_short_1',
        promptText: 'make a video',
        promptIndex: 0,
        startTime: Date.now(),
        tileIndex: -1,
        preExistingFingerprints: [tileIdentity.tileFingerprint(oldAria, '')]
      };
      const monitorPromise = eng4.waitForAccountTasks([shortTask], os.tmpdir(), { type: 'Video' }, false);
      setTimeout(() => {
        page.evaluate(() => {
          const c = document.createElement('flow-grid-tile-container');
          c.setAttribute('aria-label', 'make a video');
          const s = document.createElement('span');
          s.textContent = '50%';
          c.appendChild(s);
          document.getElementById('grid').appendChild(c);
        }).catch(() => {});
      }, 3000);
      setTimeout(() => {
        page.evaluate(() => {
          const c = document.querySelectorAll('flow-grid-tile-container')[1];
          if (!c) return;
          c.innerHTML = '';
          const v = document.createElement('video');
          v.src = 'https://cdn.example/NEW.mp4';
          c.appendChild(v);
          const s = document.createElement('span');
          s.textContent = '360p';
          c.appendChild(s);
        }).catch(() => {});
      }, 6000);
      await monitorPromise;
      const fpNew = tileIdentity.tileFingerprint('make a video', '');
      const fpOld = tileIdentity.tileFingerprint(oldAria, '');
      assert(events.failed.length === 0, `short prompt: the run does NOT fail (failures: ${JSON.stringify(events.failed)})`);
      assert(events.completed.length === 1 && shortTask.downloaded === true, 'short prompt: the task completed via the new tile');
      assert(downloadSawFingerprint === fpNew, 'short prompt: the download bound the NEW tile fingerprint, not the old one');
      assert(!eng4.claimedTileFingerprints.has(fpOld), 'short prompt: the pre-existing tile was never claimed');
      assert(events.heartbeats.includes('generating'), 'short prompt: the tile-state heartbeat reported "generating"');
    }

    // 11. v2.4.0 fallback fence: TWO short prompts in flight at once
    //     and only ONE new tile ever appears. The fallback must stay
    //     OFF for both — neither task may take (or download) a tile
    //     that could be the sibling's. Both end as honest recovery
    //     give-ups, not as a stolen download.
    {
      await page.setContent('<!doctype html><html><body><div id="grid"></div></body></html>', { waitUntil: 'load' });
      const events = { failed: [], completed: [] };
      const eng5 = new FlowAutomationEngine({
        onLog: () => {},
        onTaskFailed: (t, reason) => events.failed.push(reason),
        onTaskCompleted: (t, result) => events.completed.push(result)
      }, { stallTimeoutSec: 2, recoveryWindowSec: 6, recoveryScanEveryMs: 1000, heartbeatEveryMs: 1000 });
      eng5.page = page;
      eng5.currentAccount = { id: 'acc_replica', name: 'Replica Account' };
      eng5.downloadViaFlowNativeMenu = async () => false;
      eng5.downloadFromCapturedStream = async () => { throw new Error('must never download in section 11'); };
      const taskA = { videoId: 'v_short_a', promptText: 'make a video', promptIndex: 0, startTime: Date.now(), tileIndex: -1, preExistingFingerprints: [] };
      const taskB = { videoId: 'v_short_b', promptText: 'make a clip', promptIndex: 1, startTime: Date.now(), tileIndex: -1, preExistingFingerprints: [] };
      const monitorPromise = eng5.waitForAccountTasks([taskA, taskB], os.tmpdir(), { type: 'Video' }, false);
      setTimeout(() => {
        page.evaluate(() => {
          const c = document.createElement('flow-grid-tile-container');
          c.setAttribute('aria-label', 'make a video');
          const s = document.createElement('span');
          s.textContent = '50%';
          c.appendChild(s);
          document.getElementById('grid').appendChild(c);
        }).catch(() => {});
      }, 2000);
      setTimeout(() => {
        page.evaluate(() => {
          const c = document.querySelector('flow-grid-tile-container');
          if (!c) return;
          c.innerHTML = '';
          const v = document.createElement('video');
          v.src = 'https://cdn.example/ONLY.mp4';
          c.appendChild(v);
          const s = document.createElement('span');
          s.textContent = '360p';
          c.appendChild(s);
        }).catch(() => {});
      }, 6000);
      await monitorPromise;
      assert(events.completed.length === 0, 'parallel short prompts: NO task completed from the ambiguous tile');
      assert(events.failed.length === 2, `parallel short prompts: both tasks ended as honest give-ups (got ${events.failed.length})`);
      assert(events.failed.every(r => /recovery search/.test(r || '')), 'parallel short prompts: give-up reasons name the recovery search');
      assert(!eng5.claimedTileFingerprints.has(tileIdentity.tileFingerprint('make a video', '')), 'parallel short prompts: the lone tile was never claimed by anyone');
    }

    // 12. v2.4.0 pre-existing protection at monitor level: the ONLY
    //     tile in the grid is one whose text matches the prompt
    //     EXACTLY — but it predates the submission (it is in the
    //     snapshot). It must never be claimed or downloaded.
    {
      const aria = 'make a video';
      await page.setContent(`<!doctype html><html><body><div id="grid"><flow-grid-tile-container aria-label="${aria}"><video src="https://cdn.example/PREEXISTING.mp4"></video></flow-grid-tile-container></div></body></html>`, { waitUntil: 'load' });
      const events = { failed: [], completed: [] };
      let downloadCalled = false;
      const eng6 = new FlowAutomationEngine({
        onLog: () => {},
        onTaskFailed: (t, reason) => events.failed.push(reason),
        onTaskCompleted: (t, result) => events.completed.push(result)
      }, { stallTimeoutSec: 2, recoveryWindowSec: 6, recoveryScanEveryMs: 1000, heartbeatEveryMs: 1000 });
      eng6.page = page;
      eng6.currentAccount = { id: 'acc_replica', name: 'Replica Account' };
      eng6.downloadViaFlowNativeMenu = async () => { downloadCalled = true; return false; };
      eng6.downloadFromCapturedStream = async () => { downloadCalled = true; return false; };
      const task = {
        videoId: 'v_short_pre',
        promptText: 'make a video',
        promptIndex: 0,
        startTime: Date.now(),
        tileIndex: -1,
        preExistingFingerprints: [tileIdentity.tileFingerprint(aria, '')]
      };
      await eng6.waitForAccountTasks([task], os.tmpdir(), { type: 'Video' }, false);
      assert(events.completed.length === 0 && downloadCalled === false, 'pre-existing: the old tile was never downloaded');
      assert(events.failed.length === 1 && /recovery search/.test(events.failed[0] || ''), 'pre-existing: the task gives up honestly after the recovery window');
      assert(!eng6.claimedTileFingerprints.has(tileIdentity.tileFingerprint(aria, '')), 'pre-existing: fingerprint never entered the claimed set');
    }

    // 13. v2.4.0 TILE-STATE NARRATION + HEARTBEAT + FAST FAIL.
    //     (a) a generating tile: the log must SAY the video is being
    //     made, and keep saying it (~heartbeat) while it renders —
    //     the owner's 4-minute silence must be impossible.
    //     (b) a tile Flow itself failed: the task fails within
    //     seconds with the plain reason — NOT after a 10-minute wait.
    {
      await page.setContent('<!doctype html><html><body><div id="grid"></div></body></html>', { waitUntil: 'load' });
      const logs = [];
      const events = { completed: [], heartbeats: [] };
      const eng7 = new FlowAutomationEngine({
        onLog: (d) => logs.push(String(d.message || '')),
        onTaskCompleted: (t, result) => events.completed.push(result),
        onTaskHeartbeat: (t, info) => events.heartbeats.push(info.state)
      }, { stallTimeoutSec: 60, recoveryWindowSec: 120, recoveryScanEveryMs: 1000, heartbeatEveryMs: 1000 });
      eng7.page = page;
      eng7.currentAccount = { id: 'acc_replica', name: 'Replica Account' };
      eng7.downloadViaFlowNativeMenu = async () => false;
      eng7.downloadFromCapturedStream = async (task) => {
        task.downloaded = true;
        task.completed = true;
        eng7.onTaskCompleted(task, { filePath: '/tmp/narr.mp4', fileName: 'narr.mp4', fileSizeMb: '1.0' });
        return true;
      };
      const aria = 'A silver robot dancing on a rooftop at sunset';
      const task = { videoId: 'v_narr_1', promptText: 'a silver robot dancing on a rooftop at sunset cinematic', promptIndex: 0, startTime: Date.now(), tileIndex: -1, preExistingFingerprints: [] };
      const monitorPromise = eng7.waitForAccountTasks([task], os.tmpdir(), { type: 'Video' }, false);
      setTimeout(() => {
        page.evaluate((label) => {
          const c = document.createElement('flow-grid-tile-container');
          c.setAttribute('aria-label', label);
          const s = document.createElement('span');
          s.textContent = '50%';
          c.appendChild(s);
          document.getElementById('grid').appendChild(c);
        }, aria).catch(() => {});
      }, 2000);
      setTimeout(() => {
        page.evaluate(() => {
          const c = document.querySelector('flow-grid-tile-container');
          if (!c) return;
          c.innerHTML = '';
          const v = document.createElement('video');
          v.src = 'https://cdn.example/NARR.mp4';
          c.appendChild(v);
          const s = document.createElement('span');
          s.textContent = '360p';
          c.appendChild(s);
        }).catch(() => {});
      }, 8000);
      await monitorPromise;
      assert(events.completed.length === 1, 'narration: the generating tile completed normally');
      assert(logs.some(l => l.includes('The video is generating on Flow')), 'narration: the log said the video is being made');
      assert(logs.filter(l => l.includes('The video is generating on Flow') && /total wait/.test(l)).length >= 2, 'narration: the state line REPEATED with elapsed time while rendering (heartbeat — no silence)');
      assert(events.heartbeats.includes('generating'), 'narration: Activity heartbeat saw the generating state');
    }
    {
      await page.setContent('<!doctype html><html><body><div id="grid"></div></body></html>', { waitUntil: 'load' });
      const logs = [];
      const events = { failed: [] };
      const eng8 = new FlowAutomationEngine({
        onLog: (d) => logs.push(String(d.message || '')),
        onTaskFailed: (t, reason) => events.failed.push(reason)
      }, { stallTimeoutSec: 60, recoveryWindowSec: 120, recoveryScanEveryMs: 1000, heartbeatEveryMs: 1000 });
      eng8.page = page;
      eng8.currentAccount = { id: 'acc_replica', name: 'Replica Account' };
      const aria = 'A silver robot dancing on a rooftop at sunset';
      const task = { videoId: 'v_narr_2', promptText: 'a silver robot dancing on a rooftop at sunset cinematic', promptIndex: 0, startTime: Date.now(), tileIndex: -1, preExistingFingerprints: [] };
      const t0 = Date.now();
      const monitorPromise = eng8.waitForAccountTasks([task], os.tmpdir(), { type: 'Video' }, false);
      setTimeout(() => {
        page.evaluate((label) => {
          const c = document.createElement('flow-grid-tile-container');
          c.setAttribute('aria-label', label);
          const s = document.createElement('span');
          s.textContent = 'Failed to generate';
          c.appendChild(s);
          document.getElementById('grid').appendChild(c);
        }, aria).catch(() => {});
      }, 2000);
      await monitorPromise;
      const elapsedSec = (Date.now() - t0) / 1000;
      assert(events.failed.length === 1 && /Safety|Policy/.test(events.failed[0] || ''), `fast fail: a Flow-failed tile fails with the policy reason (got: ${events.failed[0]})`);
      assert(elapsedSec < 25, `fast fail: no long wait — failed in ${elapsedSec.toFixed(1)}s despite a 120s recovery window`);
      assert(logs.some(l => l.includes('Flow has marked this video as failed')), 'fast fail: the log narrated the failure the moment the tile showed it');
    }

    // 14. v2.6.0 RENDER PROGRESS WATCHDOG (the owner's v2.5.0 freeze):
    //     the tile EXISTS and is generating, but its percentage never
    //     moves — 1% forever, exactly what he watched for 8+ minutes.
    //     The watchdog must fire onRenderStall exactly ONCE for the
    //     frozen episode and must NOT fail the task; when the render
    //     finally finishes, the task completes normally.
    {
      await page.setContent('<!doctype html><html><body><div id="grid"></div></body></html>', { waitUntil: 'load' });
      const events = { failed: [], completed: [], stalls: [], logs: [] };
      const eng9 = new FlowAutomationEngine({
        onLog: (m) => events.logs.push(m && m.message ? m.message : String(m)),
        onTaskFailed: (t, reason) => events.failed.push(reason),
        onTaskCompleted: (t, result) => events.completed.push(result),
        onRenderStall: (t, info) => events.stalls.push(info)
      }, { stallTimeoutSec: 30, recoveryWindowSec: 60, recoveryScanEveryMs: 1000, heartbeatEveryMs: 1000, progressStallAfterMs: 2500 });
      eng9.page = page;
      eng9.currentAccount = { id: 'acc_replica', name: 'Replica Account' };
      eng9.downloadViaFlowNativeMenu = async () => false;
      eng9.downloadFromCapturedStream = async (task) => {
        task.downloaded = true;
        task.completed = true;
        eng9.onTaskCompleted(task, { filePath: '/tmp/eagle.mp4', fileName: 'eagle.mp4', fileSizeMb: '1.0' });
        return true;
      };
      const aria = 'A golden eagle soaring over snowy mountain peaks';
      const task = { videoId: 'v_watch_1', promptText: 'a golden eagle soaring over snowy mountain peaks cinematic', promptIndex: 0, startTime: Date.now(), tileIndex: -1, preExistingFingerprints: [] };
      // The tile is on the grid from the start, frozen at 1%.
      await page.evaluate((label) => {
        const c = document.createElement('flow-grid-tile-container');
        c.setAttribute('aria-label', label);
        const s = document.createElement('span');
        s.textContent = '1%';
        c.appendChild(s);
        document.getElementById('grid').appendChild(c);
      }, aria);
      const monitorPromise = eng9.waitForAccountTasks([task], os.tmpdir(), { type: 'Video' }, false);
      // t+8s: the render finally finishes — badge + video, no %.
      setTimeout(() => {
        page.evaluate(() => {
          const c = document.querySelector('flow-grid-tile-container');
          if (!c) return;
          c.innerHTML = '';
          const v = document.createElement('video');
          v.src = 'https://cdn.example/EAGLE.mp4';
          c.appendChild(v);
          const s = document.createElement('span');
          s.textContent = '360p';
          c.appendChild(s);
        }).catch(() => {});
      }, 8000);
      await monitorPromise;
      assert(events.stalls.length === 1, `watchdog: onRenderStall fired exactly once for the frozen episode (got ${events.stalls.length})`);
      assert(events.stalls[0] && events.stalls[0].lastPct === '1%', `watchdog: the stall report carries the frozen percentage (got ${events.stalls[0] && events.stalls[0].lastPct})`);
      assert(events.failed.length === 0, `watchdog: a frozen % never fails the task by itself (failures: ${JSON.stringify(events.failed)})`);
      assert(events.completed.length === 1 && task.downloaded === true, 'watchdog: once the render finished, the task completed normally');
      assert(events.logs.some(l => l.includes('The render seems STUCK')), 'watchdog: the freeze was narrated in the log in plain words');
    }

    // 15. DOWNLOAD STRATEGIES (v2.8.0 roop) — Flow-grid ke teen
    //     bache hue roop, har ek se ASLI download safal (local HTTP
    //     server + asal mp4):
    //       (a) sirf video-src: tile ke <video src> se seedha fetch.
    //       (b) menu-only: sirf ⋮ menu ke andar EXACT "Download"
    //           (inspection hissa 2: tile menu ka label yahi hai;
    //           "Download media" wahan NAHI hota).
    //       (c) editor top-bar: tile click par khulne wala editor,
    //           top bar aria "Download media" (inspection hissa 2:
    //           ye label SIRF yahin hota hai).
    //     Hover wala roop v2.8.0 me GAYA — inspection ne sabit kiya
    //     tile par hover se download button aata hi NAHI (sirf
    //     Favorite / Reuse prompt / More options hote hain).
    //     Backend wala pramukh roop neeche section 17 me hai.
    //     v2.10.0: teen aur roop — (d) menu item icon-ligature text
    //     ke saath (saaf matcher), (e) editor jahan grid ki strip
    //     DOM me rehti hai lekin URL /edit/ hai (URL jaanch), (f)
    //     tile URL jo Node fetch se nahi aata lekin browser ke
    //     andar wale fetch se aata hai (in-page fetch).
    {
      const http = require('http');
      const { execFileSync } = require('child_process');
      const sampleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsl-replica-dl-'));
      const samplePath = path.join(sampleDir, 'sample.mp4');
      let sampleOk = false;
      try {
        execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=24:duration=3',
          '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', samplePath],
          { stdio: 'pipe', timeout: 60000 });
        sampleOk = fs.existsSync(samplePath) && fs.statSync(samplePath).size > 60000;
      } catch (e) {}
      if (!sampleOk) {
        console.log('  SKIP  v2.7.0 download-strategy sections (ffmpeg/sample uplabdh nahi)');
      } else {
        const sampleBuf = fs.readFileSync(samplePath);
        const ariaDl = 'A silver robot dancing on a rooftop at sunset';
        const fpDl = tileIdentity.tileFingerprint(ariaDl, '');
        // Pages ek VIRTUAL https origin (flowgrid.test) se aati hain
        // — request interception har jawab memory se deta hai. Wajah:
        // is Chromium build par 127.0.0.1 ki taraf navigation Local
        // Network Access checks se block hoti hai (koi flag kaam nahi
        // karta). Asal HTTP server sirf ENGINE ke Node-side fetch ke
        // liye hai (tile-src shape ka video URL) — browser use sirf
        // string ke roop me padhta hai.
        const shell = (inner) => `<!doctype html><html><head><style>
          flow-grid-tile-container{display:block;width:300px;height:340px;background:#222;position:relative;margin:20px}
          .hover-dl{display:none;position:absolute;right:8px;top:8px;width:44px;height:44px}
          flow-grid-tile-container:hover .hover-dl{display:block}
          .more-btn{position:absolute;right:8px;top:8px;width:40px;height:40px}
          .cdk-overlay-pane{position:fixed;right:40px;top:80px;background:#333;padding:10px;z-index:99}
        </style></head><body>${inner}<script>
          window.__dl = async () => {
            const r = await fetch('/video.mp4');
            const b = await r.blob();
            const u = URL.createObjectURL(b);
            const a = document.createElement('a');
            a.href = u; a.download = 'flow-download.mp4';
            document.body.appendChild(a); a.click();
          };
        </script></body></html>`;
        const routes = {
          '/grid-src': shell(`<flow-grid-tile-container aria-label="${ariaDl}"><video src="__VIDEO_URL__"></video></flow-grid-tile-container>`),
          '/grid-menu': shell(`<flow-grid-tile-container aria-label="${ariaDl}"><video></video><button class="more-btn" aria-label="More options" onclick="window.__openMenu()">⋮</button></flow-grid-tile-container><script>window.__openMenu=()=>{const p=document.createElement('div');p.className='cdk-overlay-pane';const b=document.createElement('button');b.setAttribute('role','menuitem');b.textContent='Download';b.onclick=()=>window.__dl();p.appendChild(b);document.body.appendChild(p);};</script>`),
          '/grid-editor': shell(`<flow-grid-tile-container aria-label="${ariaDl}" onclick="window.__openEditor()"><video></video></flow-grid-tile-container><script>window.__openEditor=()=>{document.body.innerHTML='<div class="editor"><div class="toolbar"><button aria-label="Download media" onclick="window.__dl()">DL</button></div></div>';};</script>`),
          // v2.10.0 (d) menu-icon: asal Material menu item — icon ka
          // ligature text ("file_download") label ke saath jud jata
          // hai, to item ka poora text kabhi sirf "Download" nahi
          // banta. v2.8.0 ka exact match yahan marta tha (owner ke
          // PC run ka saboot); saaf wala matcher jeetna chahiye.
          '/grid-menu-icon': shell(`<flow-grid-tile-container aria-label="${ariaDl}"><video></video><button class="more-btn" aria-label="More options" onclick="window.__openMenu()">⋮</button></flow-grid-tile-container><script>window.__openMenu=()=>{const p=document.createElement('div');p.className='cdk-overlay-pane';const b=document.createElement('button');b.setAttribute('role','menuitem');const i=document.createElement('mat-icon');i.textContent='file_download';i.style.display='block';const s=document.createElement('span');s.textContent='Download';b.appendChild(i);b.appendChild(s);b.onclick=()=>window.__dl();p.appendChild(b);document.body.appendChild(p);};</script>`),
          // v2.10.0 (e) editor-strip: editor khulne par grid DOM se
          // NAHI hati — andar ki media strip wahi tile component
          // rakhti hai, sirf URL /edit/ par jata hai. v2.8.0 ki
          // tile-ginati wali jaanch yahan "grid par hi raha" jhooth
          // bolti thi; URL wali jaanch jeetni chahiye.
          '/grid-editor-strip': shell(`<flow-grid-tile-container aria-label="${ariaDl}" onclick="window.__openEditor()"><video></video></flow-grid-tile-container><script>window.__openEditor=()=>{history.pushState({}, '', '/project/p9/edit/w9');const e=document.createElement('div');e.className='editor';e.innerHTML='<div class="toolbar"><button aria-label="Download media" onclick="window.__dl()">DL</button></div><div class="strip"><flow-grid-tile-container aria-label="strip ki tile"></flow-grid-tile-container></div>';document.body.appendChild(e);};</script>`),
          // v2.10.0 (f) pagefetch: tile ka URL aisa hai jo Node wale
          // haath ke fetch se NAHI aata (virtual host — DNS hi fail),
          // lekin browser ke ANDAR wala fetch (apna jar/connection)
          // use la sakta hai. Jeet in-page fetch se honi chahiye.
          '/grid-pagefetch': shell(`<flow-grid-tile-container aria-label="${ariaDl}"><video src="__PAGEFETCH_URL__"></video></flow-grid-tile-container>`)
        };
        // Asal server: sirf engine ke Node fetch ke liye (tile-src).
        const server = http.createServer((req, res) => {
          if (req.url === '/video.mp4') {
            res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': sampleBuf.length });
            res.end(sampleBuf);
            return;
          }
          res.writeHead(404); res.end('nf');
        });
        await new Promise(r => server.listen(0, '127.0.0.1', r));
        const videoUrl = `http://127.0.0.1:${server.address().port}/video.mp4`;
        const base = 'https://flowgrid.test';
        try {
          const shapes = [
            { route: '/grid-src', strategy: 'tile-src', label: 'sirf video-src wala roop' },
            { route: '/grid-menu', strategy: 'native-menu', label: 'menu-only wala roop (exact "Download")' },
            { route: '/grid-editor', strategy: 'native-editor', label: 'editor top-bar ("Download media") wala roop' },
            { route: '/grid-menu-icon', strategy: 'native-menu', label: 'v2.10.0 menu-icon wala roop (ligature text ke saath "Download")' },
            { route: '/grid-editor-strip', strategy: 'native-editor', label: 'v2.10.0 editor-strip wala roop (grid DOM maujood, URL /edit/)' },
            { route: '/grid-pagefetch', strategy: 'tile-src', label: 'v2.10.0 in-page fetch wala roop (Node fetch fail, browser fetch jeet)', logExpect: 'in-browser fetch' }
          ];
          for (const shape of shapes) {
            const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsl-replica-out-'));
            const pageD = await browser.newPage();
            const shapeLogs = [];
            const engD = new FlowAutomationEngine({ onLog: (d) => shapeLogs.push(String((d && d.message) || '')), onTaskCompleted: () => {} }, {});
            // Virtual origin: page ke saare jawab memory se.
            await pageD.setRequestInterception(true);
            pageD.on('request', (req) => {
              const u = req.url();
              try {
                if (u === base + '/video.mp4') {
                  req.respond({ status: 200, contentType: 'video/mp4', body: sampleBuf });
                } else if (u === base + '/media-guarded.mp4') {
                  // Sirf page ke andar se aayi request (uska apna
                  // Referer) ko video milta hai — bahar ke haath ko
                  // 403. Node wala fetch is virtual host tak pahunch
                  // hi nahi sakta (DNS), asal jaanch in-page ki hai.
                  const ref = (req.headers()['referer'] || '');
                  if (ref.startsWith(base)) {
                    req.respond({ status: 200, contentType: 'video/mp4', body: sampleBuf });
                  } else {
                    req.respond({ status: 403, contentType: 'text/plain', body: 'forbidden' });
                  }
                } else if (u.startsWith(base + '/grid-')) {
                  const route = u.slice(base.length);
                  req.respond({ status: 200, contentType: 'text/html', body: (routes[route] || '').replace('__VIDEO_URL__', videoUrl).replace('__PAGEFETCH_URL__', base + '/media-guarded.mp4') });
                } else if (u === videoUrl) {
                  req.respond({ status: 200, contentType: 'video/mp4', body: sampleBuf });
                } else {
                  req.abort();
                }
              } catch (e) { try { req.abort(); } catch (e2) {} }
            });
            await pageD.goto(base + shape.route, { waitUntil: 'load' });
            engD.page = pageD;
            engD.currentAccount = { id: 'acc_dl', name: 'DL Account' };
            engD.browserDownloadDir = dlDir;
            const taskD = {
              videoId: 'v_dl_' + shape.strategy,
              promptText: 'a silver robot dancing on a rooftop at sunset cinematic',
              promptIndex: 0, startTime: Date.now(), tileIndex: 0,
              lockedTileFingerprint: fpDl, preExistingFingerprints: []
            };
            const dl = await engD.downloadTaskMedia(taskD, dlDir, { type: 'Video' });
            assert(dl.ok === true, `download strategies [${shape.label}]: download safal (attempts: ${JSON.stringify(dl.attempts)})`);
            assert(dl.strategy === shape.strategy, `download strategies [${shape.label}]: jeetne wali ranneeti '${shape.strategy}' (got '${dl.strategy}')`);
            assert(taskD.mediaSaved === true && taskD.result && fs.existsSync(taskD.result.filePath),
              `download strategies [${shape.label}]: file asal me save hui (${taskD.result && taskD.result.fileName})`);
            if (shape.logExpect) {
              assert(shapeLogs.some(l => l.includes(shape.logExpect)),
                `download strategies [${shape.label}]: jeet ki saaf log line aayi ("${shape.logExpect}") — aakhri logs: ${shapeLogs.slice(-4).join(' | ')}`);
            }
            await pageD.close();
            fs.rmSync(dlDir, { recursive: true, force: true });
          }
        } finally {
          server.close();
        }
        fs.rmSync(sampleDir, { recursive: true, force: true });
      }
    }

    // 16. v2.7.0 MONITOR-LEVEL download fail (owner ke burst run ka
    //     chhota roop): tile render complete (badge) hai lekin us par
    //     na URL hai, na koi download button/menu — saari ranneetiyan
    //     fail. Task stage 'download' ke saath fail ho, jhooti
    //     success line NA aaye, sach wali ginati aaye, progress ki
    //     EK hi awaaz ho, aur stream raste ki khamoshi khatam ho.
    {
      await page.setContent('<!doctype html><html><body><div id="grid"></div></body></html>', { waitUntil: 'load' });
      const logs = [];
      const events = { failed: [], completed: [] };
      const engF = new FlowAutomationEngine({
        onLog: (d) => logs.push(String(d.message || '')),
        onTaskFailed: (t, reason) => events.failed.push({ reason, stage: t.failureStage }),
        onTaskCompleted: (t, result) => events.completed.push(result)
      }, { stallTimeoutSec: 30, recoveryWindowSec: 60, recoveryScanEveryMs: 1000, heartbeatEveryMs: 1000 });
      engF.page = page;
      engF.currentAccount = { id: 'acc_fail', name: 'Fail Account' };
      const aria = 'A silver robot dancing on a rooftop at sunset';
      const task = {
        videoId: 'v_df_1',
        promptText: 'a silver robot dancing on a rooftop at sunset cinematic',
        promptIndex: 0, startTime: Date.now(), tileIndex: -1, preExistingFingerprints: []
      };
      await page.evaluate((label) => {
        const c = document.createElement('flow-grid-tile-container');
        c.setAttribute('aria-label', label);
        const s = document.createElement('span');
        s.textContent = '50%';
        c.appendChild(s);
        document.getElementById('grid').appendChild(c);
      }, aria);
      const monitorPromise = engF.waitForAccountTasks([task], os.tmpdir(), { type: 'Video' }, false);
      setTimeout(() => {
        page.evaluate(() => {
          const c = document.querySelector('flow-grid-tile-container');
          if (!c) return;
          c.innerHTML = '';
          const s = document.createElement('span');
          s.textContent = '360p';
          c.appendChild(s);
        }).catch(() => {});
      }, 4000);
      await monitorPromise;
      assert(events.completed.length === 0, 'download-fail: koi completion nahi hua');
      assert(events.failed.length === 1 && events.failed[0].stage === 'download',
        `download-fail: failure stage 'download' ke saath aaya (got ${JSON.stringify(events.failed)})`);
      assert(/^Download failed/.test(events.failed[0].reason || ''), 'download-fail: wajah "Download failed" se shuru hoti hai');
      assert(!logs.some(l => l.includes('Download complete')), 'jhooti success line NAHI aayi (ek bhi file save nahi hui thi)');
      assert(logs.some(l => /0 videos were downloaded, 1 failed \(stage: download\)/.test(l)), 'sach wali settle line aayi: 0 download hue, 1 fail (stage: download)');
      assert(!logs.some(l => /Video ban raha hai: \d+%/.test(l)), 'progress ki do-foldi awaaz NAHI (purani % wali log line band)');
      assert(logs.some(l => l.includes('generating on Flow — 50% done')), 'progress ki EK awaaz (tileState narration) maujood hai');
      assert(logs.some(l => l.includes('No media URL of this task was found')), 'stream raste ki khamoshi khatam — URL na milne ki wajah log hui');
    }

    // 17. v2.8.0 BACKEND NETWORK CAPTURE — nakli Flow backend asal
    //     jaisa bartav karta hai: submit par workflowId wapas, status
    //     API (JSON poll) pehle processing phir media URL ke saath
    //     complete. Tile par video element DER se aata hai aur us par
    //     NA koi src hai NA koi download button — UI se download
    //     namumkin hai; file SIRF backend fetch se aa sakti hai.
    //     Media ek asal local server se aata hai jo SESSION COOKIE
    //     maangta hai (bina cookie ke 403) — engine ka authenticated
    //     fetch (page ke cookies ke saath) hi file la sakta hai.
    //       (a) seedha: {workflowId, videoUrl} wale pakke naam.
    //       (b) field-naam alag: {workflow_id} + outputs[].mediaUri.
    //       (c) ulte kram: do parallel generations, peeche wala
    //           pehle complete — workflowId ki pehchan se har task
    //           ko USI ki file (bytes tak ka milan).
    {
      const http = require('http');
      const { execFileSync } = require('child_process');
      const beDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsl-replica-be-'));
      const mkSample = (name, size, dur) => {
        const p = path.join(beDir, name);
        try {
          execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=24:duration=${dur}`,
            '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', p],
            { stdio: 'pipe', timeout: 60000 });
        } catch (e) {}
        return (fs.existsSync(p) && fs.statSync(p).size > 60000) ? fs.readFileSync(p) : null;
      };
      const bufA = mkSample('sampleA.mp4', '360x640', 3);
      const bufB = mkSample('sampleB.mp4', '320x568', 2);
      if (!bufA || !bufB || bufA.equals(bufB)) {
        console.log('  SKIP  v2.8.0 backend sections (do alag sample videos nahi ban paye)');
      } else {
        const SECRET = 'fs_session=replica-secret';
        const mediaServer = http.createServer((req, res) => {
          const cookie = String(req.headers.cookie || '');
          if (!cookie.includes(SECRET)) { res.writeHead(403); res.end('cookie chahiye'); return; }
          if (req.url === '/media/A.mp4') { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bufA.length }); res.end(bufA); return; }
          if (req.url === '/media/B.mp4') { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bufB.length }); res.end(bufB); return; }
          res.writeHead(404); res.end('nf');
        });
        await new Promise(r => mediaServer.listen(0, '127.0.0.1', r));
        const mediaA = `http://127.0.0.1:${mediaServer.address().port}/media/A.mp4`;
        const mediaB = `http://127.0.0.1:${mediaServer.address().port}/media/B.mp4`;
        const beBase = 'https://flowbe.test';
        const appHtml = `<!doctype html><html><body>
          <div class="prosemirror-editor"><div class="ProseMirror" contenteditable="true"></div></div>
          <div id="grid"></div>
          <script>
            window.__submit = async (slot) => {
              const r = await fetch('/api/submit/' + slot, { method: 'POST' });
              const j = await r.json();
              const wid = j.workflowId || j.workflow_id;
              const poll = async () => {
                const s = await (await fetch('/api/status/' + wid)).json();
                const done = s.status === 'complete' || s.state === 'done';
                if (done) {
                  const c = document.createElement('flow-grid-tile-container');
                  c.setAttribute('aria-label', 'backend tile ' + wid);
                  c.appendChild(document.createElement('video'));
                  document.getElementById('grid').appendChild(c);
                  return;
                }
                setTimeout(poll, 600);
              };
              setTimeout(poll, 600);
            };
          </script></body></html>`;
        // Status state machine: har workflow ke polls ginata hai.
        const mkApi = (defs) => {
          const counts = {};
          return (url) => {
            let m = url.match(/\/api\/submit\/(.+)$/);
            if (m && defs[m[1]]) return { status: 200, contentType: 'application/json', body: JSON.stringify(defs[m[1]].submitBody) };
            m = url.match(/\/api\/status\/(.+)$/);
            if (m) {
              const def = Object.values(defs).find(d => d.wid === m[1]);
              if (!def) return null;
              counts[m[1]] = (counts[m[1]] || 0) + 1;
              return { status: 200, contentType: 'application/json', body: JSON.stringify(def.bodyFor(counts[m[1]])) };
            }
            return null;
          };
        };
        const waitForSaved = async (task, ms) => {
          const t0 = Date.now();
          while (Date.now() - t0 < ms) {
            if (task.mediaSaved) return true;
            await new Promise(r => setTimeout(r, 250));
          }
          return task.mediaSaved === true;
        };
        const runBackendPage = async (apiFn) => {
          const pageX = await browser.newPage();
          await pageX.setRequestInterception(true);
          pageX.on('request', (req) => {
            const u = req.url();
            try {
              if (u === beBase + '/app') { req.respond({ status: 200, contentType: 'text/html', body: appHtml }); return; }
              if (u.startsWith(beBase + '/api/')) {
                const out = apiFn(u.slice(beBase.length));
                if (out) { req.respond(out); return; }
              }
              req.abort();
            } catch (e) { try { req.abort(); } catch (e2) {} }
          });
          await pageX.goto(beBase + '/app', { waitUntil: 'load' });
          await pageX.setCookie({ name: 'fs_session', value: 'replica-secret', url: beBase });
          const engX = new FlowAutomationEngine({ onLog: () => {}, onTaskCompleted: () => {} }, {});
          engX.page = pageX;
          engX.currentAccount = { id: 'acc_be', name: 'BE Account' };
          engX.netCapture.attach(pageX);
          return { pageX, engX };
        };
        const mkTask = (key, idx, text) => ({
          videoId: key, captureKey: key, promptIndex: idx, promptText: text,
          startTime: Date.now(), tileIndex: -1, preExistingFingerprints: [], preExistingVideoUrls: new Set()
        });
        try {
          // (a) SEEDHA roop: pakke field naam (workflowId / videoUrl).
          {
            const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsl-be-out-'));
            const api = mkApi({ one: { wid: 'wf_replica_1', submitBody: { workflowId: 'wf_replica_1' },
              bodyFor: (n) => n < 2 ? { status: 'processing', workflowId: 'wf_replica_1' } : { status: 'complete', workflowId: 'wf_replica_1', videoUrl: mediaA } } });
            const { pageX, engX } = await runBackendPage(api);
            const task = mkTask('bk_one', 0, 'backend prompt ek');
            engX.registerBackendTask(task, dlDir, { type: 'Video' });
            engX.netCapture.beginSubmission('bk_one', Date.now());
            await pageX.evaluate(() => window.__submit('one'));
            const saved = await waitForSaved(task, 30000);
            assert(saved, 'backend (a) seedha: file backend fetch se save hui (tile par na src tha na button)');
            assert(task.result && fs.existsSync(task.result.filePath), 'backend (a): save hui file maujood hai');
            assert(fs.readFileSync(task.result.filePath).equals(bufA), 'backend (a): file ke bytes asal A video se milte hain');
            const bound = engX.netCapture.urlForKey('bk_one');
            assert(bound && bound.via === 'workflow-id', 'backend (a): bandhan workflowId se hua');
            await pageX.close();
            fs.rmSync(dlDir, { recursive: true, force: true });
          }
          // (b) FIELD-NAAM ALAG: workflow_id + outputs[].mediaUri.
          {
            const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsl-be-out-'));
            const api = mkApi({ two: { wid: 'wf_replica_2', submitBody: { workflow_id: 'wf_replica_2' },
              bodyFor: (n) => n < 2 ? { state: 'processing', workflow_id: 'wf_replica_2' } : { state: 'done', workflow_id: 'wf_replica_2', outputs: [{ mediaUri: mediaB }] } } });
            const { pageX, engX } = await runBackendPage(api);
            const task = mkTask('bk_two', 0, 'backend prompt do');
            engX.registerBackendTask(task, dlDir, { type: 'Video' });
            engX.netCapture.beginSubmission('bk_two', Date.now());
            await pageX.evaluate(() => window.__submit('two'));
            const saved = await waitForSaved(task, 30000);
            assert(saved, 'backend (b) field-naam alag: file save hui (generic pattern kaam kiya)');
            assert(fs.readFileSync(task.result.filePath).equals(bufB), 'backend (b): file ke bytes asal B video se milte hain');
            const bound = engX.netCapture.urlForKey('bk_two');
            assert(bound && bound.via === 'workflow-id', 'backend (b): bandhan workflow_id se bhi workflow-id hi mana gaya');
            await pageX.close();
            fs.rmSync(dlDir, { recursive: true, force: true });
          }
          // (c) ULTE KRAM: parB pehle complete, parA baad me — har
          //     task ko USI ki file (bytes se sabit).
          {
            const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsl-be-out-'));
            const api = mkApi({
              parA: { wid: 'wf_para_A', submitBody: { workflowId: 'wf_para_A' },
                bodyFor: (n) => n < 3 ? { status: 'processing', workflowId: 'wf_para_A' } : { status: 'complete', workflowId: 'wf_para_A', videoUrl: mediaA } },
              parB: { wid: 'wf_para_B', submitBody: { workflowId: 'wf_para_B' },
                bodyFor: (n) => n < 1 ? { status: 'processing', workflowId: 'wf_para_B' } : { status: 'complete', workflowId: 'wf_para_B', videoUrl: mediaB } }
            });
            const { pageX, engX } = await runBackendPage(api);
            const taskA = mkTask('bk_pa', 0, 'parallel prompt A');
            const taskB = mkTask('bk_pb', 1, 'parallel prompt B');
            engX.registerBackendTask(taskA, dlDir, { type: 'Video' });
            engX.registerBackendTask(taskB, dlDir, { type: 'Video' });
            engX.netCapture.beginSubmission('bk_pa', Date.now());
            await pageX.evaluate(() => window.__submit('parA'));
            engX.netCapture.beginSubmission('bk_pb', Date.now());
            await pageX.evaluate(() => window.__submit('parB'));
            const savedB = await waitForSaved(taskB, 30000);
            assert(savedB, 'backend (c) ulte kram: peeche submit hua B pehle complete hokar save hua');
            assert(taskA.mediaSaved !== true, 'backend (c): B ke complete hone par A abhi save NAHI hua (pehchan alag hai)');
            const savedA = await waitForSaved(taskA, 30000);
            assert(savedA, 'backend (c): A bhi apne link se save hua');
            assert(fs.readFileSync(taskA.result.filePath).equals(bufA), 'backend (c): A ki file = A ka video (bytes)');
            assert(fs.readFileSync(taskB.result.filePath).equals(bufB), 'backend (c): B ki file = B ka video (bytes) — ulte kram me bhi galat video NAHI');
            await pageX.close();
            fs.rmSync(dlDir, { recursive: true, force: true });
          }
        } finally {
          mediaServer.close();
        }
        fs.rmSync(beDir, { recursive: true, force: true });
      }
    }

    // 18. v2.9.0 JHOOTHA "SAFETY FILTER" — owner ka asal case
    //     (2026-10-15, v2.8.0): credit check khud account/credits
    //     wala [role="dialog"] panel kholta hai; uske pure text me
    //     "Switch account", credits wali kataar (movie_filter_auto
    //     icon) aur footer ke "Privacy Policy / Terms of Service"
    //     hote hain. Purana page-global modal scan isi panel par
    //     bare-substring ('policy'/'terms') se trigger hokar fresh
    //     tasks ko "Google Safety Filter: <panel ka kata majmua>"
    //     se maar deta tha. AB: panel khula pada hai, tile sehatmand
    //     generating hai — koi fail NAHI hona chahiye, render aage
    //     badhna chahiye, task complete hona chahiye (aur fail na
    //     hone ka matlab: pool kabhi resubmit nahi karega — submit
    //     count 1 hi rahega).
    {
      const popoverHtml = `<div role="dialog" class="account-panel" style="position:absolute;top:0;right:0;width:320px;height:430px;background:#222;z-index:5;">
        <mat-icon>close</mat-icon>
        <div>Mohd Aslam</div><div>Mohda.ktanwar@gmail.com</div>
        <button>Switch account</button>
        <mat-icon>movie_filter_auto</mat-icon><span>46 Google Flow credits</span>
        <div>Credits refresh daily at 9:02 AM</div><button>Upgrade</button>
        <mat-icon>person</mat-icon><span>Create avatar</span>
        <div>Privacy Policy</div><div>Terms of Service</div>
      </div>`;
      await page.setContent(`<!doctype html><html><body>${popoverHtml}<div id="grid"></div></body></html>`, { waitUntil: 'load' });
      const events = { failed: [], completed: [] };
      const logs = [];
      const eng6 = new FlowAutomationEngine({
        onLog: (m) => logs.push(String(m)),
        onTaskFailed: (t, reason) => events.failed.push(reason),
        onTaskCompleted: (t, result) => events.completed.push(result)
      }, { stallTimeoutSec: 3, recoveryWindowSec: 60, recoveryScanEveryMs: 1000, heartbeatEveryMs: 1000 });
      eng6.page = page;
      eng6.currentAccount = { id: 'acc_replica', name: 'Replica Account' };
      eng6.downloadViaFlowNativeMenu = async () => false;
      eng6.downloadFromCapturedStream = async (task) => {
        task.downloaded = true;
        task.completed = true;
        eng6.onTaskCompleted(task, { filePath: '/tmp/popover.mp4', fileName: 'popover.mp4', fileSizeMb: '1.0' });
        return true;
      };
      const popTask = {
        videoId: 'v_popover_1',
        promptText: 'a silver robot dancing on a rooftop at sunset cinematic',
        promptIndex: 0,
        startTime: Date.now(),
        tileIndex: -1,
        preExistingFingerprints: []
      };
      const monitorPromise = eng6.waitForAccountTasks([popTask], os.tmpdir(), { type: 'Video' }, false);
      setTimeout(() => {
        page.evaluate(() => {
          const c = document.createElement('flow-grid-tile-container');
          c.setAttribute('aria-label', 'A silver robot dancing on a rooftop at sunset');
          const s = document.createElement('span');
          s.textContent = '50%';
          c.appendChild(s);
          document.getElementById('grid').appendChild(c);
        }).catch(() => {});
      }, 3000);
      setTimeout(() => {
        page.evaluate(() => {
          const c = document.querySelector('flow-grid-tile-container');
          if (!c) return;
          c.innerHTML = '';
          const v = document.createElement('video');
          v.src = 'https://cdn.example/POPOVER.mp4';
          c.appendChild(v);
          const s = document.createElement('span');
          s.textContent = '360p';
          c.appendChild(s);
        }).catch(() => {});
      }, 7000);
      await monitorPromise;
      assert(events.failed.length === 0, `jhootha saboot: khula account popover koi fail NAHI banata (failures: ${JSON.stringify(events.failed)})`);
      assert(!logs.some(l => l.includes('Google Safety Filter')), 'jhootha saboot: log me "Google Safety Filter" ka jhootha fail NAHI aaya');
      assert(events.completed.length === 1 && popTask.downloaded === true, 'jhootha saboot: render aage badha aur task complete hua (submit dobara fire NAHI hoga)');
    }

    // 19. v2.9.0 ASAL REFUSAL — tile ke ANDAR pakka jumla: fast fail
    //     hona chahiye, aur wajah SIRF wahi tile ke andar ka jumla —
    //     page ke dusre hisso (header ka account text) ka majmua
    //     wajah me kabhi NAHI.
    {
      await page.setContent(`<!doctype html><html><body>
        <div id="hdr">Mohd Aslam Switch account 46 Google Flow credits</div>
        <div id="grid">
          <flow-grid-tile-container aria-label="A dancing robot in a neon city at night with glowing lights and music">
            <mat-icon>error</mat-icon>
            <span>Couldn't generate this. It violates our content policy.</span>
          </flow-grid-tile-container>
        </div></body></html>`, { waitUntil: 'load' });
      const events = { failed: [], completed: [] };
      const eng7 = new FlowAutomationEngine({
        onLog: () => {},
        onTaskFailed: (t, reason) => events.failed.push(reason),
        onTaskCompleted: (t, result) => events.completed.push(result)
      }, { stallTimeoutSec: 30, recoveryWindowSec: 45, recoveryScanEveryMs: 1000, heartbeatEveryMs: 1000 });
      eng7.page = page;
      eng7.currentAccount = { id: 'acc_replica', name: 'Replica Account' };
      eng7.downloadViaFlowNativeMenu = async () => false;
      eng7.downloadFromCapturedStream = async () => false;
      const refusalTask = {
        videoId: 'v_refusal_1',
        promptText: 'a dancing robot in a neon city at night with glowing lights and music',
        promptIndex: 0,
        startTime: Date.now(),
        tileIndex: -1,
        preExistingFingerprints: []
      };
      const t0 = Date.now();
      await eng7.waitForAccountTasks([refusalTask], os.tmpdir(), { type: 'Video' }, false);
      const elapsedSec = (Date.now() - t0) / 1000;
      assert(events.failed.length === 1, `asal refusal: exactly ek fail aaya (got ${events.failed.length})`);
      assert(/violates our content policy/i.test(events.failed[0] || ''), `asal refusal: wajah tile ka asal jumla hai (got: ${events.failed[0]})`);
      assert(!/Switch account|Mohd Aslam/.test(events.failed[0] || ''), 'asal refusal: wajah me page ke dusre hisso ka majmua NAHI hai');
      assert(events.completed.length === 0, 'asal refusal: task complete NAHI hua');
      assert(elapsedSec < 30, `asal refusal: fast fail hua — recovery window (45s) ka intezaar NAHI (${elapsedSec.toFixed(1)}s)`);
    }

    console.log('\nREPLICA PASS');
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
