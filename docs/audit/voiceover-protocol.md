# VoiceOver pass — manual protocol

p.7 requires: *"Test with a screen reader (VoiceOver, NVDA, or similar). Can you understand
the page structure and interact with all controls?"*

Automation of this is blocked on macOS 14.6.1 — see "Why this is manual" at the end. The
questions p.7 asks are a human judgement anyway; this protocol makes that judgement fast and
targeted rather than open-ended.

**Time: ~12 minutes.** Turn VoiceOver on with **⌘F5**. Turn it off the same way.

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

## 2 · Workspace settings — `/settings`

Measured: 117 interactive nodes, **24 comboboxes with an empty accessible name**, 1 heading.
These are the member-role dropdowns. This is finding W7-4 and the highest-consequence one in
the category — these controls grant workspace admin.

1. **VO + U** → **Form Controls**. Arrow down the list.
2. Land on a role dropdown.
   - *Prediction: it announces as "pop up button" with no indication of **which member** it
     belongs to.*
   - Exact words heard: ______________________
3. **The question that matters:** with only what VoiceOver said, could you tell whose
   permissions you are about to change? Y / N ______

---

## 3 · Issues list — `/issues`

Measured: **405 interactive nodes behind 2 headings**, 2,257 accessibility nodes.

1. **VO + U** → **Headings**. → *Prediction: only 2 entries for the whole page.*
   - How many? ______
2. **The question:** with 2 headings, can you skip to a section of this page, or is the only
   way through it item by item? ______________________

---

## 4 · Document editor — `/docs/{any document}`

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

Just the answers above, in any form. Four things decide the write-up:

1. Could you log in using only VoiceOver?
2. Could you tell which member each `/settings` role dropdown controlled?
3. Could you navigate `/issues` by heading?
4. Did the sidebar tree respond to arrow keys?

Anything that surprised you is worth more than the four answers — write it down even if it is
not on this list.

---

## Why this is manual

Automation was attempted and got most of the way. `guidepup` 0.29.2 (latest) can start and
stop VoiceOver, and AppleScript reaches it — `version` returns `10`. But every content object
in VoiceOver's scripting dictionary fails on this machine:

```
tell application "VoiceOver" to return content of last phrase
  -> Can't get content of last phrase. (-1728)
tell application "VoiceOver" to return vo cursor
  -> Can't get vo cursor. (-1728)
tell application "VoiceOver" to return properties
  -> Can't get properties. (-1728)
```

`-1728` is "object not found". Without `last phrase` there is no way to read back what was
spoken, and without `vo cursor` there is no way to know where the cursor is — so a driven walk
produces 25 empty strings, which is exactly what it produced.

This is not a missing permission. All of these are in place and were verified:

- `SCREnableAppleScript = 1` in both the user domain and guidepup's mounted preference bundle
- AEServer and the terminal granted Accessibility
- guidepup's macOS 14 preference bundle installed and mounting cleanly
- VoiceOver starting and stopping under program control
- Safari confirmed frontmost before each walk

macOS is 14.6.1 (23G93). The scripting *control* surface works; the scripting *content*
surface does not.

The accessibility-tree inspection in `measure-a11y-tree.mjs` and the traversal map in
`map-a11y-traversal.mjs` remain automated and are what the predictions above are drawn from.
Neither is a substitute for this pass and neither is reported as one.
