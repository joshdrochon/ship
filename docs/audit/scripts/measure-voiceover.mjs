#!/usr/bin/env node
/**
 * Category 7 — p.7's screen-reader bullet, with the actual screen reader:
 *   "Test with a screen reader (VoiceOver, NVDA, or similar). Can you understand
 *    the page structure and interact with all controls?"
 *
 * This drives **real VoiceOver** on macOS against Safari and records what it
 * speaks. It is not the simulator in measure-virtual-screenreader.mjs and not the
 * tree dump in measure-a11y-tree.mjs.
 *
 * WHY NOT guidepup
 * ────────────────
 * guidepup mounts its own VoiceOver preference bundle for the duration of a run.
 * With that bundle mounted, every content object in VoiceOver's scripting
 * dictionary returned -1728 on this machine — `content of last phrase`,
 * `vo cursor`, `properties` — so a driven walk produced only empty strings. The
 * same commands work against the user's own preferences once "Allow VoiceOver to
 * be controlled with AppleScript" is ticked in VoiceOver Utility > General.
 *
 * So this talks to VoiceOver directly. It needs exactly two operations, both
 * verified working: `tell vo cursor to move right`, and `content of last phrase`.
 *
 * PREREQUISITES
 *   1. VoiceOver running (Cmd+F5).
 *   2. VoiceOver Utility > General > "Allow VoiceOver to be controlled with
 *      AppleScript" TICKED. Setting SCREnableAppleScript with `defaults write` is
 *      not sufficient — the checkbox is what the running session honours.
 *   3. Accessibility permission for AEServer and the terminal.
 *   4. The app running on :5173, and Safari signed in (or not, for /login).
 *
 * The whole walk for one page runs inside a single osascript process. Spawning one
 * process per step costs ~28ms each before VoiceOver does any work; batching turns
 * a page into one spawn.
 *
 *   node docs/audit/scripts/measure-voiceover.mjs --out docs/audit/raw/cat7-voiceover.json
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const DOC_ID = process.env.DOC_ID ?? '02109d7f-d3ba-46ea-b7cc-c73119536e36';
const STEPS = Number(process.env.STEPS ?? 60);
const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1] : '/tmp/cat7-voiceover.json';

const PAGES = [
  ['login', `/login`],
  ['docs home', `/docs`],
  ['document editor', `/docs/${DOC_ID}`],
  ['workspace settings', `/settings`],
  ['issues', `/issues`],
];

const SEP = '<<|>>';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function osa(script, timeout = 180000) {
  return execFileSync('/usr/bin/osascript', ['-e', script], { encoding: 'utf8', timeout }).trim();
}

function voRunning() {
  try { return osa('tell application "System Events" to return (name of processes) contains "VoiceOver"', 15000) === 'true'; }
  catch { return false; }
}

/** Confirm the scripting content API is actually available before walking. */
function contentApiWorks() {
  try { osa('tell application "VoiceOver" to return content of last phrase', 15000); return true; }
  catch { return false; }
}

async function openPage(url) {
  osa(`tell application "Safari"
        activate
        if (count of windows) = 0 then make new document
        set URL of front document to "${url}"
      end tell`, 30000);
  await sleep(4000);
  osa('tell application "Safari" to activate', 15000);
  await sleep(1500);
}

/**
 * Sign Safari in by typing into the form. Safari blocks JavaScript from Apple
 * Events unless the Develop menu opts in, so keystrokes are the portable route.
 */
async function signIn() {
  await openPage(`${BASE}/login`);
  osa(`tell application "System Events" to tell process "Safari"
        keystroke tab
        delay 0.3
        keystroke "dev@ship.local"
        delay 0.3
        keystroke tab
        delay 0.3
        keystroke "admin123"
        delay 0.3
        keystroke return
      end tell`, 60000);
  await sleep(5000);
}

/**
 * Walk the page and return every phrase in order. Repeats are kept — a cursor that
 * cannot advance is a finding, and collapsing repeats would erase it.
 */
function walk(steps) {
  // Reset to the top of the window's content first. Without this the cursor keeps
  // whatever position it held from the previous page — and once it runs off the
  // end of the web content it walks into the macOS Dock and stays there. A first
  // run recorded "Trash (19 of 19)" 58 times for exactly that reason.
  const script = `tell application "VoiceOver"
    tell vo cursor
      move to first item
    end tell
    delay 0.4
    set out to ""
    set lastP to ""
    set sameCount to 0
    repeat ${steps} times
      try
        tell vo cursor to move right
      end try
      delay 0.12
      set p to ""
      try
        set p to (content of last phrase)
      end try
      set out to out & p & "${SEP}"
      -- VoiceOver does not wrap when "Allow cursor wrapping" is off, so at the end
      -- of the document every further move repeats the last item. Stop there
      -- instead of burning the remaining steps on one phrase.
      if p is lastP then
        set sameCount to sameCount + 1
        if sameCount is 4 then exit repeat
      else
        set sameCount to 0
      end if
      set lastP to p
    end repeat
    return out
  end tell`;
  return osa(script).split(SEP).slice(0, -1).map((s) => s.replace(/\s+/g, ' ').trim());
}

// The VO cursor can leave the browser entirely and end up in the Dock or the menu
// bar. Those phrases are not measurements of the application and must be visible
// as contamination rather than counted as page content.
const ESCAPED = /\((\d+) of (\d+)\)$|^(Trash|Finder|Downloads|Activity Monitor|Adobe|Cursor|Safari) /i;

function analyse(phrases) {
  const nonEmpty = phrases.filter(Boolean);
  const escaped = nonEmpty.filter((p) => ESCAPED.test(p));

  // A stall is the same phrase on consecutive steps: move accepted, cursor did not
  // advance.
  const stalls = [];
  let start = 0;
  for (let i = 1; i <= phrases.length; i++) {
    if (i === phrases.length || phrases[i] !== phrases[start]) {
      if (i - start >= 3 && phrases[start]) {
        stalls.push({ phrase: phrases[start], consecutiveSteps: i - start, firstStep: start });
      }
      start = i;
    }
  }

  const counts = {};
  for (const p of nonEmpty) counts[p] = (counts[p] ?? 0) + 1;

  return {
    steps: phrases.length,
    spoken: nonEmpty.length,
    silent: phrases.length - nonEmpty.length,
    distinct: new Set(nonEmpty).size,
    escapedBrowser: escaped.length,
    escapedSamples: [...new Set(escaped)].slice(0, 5),
    cursorStalls: stalls.length,
    stallDetail: stalls.slice(0, 10),
    repeatedPhrases: Object.entries(counts).filter(([, n]) => n > 1)
      .sort((a, b) => b[1] - a[1]).slice(0, 10).map(([phrase, count]) => ({ phrase, count })),
    mentionsDeleteDocument: nonEmpty.filter((p) => /delete document/i.test(p)).length,
    transcript: phrases,
  };
}

async function main() {
  if (!voRunning()) {
    console.error('VoiceOver is not running. Turn it on with Cmd+F5 and re-run.');
    process.exit(1);
  }
  if (!contentApiWorks()) {
    console.error(
      'VoiceOver is running but its scripting content API is unavailable.\n' +
      'Tick VoiceOver Utility > General > "Allow VoiceOver to be controlled with AppleScript".\n' +
      'Nothing is written when the screen reader cannot be read — an unrun test must not ' +
      'leave a result file behind.'
    );
    process.exit(1);
  }

  const out = {
    tool: 'real VoiceOver on macOS, driven by AppleScript, against Safari',
    macos: osa('return system version of (system info)', 15000),
    base: BASE, stepsPerPage: STEPS, pages: [],
  };

  let authed = false;
  for (const [label, path] of PAGES) {
    // /login is walked first and unauthenticated; everything after it needs a
    // session or Safari silently redirects back to /login and the walk measures
    // that page four more times.
    if (path !== '/login' && !authed) { await signIn(); authed = true; }
    await openPage(`${BASE}${path}`);
    const phrases = walk(STEPS);
    const a = analyse(phrases);
    out.pages.push({ page: label, path, ...a });
    console.log(
      `${label.padEnd(20)} ${String(a.spoken).padStart(3)}/${a.steps} spoken · ` +
      `${String(a.distinct).padStart(3)} distinct · ${a.cursorStalls} stalls · ` +
      `${a.escapedBrowser} escaped · ${a.mentionsDeleteDocument} say "Delete document"`
    );
    writeFileSync(OUT, JSON.stringify(out, null, 2));
  }

  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${OUT}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
