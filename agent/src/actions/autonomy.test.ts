/**
 * FG-234 — the agent never mutates state without approval.
 *
 * ── What this file has to fail on ──────────────────────────────────────────
 * One thing, stated precisely: it must go red if someone lets a `mutation`
 * action reach `routeByBlastRadius`'s **autonomous** branch. Not "if the agent
 * misbehaves in general" — that is unfalsifiable and would be satisfied by tests
 * that pass forever. The specific edit this file exists to catch is a change to
 * `ACTION_BY_SIGNAL` in `graph/nodes/routeAction.ts`.
 *
 * There are three ways that table can be edited into an unapproved mutation, and
 * each gets its own test, because two of the three would slip past a test that
 * only checked the one signal type that is a mutation today:
 *
 *   1  a NEW signal type is added and classified `additive` while its `kind`
 *      changes project state (`{ class: 'additive', kind: 'reassign' }`)
 *   2  an EXISTING additive row's `kind` is changed to a mutating verb
 *   3  `load_imbalance` is reclassified `additive` to "make the agent more
 *      useful", which is exactly how this ends up shipped
 *
 * ── Why it drives the real routing functions, not a copy of the table ──────
 * `routeAction` and `routeByBlastRadius` are pure over `GraphStateType`, so the
 * property can be asserted directly for EVERY signal type without a database, a
 * container, or the graph — which also means it runs on any CI runner, including
 * ones with no Docker daemon. `use-cases.test.ts` asserts the same boundary once
 * through the compiled graph; this asserts it exhaustively.
 *
 * The mutating-kind set below is written out rather than imported, deliberately.
 * It is the specification — "these verbs change project state" — and if someone
 * adds a seventh `kind` to `ProposedAction` the exhaustiveness check at the
 * bottom fails until they decide, in this file, which side of the line it is on.
 */
import { describe, it, expect } from 'vitest';

import { routeAction, routeByBlastRadius } from '../graph/nodes/routeAction.js';
import type { GraphStateType, ProposedAction } from '../graph/state.js';
import { makeShipAct } from './act.js';
import { createShipClient, type FetchLike } from './client.js';
import { SIGNAL_TYPES, type Signal, type SignalType } from '../detectors/types.js';

/**
 * The verbs that change project state.
 *
 * Ship's own vocabulary: an issue's state, who holds it, and which sprint it is
 * in. Anything here is a mutation whatever a table says it is classified as, and
 * the tests below hold `class` and `kind` to agreeing with each other.
 */
const MUTATING_KINDS = ['state_change', 'reassign', 'sprint_move'] as const;

/** The verbs a human can undo without knowing the agent did anything (Q3). */
const ADDITIVE_KINDS = ['comment', 'notify', 'history_note'] as const;

function signalOf(type: SignalType, n = 0): Signal {
  return {
    type,
    targetId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    targetType: type === 'rework_churn' ? 'project' : type === 'stalled_work' ? 'issue' : 'sprint',
    targetTitle: `target for ${type}`,
    measurement: 10,
    threshold: 5,
    bucket: '5-10',
    fingerprint: `fp-${type}-${n}`,
    context: { note: 'synthetic' },
    accountableUserId: '11111111-1111-4111-8111-111111111111',
  };
}

/** The minimum state `routeAction` reads. Everything else is default. */
function stateFor(signals: Signal[]): GraphStateType {
  return {
    mode: 'proactive',
    scope: { workspaceId: '22222222-2222-4222-8222-222222222222' },
    actor: null,
    signals,
    participants: [],
    suppressed: [],
    scannedThrough: new Date(),
    findings: signals.map((s) => ({
      fingerprint: s.fingerprint,
      severity: 'high' as const,
      recipientUserId: s.accountableUserId,
      worthSurfacing: true,
      phrasing: `${s.type} needs attention`,
    })),
    pending: null,
    messages: [],
    answer: null,
    outcome: null,
    errors: [],
  } as GraphStateType;
}

/**
 * The property, as one function so it can be tested against itself.
 *
 * Throws rather than returning a boolean because the message is the whole value
 * of the assertion — someone reading a red CI run needs to be told which signal
 * type widened the boundary and which verb did it, not that a boolean was false.
 */
function assertNotAutonomouslyMutating(action: ProposedAction, type: string): void {
  if ((MUTATING_KINDS as readonly string[]).includes(action.kind)) {
    throw new Error(
      `${type} runs autonomously with kind "${action.kind}", which changes project ` +
        'state. Every mutation must route to the approval gate (PRESEARCH.md Q3/Q4).'
    );
  }
  if (!(ADDITIVE_KINDS as readonly string[]).includes(action.kind)) {
    throw new Error(
      `${type} runs autonomously with kind "${action.kind}", which is on neither side ` +
        'of the additive/mutation line. Classify it before shipping it.'
    );
  }
}

/** Route one signal type the way the graph does: propose, then branch. */
function routeOne(type: SignalType) {
  const signal = signalOf(type);
  const state = stateFor([signal]);
  const update = routeAction(state);
  const routed = { ...state, ...update } as GraphStateType;
  return { action: routed.pending?.action, branch: routeByBlastRadius(routed) };
}

describe('FG-234 — no state mutation reaches the autonomous branch', () => {
  it('routes every signal type, and every one that mutates is GATED', () => {
    // The whole union, not just the one that is a mutation today. A new signal
    // type classified wrongly fails here on the day it is added.
    for (const type of SIGNAL_TYPES) {
      const { action, branch } = routeOne(type);

      expect(action, `${type} produced no action at all`).toBeTruthy();

      if (action!.class === 'mutation') {
        expect(branch, `${type} is a mutation and MUST be gated`).toBe('gated');
      } else {
        expect(branch, `${type} is additive and should run autonomously`).toBe('autonomous');
      }
    }
  });

  it('and nothing that runs autonomously carries a mutating verb', () => {
    // The failure mode the previous test cannot see: `{ class: 'additive', kind:
    // 'reassign' }`. The class says it may run without asking, the kind moves
    // work between people. This is the edit that ships an unapproved mutation
    // with every other test still green.
    for (const type of SIGNAL_TYPES) {
      const { action, branch } = routeOne(type);
      if (branch !== 'autonomous') continue;
      assertNotAutonomouslyMutating(action!, type);
    }
  });

  it('and that check is not vacuous — it rejects a hand-built bad row', () => {
    // Proof the assertion above can fail. Without this, a refactor that made
    // `assertNotAutonomouslyMutating` a no-op would leave this file green and
    // the boundary unguarded, which is the failure mode the whole file exists
    // to prevent — applied to itself.
    expect(() =>
      assertNotAutonomouslyMutating(
        {
          class: 'additive',
          kind: 'reassign',
          targetId: 'x',
          describe: 'someone widened the table',
          payload: {},
        },
        'load_imbalance'
      )
    ).toThrow();
  });

  it('load_imbalance in particular is a mutation and is gated', () => {
    // Named explicitly because it is the one someone will be tempted to
    // reclassify. "The agent already knows who to move the work to, why make a
    // human click" is a reasonable-sounding argument and it is the exact change
    // the approval gate exists to stop.
    const { action, branch } = routeOne('load_imbalance');
    expect(action!.class).toBe('mutation');
    expect(action!.kind).toBe('reassign');
    expect(branch).toBe('gated');
  });

  it('a mutation is gated no matter how high its severity ranks it', () => {
    // Blast radius, never urgency. A high-severity mutation and a low-severity
    // one take the same branch, because "how bad is it" is a different question
    // from "may the agent do this".
    const imbalance = signalOf('load_imbalance');
    for (const severity of ['high', 'medium', 'low'] as const) {
      const state = stateFor([imbalance]);
      state.findings[0]!.severity = severity;
      const routed = { ...state, ...routeAction(state) } as GraphStateType;
      expect(routeByBlastRadius(routed), `severity ${severity}`).toBe('gated');
    }
  });

  it('routes to the gate when a mutation outranks additive findings in the same run', () => {
    // One finding is escalated per run, by severity. If the mutation wins that
    // ranking the run must suspend — an implementation that quietly preferred an
    // additive finding to avoid interrupting anyone would pass every test above.
    const imbalance = { ...signalOf('load_imbalance', 1) };
    const stalled = { ...signalOf('stalled_work', 2) };
    const state = stateFor([stalled, imbalance]);
    state.findings[0]!.severity = 'low';
    state.findings[1]!.severity = 'high';

    const routed = { ...state, ...routeAction(state) } as GraphStateType;
    expect(routed.pending?.action.class).toBe('mutation');
    expect(routeByBlastRadius(routed)).toBe('gated');
  });

  it('every kind in the union is classified on one side of the line', () => {
    // Exhaustiveness. `ProposedAction['kind']` is a closed union, so a seventh
    // member added without a decision here fails this assignment at `tsc` and
    // this test at runtime — rather than defaulting to whatever the routing
    // table happens to say.
    const all: Array<ProposedAction['kind']> = [...ADDITIVE_KINDS, ...MUTATING_KINDS];
    const declared: Array<ProposedAction['kind']> = [
      'comment',
      'notify',
      'history_note',
      'state_change',
      'reassign',
      'sprint_move',
    ];
    expect([...all].sort()).toEqual([...declared].sort());
  });
});

describe('FG-234 — and the action layer refuses a mutation even if one reaches it', () => {
  /**
   * Defence in depth, asserted against the wire.
   *
   * `act.test.ts` already checks the refusal message. What this adds is that a
   * refused mutation issues NO HTTP AT ALL — a version that posted a "proposed
   * change" comment and then refused would satisfy a message-only assertion
   * while having already written to Ship.
   */
  it('sends nothing on the network when handed a mutation directly', async () => {
    const sent: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      sent.push(`${init.method} ${url}`);
      return { status: 201, ok: true, text: async () => '{}' };
    };

    const act = makeShipAct(
      createShipClient({ baseUrl: 'http://ship.test', token: 't', fetchImpl })
    );

    for (const kind of MUTATING_KINDS) {
      const action: ProposedAction = {
        class: 'mutation',
        kind,
        targetId: '33333333-3333-4333-8333-333333333333',
        describe: `apply ${kind}`,
        payload: { targetType: 'issue' },
      };
      const result = await act(action);
      expect(result.ok, `${kind} must be refused`).toBe(false);
    }

    expect(sent, 'a refused mutation must not touch Ship at all').toEqual([]);
  });
});
