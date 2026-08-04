/**
 * The on-demand answer path, and the boundary it must not cross.
 *
 * Two things are worth a test here and the second is the one that matters. The
 * first is ordinary: a reachable model produces text, an unreachable one
 * degrades instead of throwing. The second is that what leaves the process is
 * measurements — the prompt renderer is the only place project data could leak
 * to a third-party model, so it gets an assertion rather than a comment.
 */
import { describe, it, expect } from 'vitest';

import { composeAnswer } from './answer.js';
import { renderAnswerInput } from './prompts/answer.js';
import { CircuitBreaker, type PromptedModel } from './client.js';
import type { AnswerInput } from './answer.js';
import type { Signal } from '../detectors/types.js';

const ASSIGNEE = '11111111-1111-1111-1111-111111111111';

const SIGNAL: Signal = {
  type: 'review_bottleneck',
  targetId: '33333333-3333-3333-3333-333333333333',
  targetType: 'issue',
  targetTitle: 'Wire up the export endpoint',
  measurement: 6,
  threshold: 2,
  bucket: '5-9d',
  fingerprint: 'review_bottleneck:33333333:5-9d',
  context: { status: 'in_review', business_days_waiting: 6 },
  accountableUserId: ASSIGNEE,
};

const INPUT: AnswerInput = {
  scope: {
    workspaceId: '44444444-4444-4444-4444-444444444444',
    documentId: SIGNAL.targetId,
    documentType: 'issue',
    tab: 'overview',
  },
  question: 'Is anything blocking this?',
  participants: [{ userId: ASSIGNEE, roles: ['assignee'] }],
  signals: [SIGNAL],
};

describe('composeAnswer', () => {
  it('returns the model text', async () => {
    const model: PromptedModel = {
      async invoke() {
        return { content: '  It has been in review for 6 working days.  ' };
      },
    };

    const result = await composeAnswer(INPUT, { model });

    expect(result).toEqual({
      status: 'answered',
      text: 'It has been in review for 6 working days.',
    });
  });

  it('degrades instead of throwing when the circuit is open', async () => {
    const breaker = new CircuitBreaker({ name: 'test', failureThreshold: 1, cooldownMs: 60_000 });
    await expect(breaker.run(async () => { throw new Error('bedrock down'); })).rejects.toThrow();

    let calls = 0;
    const model: PromptedModel = {
      async invoke() {
        calls += 1;
        return { content: 'should never run' };
      },
    };

    const result = await composeAnswer(INPUT, { model, breaker });

    expect(result.status).toBe('ai_unavailable');
    expect(result.text).toContain('could not reach');
    expect(calls).toBe(0);
  });

  it('treats an unrecognised completion shape as unavailable, not as an answer', async () => {
    const model: PromptedModel = {
      async invoke() {
        return { unexpected: true };
      },
    };

    const result = await composeAnswer(INPUT, { model });

    // The alternative is rendering "[object Object]" to a user and calling it
    // a grounded response.
    expect(result).toMatchObject({ status: 'ai_unavailable', reason: 'invalid_output' });
  });
});

describe('renderAnswerInput', () => {
  it('sends measurements and ids, never names or content', () => {
    const rendered = renderAnswerInput({
      ...INPUT,
      participants: [
        // A name on the participant must not reach the prompt even if a caller
        // supplies one — the renderer reads userId and roles, and nothing else.
        { userId: ASSIGNEE, roles: ['assignee'], name: 'Dana Whitfield' } as never,
      ],
    });

    expect(rendered).toContain(ASSIGNEE);
    expect(rendered).toContain('assignee');
    expect(rendered).toContain('measured 6');
    expect(rendered).toContain('threshold 2');
    expect(rendered).toContain('Is anything blocking this?');

    expect(rendered).not.toContain('Dana');
    expect(rendered).not.toContain('Whitfield');
  });

  it('says so explicitly when nothing is currently crossing a threshold', () => {
    const rendered = renderAnswerInput({ ...INPUT, signals: [] });

    // An omitted section reads as missing data; "none" is an answer.
    expect(rendered).toContain('no detector threshold is currently crossed');
  });
});
