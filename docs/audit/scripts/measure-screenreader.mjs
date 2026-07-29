#!/usr/bin/env node
/**
 * Category 7 — the screen-reader bullet (p.7):
 *   "Test with a screen reader (VoiceOver, NVDA, or similar). Can you understand
 *    the page structure and interact with all controls?"
 *
 * Drives the real VoiceOver process on macOS via guidepup, against Safari, and
 * records what VoiceOver actually speaks. This is the screen reader itself — not
 * the accessibility-tree proxy in measure-a11y-tree.mjs, which reads the tree a
 * screen reader consumes without running one.
 *
 * What this settles objectively: whether each control is announced with a usable
 * name and role, and whether landmarks and headings are exposed. What it cannot
 * settle: whether the speech is comprehensible in practice. That is a human
 * judgement and stays one — the full transcript is written out so a person can
 * read what was said and answer p.7 directly.
 *
 * PREREQUISITES (one-time):
 *   npx @guidepup/setup setup            # enables VoiceOver AppleScript control
 *   npx @guidepup/setup install voiceover # downloads the preferences bundle
 *   System Settings -> Privacy & Security -> Accessibility: enable AEServer and
 *   the terminal application. Apple Events are dispatched by AEServer, so the
 *   grant lands there rather than on the terminal binary alone.
 *
 * NOTE ON SPEECH RATE: guidepup mounts its own VoiceOver preferences for the
 * duration of a run, which set the speech rate to maximum. That is expected and
 * temporary — it does not alter the user's own VoiceOver settings, and it has no
 * effect on the transcript, which is captured as text.
 *
 * The app must be running: web :5173.
 *
 *   node docs/audit/scripts/measure-screenreader.mjs --out /tmp/cat7-voiceover.json
 */

import { voiceOver, voiceOverKeyCodeCommands as K } from '@guidepup/guidepup';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// The expected traversal, built headlessly by map-a11y-traversal.mjs. It supplies
// the per-page step budget (previously a flat guess of 45, which was short of
// every page but one) and the expected role+name sequence to diff against.
const MAP_PATH = process.env.MAP ?? 'docs/audit/raw/cat7-traversal-map.json';
const MAP = existsSync(MAP_PATH) ? JSON.parse(readFileSync(MAP_PATH, 'utf8')) : null;
if (!MAP) {
  console.error(`No traversal map at ${MAP_PATH}. Run map-a11y-traversal.mjs first — ` +
                `without it the step budget is a guess and skipped nodes cannot be detected.`);
  process.exit(1);
}
const mapFor = (label) => MAP.pages.find((p) => p.page === label);

const BASE = process.env.BASE ?? 'http://localhost:5173';
const DOC_ID = process.env.DOC_ID ?? '02109d7f-d3ba-46ea-b7cc-c73119536e36';
const STEPS = Number(process.env.STEPS ?? 45);
// No fixed inter-step pause. The phrase is re-read up to SETTLE_READS times,
// waiting SETTLE_WAIT between attempts, and only while it still looks unchanged.
// An element that announces promptly costs one read; only a genuine stall pays
// the full budget. Worst case per step is SETTLE_READS reads + 2 short waits.
const SETTLE_READS = Number(process.env.SETTLE_READS ?? 3);
const SETTLE_WAIT = Number(process.env.SETTLE_WAIT ?? 70);

// The three surfaces the report names as the minimum a screen-reader pass must
// cover: a list view, the editor, and a settings form.
const PAGES = [
  ['login', `${BASE}/login`],
  ['docs home', `${BASE}/docs`],
  ['document editor', `${BASE}/docs/${DOC_ID}`],
  ['workspace settings', `${BASE}/settings`],
];

const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1] : '/tmp/cat7-voiceover.json';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const osa = (s) => execFileSync('/usr/bin/osascript', ['-e', s], { encoding: 'utf8' }).trim();

/**
 * A control is effectively unnamed when VoiceOver speaks a role with nothing
 * identifying attached — "button", "pop up button", "text field" on their own.
 * That is precisely what a user hears when the accessible name is missing.
 */
const ROLE_ONLY = /^(button|pop ?up button|text field|link|checkbox|radio button|menu button|image|group|tab|edit text)\.?$/i;

async function openInSafari(url) {
  osa(`tell application "Safari"
        activate
        if (count of windows) = 0 then make new document
        set URL of front document to "${url}"
      end tell`);
  await sleep(3500);
  osa('tell application "Safari" to activate');
  await sleep(1200);
}

async function walkPage(label, url) {
  const plan = mapFor(label);
  const STEPS = plan ? plan.suggestedSteps : 45;

  await openInSafari(url);
  await voiceOver.clearSpokenPhraseLog().catch(() => {});

  // Every phrase, in order, repeats included. An earlier revision dropped a phrase
  // when it matched the previous one, which would have silently erased the most
  // interesting thing a walk can find: a cursor that cannot advance. A VO cursor
  // stuck on one element is a direct answer to p.7's "can you understand the page
  // structure" — it must be recorded, not compressed away.
  const raw = [];
  const readMs = [];
  for (let i = 0; i < STEPS; i++) {
    // Do NOT swallow these. An earlier revision caught every error and returned
    // nothing, so a VoiceOver process that had died looked exactly like slow
    // progress — the run spun 11 minutes and produced an empty file.
    try {
      await voiceOver.perform(K.moveToNext);
    } catch (e) {
      throw new Error(`VoiceOver stopped responding on "${label}" at step ${i}: ${e.message}`);
    }
    // Adaptive rather than a fixed pause. A fixed delay has to be set for the
    // slowest element on the page, so every fast element pays for it; and if it is
    // set too low the phrase is read before it updates, which manufactures a
    // repeat and shows up as a cursor stall that is not real. Since stalls are a
    // reported finding, a delay that fabricates them is worse than a slow run.
    //
    // So: read immediately, and only wait when the phrase has not changed — which
    // is exactly the case that needs confirming anyway.
    let text = '';
    const t0 = Date.now();
    for (let attempt = 0; attempt < SETTLE_READS; attempt++) {
      text = String((await voiceOver.lastSpokenPhrase()) ?? '').replace(/\s+/g, ' ').trim();
      if (text && text !== raw[raw.length - 1]) break;   // moved — go straight on
      if (attempt < SETTLE_READS - 1) await sleep(SETTLE_WAIT);
    }
    readMs.push(Date.now() - t0);
    raw.push(text);
  }

  // A stall is the cursor speaking the same thing on consecutive steps: the
  // "next" command was accepted and the cursor did not move.
  const stalls = [];
  let runStart = 0;
  for (let i = 1; i <= raw.length; i++) {
    if (i === raw.length || raw[i] !== raw[runStart]) {
      const len = i - runStart;
      if (len >= 3 && raw[runStart]) {
        stalls.push({ phrase: raw[runStart], consecutiveSteps: len, firstStep: runStart });
      }
      runStart = i;
    }
  }

  const silentSteps = raw.filter((p) => !p).length;
  if (silentSteps >= STEPS * 0.8) {
    throw new Error(
      `VoiceOver spoke nothing on ${silentSteps} of ${STEPS} steps on "${label}". ` +
      `Safari has probably lost focus — do not use the machine while the pass runs.`
    );
  }

  const phrases = raw.filter(Boolean);

  const unnamed = phrases.filter((p) => ROLE_ONLY.test(p));
  const headings = phrases.filter((p) => /heading/i.test(p));
  const landmarks = phrases.filter((p) => /\b(main|navigation|banner|complementary|content ?info)\b/i.test(p));

  // Which mapped controls did VoiceOver never announce? A control present in the
  // accessibility tree that the cursor never reaches is unreachable by screen
  // reader. A blind walk cannot detect this at all — it needs the map to diff.
  const spokenBlob = phrases.join(' | ').toLowerCase();
  const expectedNamed = (plan?.expectedOrder ?? []).filter((n) => n.name);
  const neverAnnounced = expectedNamed.filter((n) => !spokenBlob.includes(n.name.toLowerCase()));

  return {
    page: label, url, steps: STEPS,
    expectedCursorStops: plan?.expectedCursorStops ?? null,
    namedControlsExpected: expectedNamed.length,
    namedControlsNeverAnnounced: neverAnnounced.length,
    neverAnnouncedSamples: neverAnnounced.slice(0, 15).map((n) => `${n.role} "${n.name}"`),
    phrasesSpoken: phrases.length,
    distinctPhrases: new Set(phrases).size,
    silentSteps,
    // Timing, recorded so the pacing question is answered by measurement rather
    // than by picking a number that feels safe.
    msPerStep: { median: median(readMs), max: Math.max(...readMs) },
    cursorStalls: stalls.length,
    stallDetail: stalls,
    stalledSteps: stalls.reduce((n, s) => n + s.consecutiveSteps, 0),
    unnamedAnnouncements: unnamed.length,
    unnamedSamples: [...new Set(unnamed)].slice(0, 10),
    headingsAnnounced: headings.length,
    headingSamples: [...new Set(headings)].slice(0, 8),
    landmarksAnnounced: [...new Set(landmarks)].slice(0, 8),
    transcript: raw,
  };
}

async function main() {
  const out = {
    tool: 'guidepup driving VoiceOver (macOS) against Safari',
    base: BASE, pages: [], notes: [],
  };

  try {
    await voiceOver.start();
  } catch (e) {
    console.error(
      `VoiceOver could not start: ${e.message}`,
      e.cause ? `\ncause: ${e.cause.message}` : '',
      '\n\nNo output file is written when the screen reader does not run —',
      'an unrun test must never leave a result behind that looks like one.'
    );
    process.exit(1);
  }

  try {
    for (const [label, url] of PAGES) {
      const r = await walkPage(label, url);
      out.pages.push(r);
      console.log(`${label.padEnd(20)} ${String(r.distinctPhrases).padStart(4)} distinct · ` +
                  `${r.unnamedAnnouncements} unnamed · ${r.headingsAnnounced} headings · ` +
                  `${r.landmarksAnnounced.length} landmarks · ` +
                  `${r.cursorStalls} stalls (${r.stalledSteps} steps) · ` +
                  `${r.namedControlsNeverAnnounced}/${r.namedControlsExpected} never announced`);
      // Write after every page. A failure on page 4 must not discard pages 1-3 —
      // this run takes 15-30 minutes and is not cheap to repeat.
      writeFileSync(OUT, JSON.stringify(out, null, 2));
    }
  } finally {
    await voiceOver.stop().catch(() => {});
    try { osa('tell application "VoiceOver" to quit'); } catch { /* already stopped */ }
  }

  out.totals = {
    phrasesSpoken: out.pages.reduce((n, p) => n + p.phrasesSpoken, 0),
    unnamed: out.pages.reduce((n, p) => n + p.unnamedAnnouncements, 0),
    cursorStalls: out.pages.reduce((n, p) => n + p.cursorStalls, 0),
    stalledSteps: out.pages.reduce((n, p) => n + p.stalledSteps, 0),
  };

  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${OUT}`);
  console.log('Read the transcript before citing this: p.7 asks whether the structure can be ' +
              'understood and every control operated. The counts below inform that judgement; ' +
              'they do not replace it.');
}

main().catch((e) => { console.error(e); process.exit(1); });
