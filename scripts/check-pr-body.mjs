#!/usr/bin/env node
/**
 * PF-026 — a PR description that omits a required section fails the check.
 *
 *     pnpm check:pr-body <file>          # a file containing the PR body
 *     gh pr view 42 --json body -q .body | pnpm check:pr-body -
 *
 * PRD p.12 grades the PR description: "each PR description lists which
 * acceptance criterion that slice advances and confirms the fitness test
 * passed." A template alone does not survive contact with a deadline — the third
 * PR of the week deletes the headings, and by the tenth nobody remembers there
 * were any. So the template (.github/pull_request_template.md) is the prompt and
 * this is the gate.
 *
 * What counts as present:
 *
 *   - the heading exists (## Advances acceptance criterion, ## Fitness test), and
 *   - the body under it is non-empty once HTML comments are stripped, and
 *   - it is not still the template's `REPLACE ME` placeholder, and
 *   - it says something. A section reading "n/a" or "none" fails, EXCEPT that
 *     "Advances acceptance criterion" may be a bare em/en dash — which is the
 *     spine's own notation for "this slice is plumbing and claims no graded
 *     credit" (TICKETS-PLUGFORGE.md -> Conventions). That is an honest answer,
 *     and refusing it would push people toward inventing a citation instead,
 *     which is the failure this check exists to prevent.
 *
 * Exit 0 = both sections present and filled. Exit 1 = at least one is not.
 */
import { readFileSync } from 'node:fs';

const REQUIRED = [
  {
    heading: 'Advances acceptance criterion',
    allowDashOnly: true,
    why: 'PRD p.12 requires the PR to name which acceptance criterion the slice advances. Cite ticket IDs plus the criterion text (MVP-N / TS-N / CTR: / PERF: / INT: / SUB:). If the slice is plumbing and advances nothing graded, write a single em dash and say why.',
  },
  {
    heading: 'Fitness test',
    allowDashOnly: false,
    why: 'PRD p.12 requires the PR to confirm the fitness test passed. Name the specific check and its result — "CI is green" is not a fitness test.',
  },
];

// A bare dash reaches here only for a section that does NOT set allowDashOnly —
// i.e. "Fitness test", where "—" means "I did not run one" and must fail.
const PLACEHOLDERS = [/^replace me$/i, /^tbd$/i, /^todo$/i, /^n\/?a$/i, /^none$/i, /^[—–-]$/];

function readBody(source) {
  if (!source) {
    console.error('usage: check-pr-body.mjs <file|->\n       gh pr view N --json body -q .body | check-pr-body.mjs -');
    process.exit(2);
  }
  return readFileSync(source === '-' ? 0 : source, 'utf8');
}

/** Text under `## <heading>`, up to the next heading of any level, comments stripped. */
function sectionBody(markdown, heading) {
  const lines = markdown.split('\n');
  const start = lines.findIndex(
    (l) => /^#{1,6}\s/.test(l) && l.replace(/^#{1,6}\s+/, '').trim().toLowerCase() === heading.toLowerCase(),
  );
  if (start === -1) return null;

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,6}\s/.test(l));
  const section = (end === -1 ? rest : rest.slice(0, end)).join('\n');

  return section
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!--[\s\S]*$/, '') // an unterminated comment swallows the rest
    .trim();
}

const body = readBody(process.argv[2]);
const failures = [];

for (const { heading, allowDashOnly, why } of REQUIRED) {
  const content = sectionBody(body, heading);

  if (content === null) {
    failures.push(`Missing section: "## ${heading}"\n     ${why}`);
    continue;
  }

  const isDashOnly = /^[—–-]$/.test(content);
  if (allowDashOnly && isDashOnly) continue;

  if (content === '') {
    failures.push(`Section "## ${heading}" is empty.\n     ${why}`);
    continue;
  }
  if (PLACEHOLDERS.some((p) => p.test(content))) {
    failures.push(
      `Section "## ${heading}" still holds the template placeholder ("${content.slice(0, 40)}").\n     ${why}`,
    );
  }
}

if (failures.length > 0) {
  console.error('\nPR description check FAILED (PF-026)\n');
  for (const f of failures) console.error(`  x  ${f}\n`);
  console.error(
    '  The PR description is a graded artifact (PRD p.12, Submission Requirements).\n' +
      '  Fill in .github/pull_request_template.md and push again, or edit the PR body\n' +
      '  in the GitHub UI and re-run the check.\n',
  );
  process.exit(1);
}

console.log('PR description check passed (PF-026): both required sections present and filled.');
