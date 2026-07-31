/**
 * Regression tests for Category 7 (accessibility) findings W7-3, W7-4, W7-5, W7-8, W7-9
 * and W7-12 -- the ARIA-semantics, page-title and landmark defects that were fixed with no
 * test behind them.
 *
 * Implementation Rule 3 (brief p.8) requires "a corresponding regression test that would
 * have caught it". Every assertion below fails on the pre-fix commit 767aa2f. That is not
 * asserted on faith: point the scan at a pre-fix checkout and watch it go red --
 *
 *   A11Y_SCAN_ROOT=/path/to/767aa2f-checkout/web/src \
 *     pnpm --filter @ship/web exec vitest run src/styles/a11y-aria-invariants.test.ts
 *
 * -- which is the only reason the env override exists. Nothing in the app reads it.
 *
 * Sibling of a11y-invariants.test.ts, which covers the colour tokens (W7-1, W7-2) and the
 * decorative-icon sweep (W7-13). Split because these are markup-semantics invariants with
 * a different scanning shape, not because either file is finished.
 *
 * Source-level rather than runtime, for the reason W7-6 established: e2e/accessibility.spec.ts
 * runs axe over four pages against a fixture too small to render the offending markup, so it
 * is green on every defect below. Two of them (the tree overflow row, the 52 identical
 * delete labels) only exist above a data threshold. A source invariant has no threshold.
 *
 * ---------------------------------------------------------------------------------------
 * There are no allowlists here any more, and that is worth recording.
 *
 * The first version of this file froze the sites each defect still had open -- 6 unnamed
 * selects, 8 unnamed icon buttons, 1 non-treeitem tree child -- because at the time those
 * fixes had only landed on the pages the audit named, and asserting zero would have been
 * red on both trees.
 *
 * Two things then went wrong with that, and both are the reason it is gone:
 *
 *  1. The staleness check was keyed on the first 60 characters of the offending element's
 *     source. That asserts "this markup still exists", not "this markup still offends".
 *     The follow-up fixes appended `aria-label` AFTER the existing attributes, so the
 *     frozen prefix still matched and 7 genuine fixes passed by unnoticed. A ratchet keyed
 *     on a source substring cannot see a fix that appends.
 *  2. The remaining icon-button entry was never an exception in the first place -- it is a
 *     control deliberately removed from the accessibility tree, which the offender scan can
 *     decide for itself. See the aria-hidden branch in the icon-button test.
 *
 * So every assertion below is now `toEqual([])` against the scan's own output. If a future
 * defect genuinely cannot be driven to zero, key its allowlist on the offender scan's
 * result -- the thing the scan flags -- and never on a substring of the source, or a fix
 * will slip past exactly the way these seven did.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WEB_SRC = process.env.A11Y_SCAN_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      // Test files are never rendered, and this one quotes the offending patterns
      // verbatim in its own matchers.
      else if (['.ts', '.tsx'].includes(extname(p)) && !/\.test\.tsx?$/.test(p)) out.push(p);
    }
  })(WEB_SRC);
  return out;
}

const rel = (file: string) => file.replace(WEB_SRC, 'web/src');
const lineOf = (src: string, index: number) => src.slice(0, index).split('\n').length;

/**
 * Source with block comments blanked out, so a scan reads markup and not prose about markup.
 *
 * SkipLink.tsx's own docstring says it pairs with `<main id="main-content" tabIndex={-1}>`,
 * and without this the landmark scan counted that sentence as a fifth page shell. Comments in
 * this codebase quote the patterns they explain -- this file does it constantly -- so any
 * scan that greps for markup has to see past them.
 *
 * Characters are replaced one for one with spaces and newlines are kept, so every index and
 * line number below still refers to the real file.
 *
 * String literals are tracked rather than ignored, and that is not defensive coding -- the
 * catch-all route is `path="/*"`, and a plain regex for block comments treats the `/*` in
 * that string as the start of one, blanking everything up to the next comment terminator
 * and taking the whole shell route table with it.
 *
 * Block comments only. `//` cannot be told from the `//` in a URL this cheaply, and no line
 * comment in web/src currently contains markup that any of these scans look for.
 */
function readSource(file: string): string {
  const src = readFileSync(file, 'utf8');
  const out = src.split('');
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (let j = i; j < stop; j++) if (out[j] !== '\n') out[j] = ' ';
      i = stop;
      continue;
    }
    i++;
  }
  return out.join('');
}

/**
 * Index of the `>` that closes the opening tag starting at `start`.
 *
 * A regex cannot do this: JSX attribute values are expressions, and `onClick={() => f(a > b)}`
 * puts a `>` inside the tag. So track brace depth and quoting, the same walk
 * a11y-invariants.test.ts uses for <svg>.
 */
function endOfOpenTag(src: string, start: number): number {
  let i = start;
  let depth = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return i;
    i++;
  }
  return src.length;
}

/** Index of the `</tag>` matching an opening tag whose `>` sits at `openEnd`, nesting-aware. */
function matchingClose(src: string, tag: string, openEnd: number): number {
  const re = new RegExp(`<${tag}(?=[\\s/>])|</${tag}\\s*>`, 'g');
  re.lastIndex = openEnd;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m[0].startsWith('</')) {
      depth--;
      if (depth === 0) return m.index;
    } else if (src[endOfOpenTag(src, m.index) - 1] !== '/') depth++;
  }
  return src.length;
}

const openTagAt = (src: string, start: number) => src.slice(start, endOfOpenTag(src, start));

/** Enough of an opening tag to find it by eye from a failure message. Never used to key anything. */
const describeTag = (tag: string) => tag.replace(/\s+/g, ' ').slice(0, 60);

// =========================================================================================
// W7-3 -- role="tree" containers whose children are not treeitems
// =========================================================================================

describe('tree widgets own treeitems (W7-3)', () => {
  it('every <li> inside a role="tree" subtree carries role="treeitem"', () => {
    // A tree whose children are not treeitems is malformed ARIA (axe aria-required-children,
    // critical): the user is told "tree, N items" and then handed something that is not an
    // item. Pre-fix, three <li>s in App.tsx's sidebar had no role -- the two "N more..."
    // overflow rows and the empty state.
    //
    // The overflow row is the one that matters for how this is tested. It renders only above
    // SIDEBAR_ITEM_LIMIT = 10 root documents, and the e2e fixture creates fewer, so axe sees
    // a clean /docs and reports nothing. Reading the source instead removes the threshold.
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const src = readSource(file);
      for (const m of src.matchAll(/role="tree"/g)) {
        const openStart = src.lastIndexOf('<', m.index);
        const tagName = /^<([a-z][a-zA-Z0-9]*)/.exec(src.slice(openStart))?.[1];
        if (!tagName) continue;
        const openEnd = endOfOpenTag(src, openStart);
        const block = src.slice(openEnd, matchingClose(src, tagName, openEnd));
        for (const li of block.matchAll(/<li(?=[\s/>])/g)) {
          const tag = openTagAt(block, li.index);
          if (/role="treeitem"/.test(tag)) continue;
          offenders.push(`${rel(file)}:${lineOf(src, openEnd + li.index)}  ${describeTag(tag)}`);
        }
      }
    }
    expect(
      offenders,
      'a child of role="tree" (or of a role="group" inside one) must carry role="treeitem"'
    ).toEqual([]);
  });
});

// =========================================================================================
// W7-5 -- aria-controls pointing at ids that exist nowhere
// =========================================================================================

/** `tabpanel-${tab.id}` and `tabpanel-${x}` are the same shape; only the literal parts can be matched. */
const shapeOf = (value: string) => value.replace(/\$\{[^}]*\}/g, ' ').trim();

type AttrValue = { raw: string; kind: 'literal' | 'template' | 'identifier'; index: number };

/** Values of `name=` in three forms: name="x", name={`x-${y}`}, name={someVar}. */
function attrValues(src: string, name: string): AttrValue[] {
  const re = new RegExp(`${name}=(?:"([^"]*)"|\\{\`([^\`]*)\`\\}|\\{([A-Za-z_$][\\w$]*)\\})`, 'g');
  return [...src.matchAll(re)].map((m) => ({
    raw: m[1] ?? m[2] ?? m[3],
    kind: m[1] !== undefined ? 'literal' : m[2] !== undefined ? 'template' : 'identifier',
    index: m.index,
  }));
}

describe('aria-controls references resolve (W7-5)', () => {
  it('every aria-controls in web/src points at an id that web/src declares', () => {
    // TabBar set aria-controls={`tabpanel-${tab.id}`} on every tab it rendered. role="tabpanel"
    // occurs 0 times in web/src and no element declares an id of that shape, so every tab in
    // the app pointed at nothing (axe aria-valid-attr-value, critical).
    //
    // axe only flags the *selected* tab per page, so the rendered count understates it badly:
    // 2 nodes reported for a defect present on every tab of every tablist. Matching the
    // reference against the id declarations in source finds all of them at once.
    //
    // Two forms have to be resolved differently. A template literal can only be compared on
    // its literal parts, so `tabpanel-${tab.id}` is reduced to the shape "tabpanel-" + hole
    // and matched against ids reduced the same way. A bare identifier -- Combobox's
    // aria-controls={listboxId} -- is matched by name against ids used as id={listboxId},
    // which is the real contract: the same variable feeds both ends.
    const files = sourceFiles();
    const declaredShapes = new Set<string>();
    const declaredIdentifiers = new Set<string>();
    for (const file of files) {
      for (const v of attrValues(readSource(file), 'id')) {
        if (v.kind === 'identifier') declaredIdentifiers.add(v.raw);
        else declaredShapes.add(shapeOf(v.raw));
      }
    }

    const offenders: string[] = [];
    for (const file of files) {
      const src = readSource(file);
      for (const v of attrValues(src, 'aria-controls')) {
        const resolves =
          v.kind === 'identifier' ? declaredIdentifiers.has(v.raw) : declaredShapes.has(shapeOf(v.raw));
        if (!resolves) offenders.push(`${rel(file)}:${lineOf(src, v.index)}  aria-controls -> "${v.raw}"`);
      }
    }
    expect(
      offenders,
      'a dangling aria-controls is worse than none: it sends AT looking for content that is not there. Declare the id, or drop the attribute'
    ).toEqual([]);
  });
});

// =========================================================================================
// W7-4 -- controls with no accessible name
// =========================================================================================

describe('controls have an accessible name (W7-4)', () => {
  it('every <select> has an accessible name', () => {
    // With an empty accessible name a screen reader falls back to announcing the control's
    // *value*, so WorkspaceSettings' 24 member-role selects all said "member" and none said
    // whose permissions were about to change. Verified with real VoiceOver during the audit:
    // "Member, menu pop up collapse".
    //
    // Three things can name a select, and all three are accepted here: aria-label,
    // aria-labelledby, or an id that some <label htmlFor> claims. A <label> merely drawn
    // next to the control names nothing -- which is how the five sites beyond the two the
    // audit named looked correct in the browser and announced as nothing.
    const files = sourceFiles();
    const labelledIds = new Set<string>();
    for (const file of files) {
      for (const v of attrValues(readSource(file), 'htmlFor')) labelledIds.add(shapeOf(v.raw));
    }

    const offenders: string[] = [];
    for (const file of files) {
      const src = readSource(file);
      for (const m of src.matchAll(/<select(?=[\s/>])/g)) {
        const tag = openTagAt(src, m.index);
        if (/aria-label[=\s]|aria-labelledby=/.test(tag)) continue;
        const id = attrValues(tag, 'id')[0];
        if (id && labelledIds.has(shapeOf(id.raw))) continue;
        offenders.push(`${rel(file)}:${lineOf(src, m.index)}  ${describeTag(tag)}`);
      }
    }
    expect(
      offenders,
      'give the <select> an aria-label, or an id that a <label htmlFor> claims'
    ).toEqual([]);
  });

  it('every icon-only <button> is named, or is hidden from assistive technology', () => {
    // A button whose entire content is an icon has no text node to fall back on, so with no
    // aria-label its accessible name is empty and it announces as a bare "button" (axe
    // button-name, critical). AdminDashboard's back button was one.
    //
    // "Icon-only" is decided by removing the icons and seeing whether anything is left:
    // strip <svg> blocks and <SomethingIcon /> elements from the button body, and if the
    // remainder is empty while at least one icon was removed, nothing can name it but an
    // attribute. A button holding text, or an expression that might render text, is left
    // alone -- this test cannot know what an expression evaluates to and does not guess.
    //
    // One control is legitimately exempt, and the scan decides that for itself rather than
    // being told: a button carrying aria-hidden="true" AND tabIndex={-1} is not in the
    // accessibility tree and not in the tab order, so it has no accessible name to get
    // wrong. OrgChartPage's row chevron is the case -- it sits inside a <li role="treeitem"
    // aria-expanded>, which is where AT reads the expanded state from, so naming the button
    // as well would add one identical "Expand" announcement per row. That is W7-12, the
    // defect three tests down. Both halves of the exemption are required: aria-hidden on
    // something still reachable by Tab is a focusable element missing from the
    // accessibility tree (axe aria-hidden-focus, critical), which is worse than an unnamed
    // button, and writing the condition this way means it cannot be used to silence one.
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const src = readSource(file);
      for (const m of src.matchAll(/<button(?=[\s/>])/g)) {
        const openEnd = endOfOpenTag(src, m.index);
        if (src[openEnd - 1] === '/') continue; // self-closing: renders nothing at all
        const tag = src.slice(m.index, openEnd);
        const body = src.slice(openEnd + 1, matchingClose(src, 'button', openEnd)).replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
        const withoutIcons = body
          .replace(/<svg[\s\S]*?<\/svg>/g, '')
          .replace(/<[A-Z][\w.]*Icon\b[^>]*\/>/g, '');
        if (withoutIcons === body) continue; // no icon in it
        if (withoutIcons.trim() !== '') continue; // something else could carry the name
        if (/aria-label[=\s]|aria-labelledby=|title=/.test(tag)) continue;
        if (/aria-hidden="true"/.test(tag) && /tabIndex=\{-1\}/.test(tag)) continue;
        offenders.push(`${rel(file)}:${lineOf(src, m.index)}  ${describeTag(tag)}`);
      }
    }
    expect(
      offenders,
      'an icon-only button has no text to name it: add aria-label saying what it does'
    ).toEqual([]);
  });
});

// =========================================================================================
// W7-12 -- controls in a list that announce identically
// =========================================================================================

describe('controls in a list name their own row (W7-12)', () => {
  it('no aria-label inside an <li> is a bare string literal', () => {
    // 52 delete buttons announced "button, Delete document" and nothing else. None of them is
    // unnamed, so no scanner sees anything wrong -- they are indistinguishable, not silent,
    // and a screen reader user cannot tell which document an irreversible action will destroy.
    //
    // Interpolation is the test, and it is exact rather than a heuristic. A control inside a
    // list row is rendered once per row; if its aria-label is a string constant then it is
    // *identical* on every row by construction, whatever the data. If the label reads from
    // the row -- aria-label={`Delete ${docName}`} -- it cannot collide with a sibling unless
    // two rows have the same title, which is a different problem.
    //
    // This finds the defect where DocumentTreeItem actually lives, which matters: the
    // component renders one <li> and holds one literal label, so nothing at the point of the
    // bug looks like a duplicate. The duplication only exists at the call site, in a .map
    // one file away.
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const src = readSource(file);
      for (const m of src.matchAll(/<li(?=[\s/>])/g)) {
        const openEnd = endOfOpenTag(src, m.index);
        if (src[openEnd - 1] === '/') continue;
        const row = src.slice(openEnd, matchingClose(src, 'li', openEnd));
        for (const label of row.matchAll(/aria-label="([^"]*)"/g)) {
          offenders.push(`${rel(file)}:${lineOf(src, openEnd + label.index)}  aria-label="${label[1]}"`);
        }
      }
    }
    expect(
      offenders,
      'this label is identical on every row of the list: interpolate the row\'s subject into it'
    ).toEqual([]);
  });
});

// =========================================================================================
// W7-8 -- pages that do not say which page they are
// =========================================================================================

/**
 * The app's own name, as it appears in the `"<title> | Ship"` format.
 *
 * Hard-coded rather than imported from hooks/usePageTitle.ts on purpose: that module is
 * part of the fix and does not exist on the pre-fix tree, so importing it would make this
 * test crash there instead of fail there. A crash and a failure look different in a run
 * log, and the point of the pre-fix run is to read the failures.
 */
const APP_NAME = 'Ship';

const readFile = (relative: string) => readSource(join(WEB_SRC, relative));

/** The body of getPageTitle, which is where the route-to-title table lives. */
function pageTitleFn(): string {
  const src = readFile('hooks/useFocusOnNavigate.ts');
  const start = src.indexOf('function getPageTitle');
  return start === -1 ? '' : src.slice(start);
}

describe('every page says which page it is (W7-8)', () => {
  it('no getPageTitle branch returns the bare app name', () => {
    // `${pageTitle} | Ship` with pageTitle === 'Ship' is where "Ship | Ship" came from, and
    // eight of seventeen pages hit that branch. axe cannot see it: document-title only
    // asserts a title exists and is non-empty, and "Ship | Ship" is both. WCAG 2.4.2 is
    // Level A, and a tab strip of identical titles is worst exactly where this app puts a
    // user -- many document editors open at once.
    const returned = [...pageTitleFn().matchAll(/return\s+'([^']*)'/g)].map((m) => m[1]);
    expect(returned.length, 'getPageTitle not found -- has the route table moved?').toBeGreaterThan(0);
    expect(
      returned.filter((t) => t === APP_NAME),
      `a title of "${APP_NAME}" renders as "${APP_NAME} | ${APP_NAME}": name the page, or the fallback`
    ).toEqual([]);
  });

  it('every route rendered inside the app shell is answered by getPageTitle', () => {
    // The other half of W7-8, and the half that made it eight pages rather than one:
    // /my-week, /dashboard, /projects and `/documents/:id` were simply absent from the
    // table, so they fell through to the bare-app-name branch. Listing the route table as
    // the source of truth means adding a route without a title fails here rather than
    // shipping an unnamed tab.
    const body = pageTitleFn();
    const exact = new Set([...body.matchAll(/pathname === '([^']*)'/g)].map((m) => m[1]));
    const prefixes = [...body.matchAll(/pathname\.startsWith\('([^']*)'\)/g)].map((m) => m[1]);

    // Child routes of the `path="/"` shell -- the routes AppLayout renders, and therefore
    // the routes useFocusOnNavigate is responsible for.
    const main = readFile('main.tsx');
    const shellStart = /<Route\s+path="\/"\s/.exec(main)?.index ?? -1;
    expect(shellStart, 'the path="/" shell route was not found in main.tsx').toBeGreaterThan(-1);
    const shellOpenEnd = endOfOpenTag(main, shellStart);
    const shell = main.slice(shellOpenEnd, matchingClose(main, 'Route', shellOpenEnd));

    const routes = [...shell.matchAll(/<Route\s+(?:index|path="([^"]*)")[^>]*element=\{<(\w+)/g)];
    expect(routes.length, 'no child routes parsed out of the shell').toBeGreaterThan(10);

    const offenders: string[] = [];
    for (const m of routes) {
      // A <Navigate> route renders no page and never owns a title; it redirects to one that does.
      if (m[2] === 'Navigate') continue;
      const declared = m[1] ?? '';
      // ':id' stands for any segment and '*' for any tail: substitute something concrete so
      // the route can be run through the same matching getPageTitle does at runtime.
      const pathname =
        '/' +
        declared
          .split('/')
          .filter((seg) => seg !== '*')
          .map((seg) => (seg.startsWith(':') ? 'concrete-segment' : seg))
          .join('/');
      const answered = exact.has(pathname) || prefixes.some((p) => pathname.startsWith(p));
      if (!answered) offenders.push(`${declared || '(index)'} -> ${pathname}`);
    }
    expect(
      offenders,
      `these routes fall through to getPageTitle's final branch and announce the same title as each other`
    ).toEqual([]);
  });

  it('every page rendered outside the app shell sets its own title', () => {
    // /login and /admin did not go through the shell hook and never touched document.title
    // at all, so they kept index.html's "Ship - Project Management & Documentation" -- the
    // other two of the ten pages W7-8 counted. There is no shared layout to fix it for
    // them, so each has to call usePageTitle itself, and this is what checks they still do.
    const main = readFile('main.tsx');
    const pageFiles = sourceFiles().filter((f) => f.includes('/pages/'));

    const offenders: string[] = [];
    for (const m of main.matchAll(/<Route\s+path="(\/[^"]*)"/g)) {
      if (m[1] === '/' || m[1] === '/*') continue; // the shell, and the catch-all
      const component = /<(\w+Page)\b/.exec(main.slice(m.index, m.index + 600))?.[1];
      if (!component) continue;
      // Resolve by export rather than by import statement: the routes were static imports
      // before commit 56ed542 split them into React.lazy calls, and an invariant that only
      // understood one of those two shapes would quietly pass on the tree it could not read.
      const file = pageFiles.find((f) => new RegExp(`export function ${component}\\b`).test(readSource(f)));
      if (!file) {
        offenders.push(`${m[1]} -> ${component} (no file exports it)`);
        continue;
      }
      if (!readSource(file).includes('usePageTitle(')) {
        offenders.push(`${m[1]} -> ${rel(file)}`);
      }
    }
    expect(
      offenders,
      'this page renders outside AppLayout, so no shared hook titles it: call usePageTitle'
    ).toEqual([]);
  });
});

// =========================================================================================
// W7-9 -- landmarks and skip links
// =========================================================================================

/** Files that render a <main> landmark: one per page shell, and there is no other kind. */
function shellFiles(): { file: string; src: string; mains: number[] }[] {
  return sourceFiles()
    .map((file) => {
      const src = readSource(file);
      const mains = [...src.matchAll(/<main(?=[\s/>])/g)].map((m) => m.index);
      return { file, src, mains };
    })
    .filter((s) => s.mains.length > 0);
}

describe('one main landmark per page, reachable by a skip link (W7-9)', () => {
  it('every <main> is the shell target: id="main-content" and focusable', () => {
    // /settings rendered TWO <main> landmarks (axe landmark-no-duplicate-main,
    // landmark-unique, landmark-main-is-top-level): WorkspaceSettings had its own, and it
    // renders inside AppLayout, which has one too.
    //
    // Requiring the id is what makes "exactly one" checkable from source without resolving
    // the render tree. An id must be unique in a document, so two rendered <main>s both
    // claiming main-content is an invalid document and a broken skip-link target -- which is
    // precisely why WorkspaceSettings' <main> had to become a plain <div> rather than get an
    // id of its own. tabIndex={-1} comes with it because SkipLink moves focus to this element,
    // and a <main> is not focusable by default.
    const offenders: string[] = [];
    for (const { file, src, mains } of shellFiles()) {
      for (const index of mains) {
        const tag = openTagAt(src, index);
        if (/id="main-content"/.test(tag) && /tabIndex=\{-1\}/.test(tag)) continue;
        offenders.push(`${rel(file)}:${lineOf(src, index)}  ${describeTag(tag)}`);
      }
    }
    expect(
      offenders,
      'a <main> is a page shell\'s single landmark: give it id="main-content" tabIndex={-1}, or make it a <div>'
    ).toEqual([]);
  });

  it('every page shell that renders <main> also renders a skip link', () => {
    // login had no <main> and no skip link; /admin had no skip link. A keyboard user landing
    // on either had to tab through the whole chrome to reach content, and 2.4.1 Bypass
    // Blocks is Level A.
    //
    // <main> is the marker for "this file is a page shell", so the two obligations travel
    // together: if a file is enough of a page to own the landmark, it is enough of a page to
    // owe the bypass.
    const offenders: string[] = [];
    for (const { file, src } of shellFiles()) {
      if (!/<SkipLink\b/.test(src)) offenders.push(rel(file));
    }
    expect(
      offenders,
      'this file owns a <main>, so it is a page shell: render <SkipLink /> above it'
    ).toEqual([]);
  });
});
