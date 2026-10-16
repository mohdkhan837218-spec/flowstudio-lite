'use strict';

/**
 * FlowStudio Lite — render tile state classifier (v2.4.0).
 *
 * WHY: on the owner's PC (2026-10-14, run 1) the log sat SILENT for
 * over four minutes while a paid render was in flight. The monitor
 * only spoke when a percentage changed or the 120s stall guard fired,
 * so the owner could not tell whether Flow was working, stuck, or had
 * refused. The tile's real condition was knowable all along — the
 * canvas read already reports isGenerating / isFailed / isReady per
 * tile — it was just never classified and narrated.
 *
 * This module turns one poll's facts into ONE named state per task,
 * and renders the plain-language line for it. Pure functions; the
 * monitor (flowAutomation.waitForAccountTasks) feeds it each poll and
 * logs on state changes + on the heartbeat cadence.
 *
 * States:
 *   'failed'         the task's tile shows a Flow failure — act now,
 *                    never wait out the recovery window for this.
 *   'ready'          the tile finished — download machinery takes it.
 *   'generating'     the tile exists and is rendering (progress mark
 *                    seen, or it was seen rendering before, or the tile
 *                    simply exists quietly — Flow tiles can sit
 *                    without a percentage while they render).
 *   'absent-active'  no tile bound to this task yet, but SOME tile on
 *                    the grid is generating — render activity exists,
 *                    this task's tile is still to be identified.
 *   'absent'         no tile, and the grid is quiet — Flow may not
 *                    have accepted/created the render at all.
 */

const STATES = ['failed', 'ready', 'generating', 'absent-active', 'absent'];

function classifyTaskTile(obs = {}) {
  const tile = obs.tile || null;
  if (tile) {
    if (tile.isFailed) return 'failed';
    if (tile.isReady) return 'ready';
    return 'generating';
  }
  if (obs.anyGenerating) return 'absent-active';
  return 'absent';
}

/** Plain duration for heartbeat lines: 65 -> '1 min 5 s'. */
function formatElapsed(totalSec) {
  const s = Math.max(0, Math.round(Number(totalSec) || 0));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} min ${r} s` : `${m} min`;
}

/**
 * The one-line plain description of a task's state for the log /
 * Activity heartbeat. `facts`: { promptIndex, elapsedSec, percentage }
 * (percentage may be null). Never contains technical jargon.
 */
function describeState(state, facts = {}) {
  const n = (typeof facts.promptIndex === 'number' ? facts.promptIndex : 0) + 1;
  const waited = formatElapsed(facts.elapsedSec);
  switch (state) {
    case 'generating':
      return facts.percentage
        ? `[Prompt #${n}] Flow par video ban raha hai — ${facts.percentage} ho gaya hai, kul ${waited} ka intezaar.`
        : `[Prompt #${n}] Flow par video ban raha hai — tile project me dikhai de rahi hai, kul ${waited} ka intezaar (kabhi-kabhi Flow percentage nahi dikhata, video phir bhi banta rehta hai).`;
    case 'ready':
      return `[Prompt #${n}] Video Flow par ban chuka hai — ab download ho raha hai (kul ${waited} lage).`;
    case 'failed':
      return `[Prompt #${n}] Flow ne is video ko fail dikhaya hai — wajah neeche wali line me hai, is par lamba intezaar NAHI hoga.`;
    case 'absent-active':
      return `[Prompt #${n}] Is prompt ki tile abhi pehchani nahi gayi, lekin Flow par kuch ban raha hai (kul ${waited}) — tile dhoondhna jari hai.`;
    case 'absent':
    default:
      return `[Prompt #${n}] Flow ne abhi tak is prompt ki koi tile nahi banayi (kul ${waited}) — ho sakta hai prompt Flow par accept hi nahi hua; tile ki talaash (recovery scan) jari hai.`;
  }
}

module.exports = { STATES, classifyTaskTile, describeState, formatElapsed };
