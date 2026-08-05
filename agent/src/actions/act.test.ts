/**
 * What the graph's `ActFn` actually does with a proposal.
 *
 * The claims here are about the Q3 boundary rather than about HTTP: an additive
 * action posts AND records itself, a mutation does neither, and neither of
 * those is decided by anything the model said. The client is a fake with
 * counters (engineering requirement 3), so "the audit note was written" is a
 * recorded call, not an inference.
 */
import { describe, it, expect } from 'vitest';

import { makeShipAct } from './act.js';
import type { ShipClient, ShipResult } from './client.js';
import type { ProposedAction } from '../graph/state.js';

const TARGET = '11111111-2222-4333-8444-555555555555';

function fakeClient(
  overrides: { comment?: ShipResult; history?: ShipResult } = {}
): ShipClient & {
  comments: Array<{ documentId: string; content: string }>;
  notes: Array<{ issueId: string; entry: Record<string, unknown> }>;
} {
  const comments: Array<{ documentId: string; content: string }> = [];
  const notes: Array<{ issueId: string; entry: Record<string, unknown> }> = [];

  return {
    comments,
    notes,
    async postComment(documentId, content) {
      comments.push({ documentId, content });
      return overrides.comment ?? { ok: true, status: 201, data: { id: 'c1' } };
    },
    async logHistoryNote(issueId, entry) {
      notes.push({ issueId, entry: entry as unknown as Record<string, unknown> });
      return overrides.history ?? { ok: true, status: 201, data: { success: true } };
    },
  };
}

function commentAction(overrides: Partial<ProposedAction> = {}): ProposedAction {
  return {
    class: 'additive',
    kind: 'comment',
    targetId: TARGET,
    describe: 'Post a comment on "Fix login": no movement in 14 days',
    payload: {
      signalType: 'stalled_work',
      targetType: 'issue',
      measurement: 14,
      threshold: 5,
      phrasing: 'This has not moved in 14 business days.',
      context: {},
    },
    ...overrides,
  };
}

describe('FG-126 — the autonomous comment', () => {
  it('posts the model phrasing WITH the measurement that triggered it', async () => {
    const client = fakeClient();
    const result = await makeShipAct(client)(commentAction());

    expect(result.ok).toBe(true);
    expect(client.comments).toHaveLength(1);
    expect(client.comments[0]!.documentId).toBe(TARGET);

    const body = client.comments[0]!.content;
    expect(body).toContain('has not moved in 14 business days');
    // A comment that says "this looks stalled" invites an argument; one that
    // cites the number and the bar does not, and the number is checkable.
    expect(body).toContain('14');
    expect(body).toContain('5');
    expect(body).toContain('FleetGraph');
  });

  it('FG-127 — and records itself in document_history', async () => {
    const client = fakeClient();
    await makeShipAct(client)(commentAction());

    expect(client.notes, 'every autonomous write must be attributable').toHaveLength(1);
    expect(client.notes[0]!.issueId).toBe(TARGET);
    expect(client.notes[0]!.entry.field).toBe('fleetgraph_comment');
    expect(String(client.notes[0]!.entry.newValue)).toContain('stalled_work');
  });

  it('posts the comment BEFORE the audit note', async () => {
    // If the process dies between them, a visible comment with no history row
    // is reconcilable by a human. A history row claiming a comment that does
    // not exist is not — there is nothing to go and find.
    const order: string[] = [];
    const client: ShipClient = {
      async postComment() {
        order.push('comment');
        return { ok: true, status: 201, data: null };
      },
      async logHistoryNote() {
        order.push('history');
        return { ok: true, status: 201, data: null };
      },
    };

    await makeShipAct(client)(commentAction());
    expect(order).toEqual(['comment', 'history']);
  });

  it('reports a failed audit note even though the comment succeeded', async () => {
    // Returning ok here would make the property the whole autonomy argument
    // rests on — every automated write is attributable — quietly untrue.
    const client = fakeClient({
      history: { ok: false, reason: 'http_error', status: 500, detail: 'boom' },
    });

    const result = await makeShipAct(client)(commentAction());

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('audit note failed');
    expect(result.detail).toContain('unattributed');
  });

  it('does not write an audit note when the comment failed', async () => {
    const client = fakeClient({
      comment: { ok: false, reason: 'circuit_open', detail: 'circuit is open' },
    });

    const result = await makeShipAct(client)(commentAction());

    expect(result.ok).toBe(false);
    expect(client.notes, 'nothing happened, so nothing is logged').toHaveLength(0);
  });

  it('says so when the target is not an issue and no history row is possible', async () => {
    // POST /api/issues/:id/history verifies document_type = 'issue', so a
    // sprint target genuinely has no attributable row available. Reported
    // rather than swallowed — that is a gap in Ship, and hiding it does not
    // close it.
    const client = fakeClient();
    const result = await makeShipAct(client)(
      commentAction({
        payload: { ...commentAction().payload, targetType: 'sprint' },
      })
    );

    expect(result.ok).toBe(true);
    expect(client.notes).toHaveLength(0);
    expect(result.detail).toContain('no document_history row');
  });
});

describe('Q3/Q4 — mutations do not execute here', () => {
  it('refuses a mutation and names why', async () => {
    const client = fakeClient();
    const result = await makeShipAct(client)({
      class: 'mutation',
      kind: 'reassign',
      targetId: TARGET,
      describe: 'Propose rebalancing work in "Week 32"',
      payload: { signalType: 'load_imbalance', targetType: 'sprint' },
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('refused');
    // The reason is the API's, and it is specific enough to act on.
    expect(result.detail).toContain("z.literal('claude')");
    expect(client.comments).toHaveLength(0);
    expect(client.notes).toHaveLength(0);
  });

  it('refuses every mutation kind, not just the one routeAction produces today', async () => {
    const client = fakeClient();
    const act = makeShipAct(client);

    for (const kind of ['state_change', 'reassign', 'sprint_move'] as const) {
      const result = await act({
        class: 'mutation',
        kind,
        targetId: TARGET,
        describe: kind,
        payload: { targetType: 'issue' },
      });
      expect(result.ok, kind).toBe(false);
    }

    expect(client.comments).toHaveLength(0);
    expect(client.notes).toHaveLength(0);
  });

  it('refuses a mutation even when it is mislabelled additive on a mutating kind', async () => {
    // Defence in depth for the one branch the whole safety argument reduces to.
    // `routeByBlastRadius` should make this unreachable; if it is ever rewired,
    // the action layer must not be the thing that lets it through.
    const client = fakeClient();
    const result = await makeShipAct(client)({
      class: 'additive',
      kind: 'reassign',
      targetId: TARGET,
      describe: 'sneaky',
      payload: { targetType: 'issue' },
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('unhandled additive kind');
    expect(client.comments).toHaveLength(0);
  });
});

describe('the remaining additive kinds', () => {
  it('a history_note writes only the history row', async () => {
    const client = fakeClient();
    const result = await makeShipAct(client)(
      commentAction({ kind: 'history_note', describe: 'log an observation' })
    );

    expect(result.ok).toBe(true);
    expect(client.comments).toHaveLength(0);
    expect(client.notes).toHaveLength(1);
    expect(client.notes[0]!.entry.field).toBe('fleetgraph_note');
  });

  it('a notify sends no HTTP at all', async () => {
    // Notifications live in fleetgraph_notifications and are written by the
    // delivery node over SQL, through data/boundary.ts.
    const client = fakeClient();
    const result = await makeShipAct(client)(commentAction({ kind: 'notify' }));

    expect(result.ok).toBe(true);
    expect(client.comments).toHaveLength(0);
    expect(client.notes).toHaveLength(0);
  });
});
