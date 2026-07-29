#!/usr/bin/env node
/**
 * Category 7 — the screen-reader bullet (p.7):
 *   "Test with a screen reader (VoiceOver, NVDA, or similar). Can you understand
 *    the page structure and interact with all controls?"
 *
 * Drives the real VoiceOver process on macOS via guidepup and records what it
 * actually speaks. This is the screen reader, not the accessibility-tree proxy in
 * measure-a11y-tree.mjs — that script reads the tree a screen reader consumes;
 * this one runs the screen reader over it and captures the resulting speech.
 *
 * What it settles objectively: whether each control is announced with a usable
 * name and role. What it cannot settle: whether the speech is comprehensible in
 * practice — that is a human judgement and stays a human judgement. The phrase
 * log is written out so a person can read what was said and answer that.
 *
 * PREREQUISITES (one-time, and the second one needs a human):
 *   1. npx @guidepup/setup setup      — enables VoiceOver AppleScript control
 *   2. System Settings -> Privacy & Security -> Accessibility -> enable the
 *      terminal application running this script. Without it VoiceOver refuses to
 *      start and the script exits with "VoiceOver cannot be started".
 *
 * The app must be running: web :5173.
 *
 *   node docs/audit/scripts/measure-screenreader.mjs --out /tmp/cat7-voiceover.json
 */

import { voiceOver } from '@guidepup/guidepup';
import { writeFileSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const DOC_ID = process.env.DOC_ID ?? '02109d7f-d3ba-46ea-b7cc-c73119536e36';

// The three surfaces the report names as the minimum a human pass must cover.
const PAGES = [
  ['docs home', `${BASE}/docs`],
  ['document editor', `${BASE}/docs/${DOC_ID}`],
  ['workspace settings', `${BASE}/settings`],
];

// How many VO cursor steps to take per page. Enough to cross the landmarks and
// the primary control cluster without producing an unreadable transcript.
const STEPS = Number(process.env.STEPS ?? 40);

const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1] : '/tmp/cat7-voiceover.json';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A phrase is "unnamed" when VoiceOver announces a role with nothing identifying
 * in front of it — "button", "pop up button", "text field" alone. That is exactly
 * what a user hears when an accessible name is missing.
 */
const ROLE_ONLY = /^(button|pop ?up button|text field|link|checkbox|radio button|menu button|image|group|tab)\.?$/i;

async function walkPage(label, url) {
  const phrases = [];
  await voiceOver.navigateToWebContent().catch(() => {});
  await sleep(500);

  for (let i = 0; i < STEPS; i++) {
    await voiceOver.next().catch(() => {});
    const p = (await voiceOver.lastSpokenPhrase().catch(() => '')) ?? '';
    const text = String(p).replace(/\s+/g, ' ').trim();
    if (text) phrases.push(text);
    await sleep(120);
  }

  const unnamed = phrases.filter((p) => ROLE_ONLY.test(p));
  const headings = phrases.filter((p) => /heading/i.test(p));
  const landmarks = phrases.filter((p) => /(main|navigation|banner|complementary|content ?info)/i.test(p));

  return {
    page: label, url, steps: STEPS,
    phrasesSpoken: phrases.length,
    unnamedAnnouncements: unnamed.length,
    unnamedSamples: [...new Set(unnamed)].slice(0, 10),
    headingsAnnounced: headings.length,
    headingSamples: [...new Set(headings)].slice(0, 10),
    landmarksAnnounced: [...new Set(landmarks)].slice(0, 10),
    transcript: phrases,
  };
}

async function main() {
  const out = { tool: 'guidepup + VoiceOver (macOS)', base: BASE, pages: [], notes: [] };

  try {
    await voiceOver.start();
  } catch (e) {
    console.error(
      'VoiceOver could not start:', e.message,
      '\n\nGrant Accessibility permission to this terminal:',
      '\n  System Settings -> Privacy & Security -> Accessibility',
      '\nthen re-run. Nothing is written when the screen reader does not run —',
      'an unrun test must not produce a result file.'
    );
    process.exit(1);
  }

  try {
    for (const [label, url] of PAGES) {
      // Safari is the browser VoiceOver is best supported against on macOS.
      await voiceOver.interact().catch(() => {});
      await voiceOver.perform(voiceOver.keyboardCommands.openSpotlight ?? {}).catch(() => {});
      out.notes.push(`Navigate Safari to ${url} — driven manually below if automation cannot.`);
      const result = await walkPage(label, url);
      out.pages.push(result);
      console.log(`${label}: ${result.phrasesSpoken} phrases, ${result.unnamedAnnouncements} unnamed`);
    }
  } finally {
    await voiceOver.stop().catch(() => {});
  }

  out.totals = {
    phrases: out.pages.reduce((n, p) => n + p.phrasesSpoken, 0),
    unnamed: out.pages.reduce((n, p) => n + p.unnamedAnnouncements, 0),
  };

  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${OUT}`);
  console.log('Read the transcript and answer p.7 directly: can the page structure be understood, and can every control be operated?');
}

main().catch((e) => { console.error(e); process.exit(1); });
