'use strict';

/**
 * FlowStudio Lite — Generate prompt parsing.
 *
 * v1.1 rule (paragraph mode): prompts are BLOCKS separated by one or
 * more blank lines — the owner's storyboards are multi-line paragraphs
 * and must never be shredded per line.
 * v2.0.0 BULK mode: ONE LINE = ONE PROMPT, verbatim.
 *
 * v2.3.0 SMART AUTO PARSER (owner's order): the owner pastes prompt
 * lists in MANY tag styles — `scene1`, `Scene 1`, `prompt2`,
 * `PROMPT #1`, `1.`, `1)`, `1:`, `#1`, `#01`, `#00-01`… The auto
 * parser DETECTS the marker family itself and splits on it:
 *   - A marker only counts at the START of a line. Numbers/hashtags
 *     inside a prompt's text (dialogue like "mera #1 kaam", "5 minute
 *     baad") NEVER split a prompt.
 *   - When markers exist they WIN over blank-line/line splitting,
 *     even in a mixed paste; with several families present, the most
 *     consistent one (most hits; ties broken by the priority order
 *     below) is followed, so the preview always shows one clear rule.
 *   - Every item carries its TAG exactly as found (`#00-01`,
 *     `scene3`, `prompt2`, `1`); items without a marker get an
 *     auto tag `sceneNNN` by position. Downloads are named by tag
 *     and the sequence report is checked by tag.
 *   - No markers at all -> paragraph blocks, else one-line-each,
 *     else a single prompt (multi-line prompts without markers or
 *     blank lines are indistinguishable from one big prompt — the
 *     detect line says so and the owner can switch mode by hand).
 */
function parsePromptBlocks(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(/\r?\n(?:[ \t]*\r?\n)+/)
    .map(block => block.replace(/\s*\r?\n\s*/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function parsePromptLines(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

function autoTagFor(position) {
  // Owner's naming rule (2026-10-16): a prompt with NO tag of its
  // own is saved by its NUMBER in the list — 01.mp4, 02.mp4, …
  return String(position + 1).padStart(2, '0');
}

function collapseText(parts) {
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

// After a marker, an optional single separator run (`:`, `)`, `.`,
// `-`, spaces) is not part of the prompt text.
function stripMarkerRest(line, matchEnd) {
  return line.slice(matchEnd).replace(/^\s*[:.)\],-]?\s*/, '');
}

const MARKER_FAMILIES = [
  {
    id: 'range',
    label: '#00-01 tags',
    match(line) {
      const m = line.match(/^\s*#(\d{1,4})\s*-\s*(\d{1,4})(?=[\s:.)\],]|$)/);
      if (!m) return null;
      return { tag: `#${m[1]}-${m[2]}`, rest: stripMarkerRest(line, m[0].length) };
    }
  },
  {
    id: 'hash',
    label: '# number tags',
    match(line) {
      const m = line.match(/^\s*#(\d{1,4})(?=[\s:.)\],]|$)/);
      if (!m) return null;
      return { tag: `#${m[1]}`, rest: stripMarkerRest(line, m[0].length) };
    }
  },
  {
    id: 'scene',
    label: 'Scene labels',
    match(line) {
      const m = line.match(/^\s*(scenes?\s*#?\s*\d{1,4})(?=[\s:.)\],-]|$)/i);
      if (!m) return null;
      return { tag: m[1].replace(/\s+/g, ' ').trim(), rest: stripMarkerRest(line, m[0].length) };
    }
  },
  {
    id: 'prompt',
    label: 'Prompt labels',
    match(line) {
      const m = line.match(/^\s*(prompts?\s*#?\s*\d{1,4})(?=[\s:.)\],-]|$)/i);
      if (!m) return null;
      return { tag: m[1].replace(/\s+/g, ' ').trim(), rest: stripMarkerRest(line, m[0].length) };
    }
  },
  {
    id: 'number',
    label: 'numbered list (1. / 1) / 1:)',
    match(line) {
      const alone = line.match(/^\s*(\d{1,4})\s*$/);
      if (alone) return { tag: alone[1], rest: '' };
      const m = line.match(/^\s*(\d{1,4})\s*[.):](?=\s|$)/);
      if (!m) return null;
      return { tag: m[1], rest: stripMarkerRest(line, m[0].length) };
    }
  },
  {
    id: 'barenumber',
    label: 'numbered lines',
    // A bare number + space at line start is ambiguous (a prompt can
    // start "5 minute baad…"), so this family only counts when the
    // hits form a strictly ascending +1 sequence of at least 2.
    match(line) {
      const m = line.match(/^\s*(\d{1,4})[ \t]+(?=\S)/);
      if (!m) return null;
      return { tag: m[1], rest: line.slice(m[0].length) };
    },
    validate(hits) {
      if (hits.length < 2) return false;
      // Somewhere in the paste there must be an ascending +1 run of
      // at least 2 — a stray number-led prose line ("5 minute baad…")
      // on its own never forms a family.
      let best = 1;
      let run = 1;
      for (let i = 1; i < hits.length; i++) {
        run = (parseInt(hits[i].tag, 10) === parseInt(hits[i - 1].tag, 10) + 1) ? run + 1 : 1;
        if (run > best) best = run;
      }
      return best >= 2;
    }
  }
];

function detectMarkerFamily(lines) {
  let best = null;
  for (const family of MARKER_FAMILIES) {
    const hits = [];
    for (const line of lines) {
      const hit = family.match(line);
      if (hit) hits.push(hit);
    }
    if (hits.length === 0) continue;
    if (typeof family.validate === 'function' && !family.validate(hits)) continue;
    if (!best || hits.length > best.hits.length) {
      best = { family, hits };
    }
  }
  return best ? best.family : null;
}

function splitByMarkers(lines, family) {
  const items = [];
  let current = null;
  const preamble = [];
  let lastBareNum = null;
  const flush = () => {
    if (current) items.push(current);
    current = null;
  };
  for (const line of lines) {
    let hit = family.match(line);
    // Bare numbers are the one ambiguous family: once the ascending
    // run breaks, later number-led lines are prompt prose, not markers.
    if (hit && family.id === 'barenumber') {
      const n = parseInt(hit.tag, 10);
      if (lastBareNum !== null && n !== lastBareNum + 1) hit = null;
      else lastBareNum = n;
    }
    if (hit) {
      flush();
      current = { tag: hit.tag, parts: [] };
      if (hit.rest && hit.rest.trim()) current.parts.push(hit.rest.trim());
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) continue; // blank lines never split in marker mode
    if (current) current.parts.push(trimmed);
    else preamble.push(trimmed);
  }
  flush();
  const out = [];
  if (preamble.length > 0) out.push({ tag: null, text: collapseText(preamble) });
  for (const item of items) {
    const text = collapseText(item.parts);
    if (text) out.push({ tag: item.tag, text });
  }
  return out;
}

/**
 * The auto detector. Returns:
 *   { items: [{ text, tag }], style, styleLabel, markerFamily }
 * style: 'tags' | 'paragraph' | 'lines' | 'single' | 'empty'
 */
function parsePromptsAuto(raw) {
  if (!raw || typeof raw !== 'string' || !raw.trim()) {
    return { items: [], style: 'empty', styleLabel: 'kuch nahi', markerFamily: null };
  }
  const lines = raw.split(/\r?\n/);
  const family = detectMarkerFamily(lines);
  if (family) {
    const rawItems = splitByMarkers(lines, family);
    const items = rawItems.map((item, i) => ({
      text: item.text,
      tag: item.tag || autoTagFor(i)
    }));
    if (items.length > 0) {
      return { items, style: 'tags', styleLabel: family.label, markerFamily: family.id };
    }
  }
  const blocks = parsePromptBlocks(raw);
  if (blocks.length > 1) {
    return {
      items: blocks.map((text, i) => ({ text, tag: autoTagFor(i) })),
      style: 'paragraph',
      styleLabel: 'paragraph (blank line se alag)',
      markerFamily: null
    };
  }
  const lineItems = parsePromptLines(raw);
  if (lineItems.length > 1) {
    return {
      items: lineItems.map((text, i) => ({ text, tag: autoTagFor(i) })),
      style: 'lines',
      styleLabel: 'one line = one prompt',
      markerFamily: null
    };
  }
  if (lineItems.length === 1) {
    return {
      items: [{ text: lineItems[0], tag: autoTagFor(0) }],
      style: 'single',
      styleLabel: 'ek hi prompt',
      markerFamily: null
    };
  }
  return { items: [], style: 'empty', styleLabel: 'kuch nahi', markerFamily: null };
}

/**
 * Mode-aware parse for the Generate page. v2.5.0: the owner asked for
 * exactly TWO modes with simple names —
 *   'bulk'      = the SMART parser (all tag styles detected inside:
 *                 #00-01 / #1 / scene / prompt / numbers, else lines)
 *   'paragraph' = blank-line separated, one paragraph = one prompt
 * Legacy mode strings from older saves migrate safely onto the two:
 *   'auto' / 'lines' -> 'bulk' (the smart parser covers both: a
 *                       line-list paste is detected as lines inside)
 *   'blocks'         -> 'paragraph'
 * Every item still gets a tag (auto `sceneNNN`) so downloads and the
 * sequence report work in every mode.
 */
function normalizePromptMode(mode) {
  if (mode === 'paragraph' || mode === 'blocks') return 'paragraph';
  return 'bulk';
}

function parsePromptsDetailed(raw, mode) {
  if (normalizePromptMode(mode) === 'paragraph') {
    const texts = parsePromptBlocks(raw);
    return {
      items: texts.map((text, i) => ({ text, tag: autoTagFor(i) })),
      style: 'paragraph',
      styleLabel: 'paragraph (blank line se alag)',
      markerFamily: null
    };
  }
  return parsePromptsAuto(raw);
}

if (typeof window !== 'undefined') {
  window.parsePromptBlocks = parsePromptBlocks;
  window.parsePromptLines = parsePromptLines;
  window.parsePromptsAuto = parsePromptsAuto;
  window.parsePromptsDetailed = parsePromptsDetailed;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parsePromptBlocks, parsePromptLines, parsePromptsAuto, parsePromptsDetailed, normalizePromptMode };
}
