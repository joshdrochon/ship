# VoiceOver pass — manual protocol

p.7 requires: *"Test with a screen reader (VoiceOver, NVDA, or similar). Can you understand
the page structure and interact with all controls?"*

Automation of this is blocked on macOS 14.6.1 — see "Why this is manual" at the end. The
questions p.7 asks are a human judgement anyway; this protocol makes that judgement fast and
targeted rather than open-ended.

**Time: ~15 minutes.** Turn VoiceOver on with **⌘F5**. Turn it off the same way.

Essential keys:

| Key | Does |
|---|---|
| **VO** | Control-Option (hold both) |
| **VO + →** | Next item |
| **VO + Space** | Activate the item |
| **VO + U** | Rotor — then ← → to switch between Headings / Landmarks / Form Controls |
| **VO + Shift + ↓** | Enter a group (a table, the editor) |
| **Control** | Shut it up mid-sentence |

Each step below has a **specific prediction** drawn from the measured accessibility tree. Note
whether what you hear matches. A mismatch is as useful as a confirmation.

---

## 1 · Login page — `http://localhost:5173/login` *(sign out first)*

Measured: 4 interactive nodes, 1 heading, **no `main` landmark, no `navigation` landmark**.

1. **VO + U**, arrow to **Landmarks**. → *Prediction: the list is empty or has no "main".*
   - What did it say? ______________________
2. Escape the rotor. **VO + →** through the page to the Sign in button.
3. Operate the form with the keyboard only — type the email, tab, type the password, VO+Space
   the button.
   - Was every field announced with a name you could act on? Y / N ______

**The p.7 question for this page:** could a screen reader user log in unaided?

---

## 2 · Docs home — `/docs` *(the one that matters most)*

Simulated announcement measured **52 buttons all saying `button, Delete document`** and 52
saying `button, Add sub-document`, with the document never named (W7-12). No scanner catches
this, because the buttons are not unnamed — they are identically named.

1. **VO + →** repeatedly through the document list, or **VO + U** → **Form Controls**.
2. Land on a delete button.
   - *Prediction: it says "Delete document" and never says **which** document.*
   - Exact words heard: ______________________
3. **The question that matters:** from the control alone, could you tell which document you
   are about to delete? Y / N ______

## 3 · Workspace settings — `/settings`

Measured: 117 interactive nodes, **24 comboboxes with an empty accessible name**, 1 heading.
These are the member-role dropdowns. This is finding W7-4 and the highest-consequence one in
the category — these controls grant workspace admin.

1. **VO + U** → **Form Controls**. Arrow down the list.
2. Land on a role dropdown.
   - *Prediction: it announces the current role ("member" or "admin") and the control type,
     with no indication of **which person** it belongs to. The simulator produced
     `combobox, member` for all 24 — VoiceOver will phrase it differently but should carry
     the same information, i.e. the role but not the person.*
   - Exact words heard: ______________________
3. **The question that matters:** with only what VoiceOver said, could you tell whose
   permissions you are about to change? Y / N ______

---

## 4 · Issues list — `/issues`

Measured: **405 interactive nodes behind 2 headings**, 2,257 accessibility nodes.

1. **VO + U** → **Headings**. → *Prediction: only 2 entries for the whole page.*
   - How many? ______
2. **The question:** with 2 headings, can you skip to a section of this page, or is the only
   way through it item by item? ______________________

---

## 5 · Document editor — `/docs/{any document}`

Measured: 94 cursor stops, 3 headings, 4 landmarks. The sidebar tree is `role="tree"` with
`treeitem` children (W7-3: tree role without tree keyboard behaviour).

1. **VO + →** to the document sidebar.
2. Try **↑ ↓** to move between documents in the tree, and **→** to expand one.
   - *Prediction: arrow keys do nothing — the role claims a tree, the behaviour is not there.*
   - What happened? ______________________
3. Move into the editor body and type a few characters.
   - Was the editor announced as an editable region? Y / N ______

---

## What to hand back

Just the answers above, in any form. Five things decide the write-up:

1. Could you log in using only VoiceOver?
2. On `/docs`, could you tell which document a Delete button would destroy?
3. Could you tell which member each `/settings` role dropdown controlled?
4. Could you navigate `/issues` by heading?
5. Did the sidebar tree respond to arrow keys?

Anything that surprised you is worth more than the five answers — write it down even if it is
not on this list.

---

## Status — partially run, two items deferred

A real VoiceOver pass was run by a human on 2026-07-29 and produced two findings now in the
report: **W7-13** (icon buttons announcing as an unnamed "image") and confirmation of
**W7-4/W7-12** on `/settings`, where a role dropdown announced *"Member, menu pop up collapse"*
— the role, never the person.

Two checks were not completed and are deliberately left open rather than guessed:

| # | Check | Why it is still open |
|---|---|---|
| 3 | `/issues` heading count from the rotor | The reported answer ("6 to cycle through") may have counted rotor *lists* rather than headings inside the Headings list. The report's figure of **2 headings** stands on its own measurement (`ariaSnapshot`), and this cross-check is unresolved — not contradicted. |
| 5 | Sidebar tree arrow-key behaviour | Not attempted. W7-3 currently rests on the static observation that `role="tree"` is present without tree keyboard handlers; a live confirmation would strengthen it but is not required for the finding to stand. |

Neither gap affects a row of p.7's Audit Deliverable table — all five are filled. Both are
cross-checks on findings that already have independent evidence.

---

## Why this is manual — corrected

An earlier version of this section claimed VoiceOver's scripting content API was unavailable on
macOS 14.6.1. **That was wrong, and the cause was misdiagnosed.**

What actually happened: `content of last phrase`, `vo cursor` and `properties` all returned
`-1728` while guidepup had its own VoiceOver preference bundle mounted. Setting
`SCREnableAppleScript` with `defaults write` was not enough. The setting that matters is the
checkbox — **VoiceOver Utility > General > "Allow VoiceOver to be controlled with
AppleScript"** — which was unticked in the live session. Once ticked, both operations work:

```
tell application "VoiceOver" to return content of last phrase   -> speaks back correctly
tell application "VoiceOver" to tell vo cursor to move right    -> cursor advances
```

`name of vo cursor` still returns `-1728`, but nothing needed depends on it.

`docs/audit/scripts/measure-voiceover.mjs` drives real VoiceOver on that basis and was used to
capture the login-page transcript in `raw/cat7-voiceover.json`.

**What is still manual, and why.** Reading VoiceOver is solved; driving a *useful traversal* is
not. Two problems remain unsolved in the script:

1. The VO cursor leaves the browser. On the first run it walked into the macOS Dock and
   recorded `Trash (19 of 19)` 58 times. `move to first item` plus escape-detection improved
   this but did not fix it.
2. Safari cannot be signed in reliably from a script. Keystroke injection into the login form
   did not take, and Safari's `do JavaScript` needs a Develop-menu opt-in that cannot be set
   from the command line — its preference container is sandboxed. Every "authenticated" page
   silently walked `/login` again, which is how it was caught: five pages reported identical
   numbers.

So the automated driver is good for one unauthenticated page. The authenticated pages need a
human, which is what the protocol above is for.

The accessibility-tree inspection in `measure-a11y-tree.mjs`, the traversal map in
`map-a11y-traversal.mjs`, and the simulator in `measure-virtual-screenreader.mjs` are all
automated and are where the predictions above come from. None is a substitute for this pass and
none is reported as one.
