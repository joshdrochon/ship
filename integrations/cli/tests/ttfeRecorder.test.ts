/**
 * PF-591 / PF-592 / PF-593 / PF-609 — the drill's measuring apparatus, tested
 * without booting anything.
 *
 * ── Why these are here and not inside the drill ────────────────────────────
 * PF-593's acceptance is *"force a failure in each of the six stages in turn and
 * assert the message names that stage."* Six forced failures inside the live
 * drill is six container boots, six installs and six device flows to prove a
 * property of a `catch` block — roughly six minutes of CI to test string
 * formatting. These run in milliseconds and test the same code the live drill
 * uses, because it is literally the same class.
 *
 * What that does NOT cover, stated rather than implied: that a REAL failure in a
 * real stage reaches this code path. The live drill's `finally` writes the
 * artifact on both paths, and PF-607's negative control (`ttfe.negative.drill.ts`)
 * is the one place a genuine platform defect is observed turning the drill red.
 */
import { describe, expect, it } from 'vitest';
import { STAGE_IDS, STAGE_LABELS, type StageId } from './ttfe/stages.js';
import { StageFailure, StageRecorder } from './ttfe/recorder.js';
import { thresholds, THRESHOLDS_PATH } from './ttfe/thresholds.js';
import { hasPeerDependencyComplaint, PEER_DEPENDENCY_MARKERS } from './ttfe/install.js';
import { READY_PREFIX } from './ttfe/shipInstance.js';
import { readFileSync } from 'node:fs';

describe('PF-591 — the six stages, frozen', () => {
  it('is exactly p.6\'s six ids, in p.6\'s order', () => {
    expect([...STAGE_IDS]).toEqual([
      'install',
      'login',
      'register_subscription',
      'create_document',
      'receive_webhook',
      'verify_signature',
    ]);
  });

  it('cannot be renamed, reordered or extended at runtime', () => {
    expect(Object.isFrozen(STAGE_IDS)).toBe(true);
    // `readonly` is erased by tsc, so the runtime guarantee is the one that
    // matters: a consumer that can push here can add a seventh stage.
    expect(() => (STAGE_IDS as unknown as string[]).push('extra')).toThrow();
    expect(STAGE_IDS).toHaveLength(6);
  });

  it('has a label for every id and no orphan labels', () => {
    expect(Object.keys(STAGE_LABELS).sort()).toEqual([...STAGE_IDS].sort());
  });
});

describe('PF-591 — reconciliation', () => {
  it('reports every stage it ran, and names the ones it did not', async () => {
    const recorder = new StageRecorder();
    await recorder.stage('install', async () => undefined);
    await recorder.stage('login', async () => undefined);

    expect(recorder.missingStages()).toEqual([
      'register_subscription',
      'create_document',
      'receive_webhook',
      'verify_signature',
    ]);
  });

  it('stage times plus measured gaps reconcile with the total', async () => {
    const recorder = new StageRecorder();
    for (const id of STAGE_IDS) {
      // Real work, not a no-op: a reconciliation that only holds for zero-length
      // stages holds for nothing.
      await recorder.stage(id, async () => {
        let sink = 0;
        for (let i = 0; i < 50_000; i += 1) sink += i;
        return sink;
      });
    }

    expect(recorder.missingStages()).toEqual([]);
    expect(recorder.reconciliationErrorMs).toBeLessThanOrEqual(thresholds().reconcileToleranceMs);
    expect(recorder.stageSumMs).toBeGreaterThan(0);
    expect(recorder.totalMs).toBeGreaterThanOrEqual(recorder.stageSumMs);
  });

  it('every elapsedMs is finite and non-negative', async () => {
    const recorder = new StageRecorder();
    for (const id of STAGE_IDS) await recorder.stage(id, async () => undefined);
    for (const record of recorder.stages) {
      expect(Number.isFinite(record.elapsedMs)).toBe(true);
      expect(record.elapsedMs).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('PF-593 — a failure names the stage, its elapsed ms, and the assertion', () => {
  // The acceptance criterion, literally: each of the six in turn.
  for (const id of STAGE_IDS) {
    it(`names "${id}" when ${id} is the stage that fails`, async () => {
      const recorder = new StageRecorder();
      // Stages before this one succeed, so the artifact carries partial progress.
      for (const earlier of STAGE_IDS) {
        if (earlier === id) break;
        await recorder.stage(earlier, async () => undefined);
      }

      const thrown = await recorder
        .stage(id, async () => {
          throw new Error('expected 200, received 500');
        })
        .then(
          () => null,
          (error: unknown) => error,
        );

      expect(thrown).toBeInstanceOf(StageFailure);
      const failure = thrown as StageFailure;
      expect(failure.stage).toBe(id);
      // The stage id, the human label, the number, and the original assertion —
      // all on the FIRST line, before any stack.
      const firstLine = failure.message.split('\n')[0] ?? '';
      expect(firstLine).toContain(id);
      expect(firstLine).toContain(STAGE_LABELS[id]);
      expect(firstLine).toMatch(/FAILED after \d+ ms/);
      expect(firstLine).toContain('expected 200, received 500');
      expect(failure.elapsedMs).toBeGreaterThanOrEqual(0);

      // PF-593: the artifact still exists, with pass:false and the stages that
      // did complete. A failure that produces no artifact produces no diagnosis.
      const artifact = recorder.toArtifact('fast', 'deadbeef', failure);
      expect(artifact.pass).toBe(false);
      expect(artifact.failure?.stage).toBe(id);
      expect(artifact.stages.map((stage) => stage.id)).toContain(id);
      expect(artifact.stages.length).toBe(STAGE_IDS.indexOf(id) + 1);
    });
  }

  it('a timeout INSIDE a stage is that stage timing out, not a generic runner timeout', async () => {
    const recorder = new StageRecorder();
    const thrown = await recorder
      .stage('receive_webhook', async () => {
        throw new Error('receive_webhook: no delivery satisfying "…" arrived within 5000 ms');
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect((thrown as StageFailure).stage).toBe('receive_webhook');
    expect((thrown as StageFailure).message).toContain('receive_webhook');
  });
});

describe('PF-592 — the artifact shape four consumers read', () => {
  it('carries mode, commit, startedAtIso, stages, totalMs and pass', async () => {
    const recorder = new StageRecorder();
    for (const id of STAGE_IDS) await recorder.stage(id, async () => undefined);
    recorder.record('eventToPostMs', 24);

    const artifact = recorder.toArtifact('fast', 'abc123');
    expect(Object.keys(artifact).sort()).toEqual(
      ['commit', 'metrics', 'mode', 'pass', 'stages', 'startedAtIso', 'totalMs'].sort(),
    );
    expect(artifact.mode).toBe('fast');
    expect(artifact.commit).toBe('abc123');
    expect(artifact.pass).toBe(true);
    expect(artifact.stages.map((stage) => stage.id)).toEqual([...STAGE_IDS]);
    expect(new Date(artifact.startedAtIso).toString()).not.toBe('Invalid Date');
    expect(artifact.metrics.eventToPostMs).toBe(24);
  });

  it('the human table lists every stage and a total', async () => {
    const recorder = new StageRecorder();
    for (const id of STAGE_IDS) await recorder.stage(id, async () => undefined);
    const table = recorder.toTable();
    for (const id of STAGE_IDS) expect(table).toContain(STAGE_LABELS[id]);
    expect(table).toContain('TOTAL');
  });
});

describe('PF-609 — every threshold comes from one committed file', () => {
  it('every budget the drill uses is present, positive and finite', () => {
    const values = thresholds();
    // Deliberately NOT `toBe(60_000)`. Pinning the number here would put a
    // second copy of a graded budget in a test body, which is the thing PF-609
    // exists to prevent — and `scripts/ttfe/check-fitness.mjs` fails the build
    // on exactly that. The one place outside the JSON that may name the number
    // is the fitness script, and it names it in order to forbid it elsewhere.
    for (const key of [
      'totalMs',
      'p95TotalMs',
      'p95EventToPostMs',
      'verifyLatencyMs',
      'p95WindowRuns',
      'reconcileToleranceMs',
      'loadRatioVeto',
      'cleanModeMinutes',
    ] as const) {
      expect(Number.isFinite(values[key]), `threshold "${key}" is missing or not a number`).toBe(true);
      expect(values[key], `threshold "${key}" must be positive`).toBeGreaterThan(0);
    }
    // Every stage id must have a budget, or a stage silently has none.
    for (const id of STAGE_IDS) {
      expect(values.stageMs[id], `stage "${id}" has no budget in ttfe.thresholds.json`).toBeGreaterThan(0);
    }
  });

  it('every number in the file is explained by a sibling `_` key', () => {
    const raw = JSON.parse(readFileSync(THRESHOLDS_PATH, 'utf8')) as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (key.startsWith('_')) continue;
      expect(
        Object.prototype.hasOwnProperty.call(raw, `_${key}`),
        `threshold "${key}" has no "_${key}" explaining where the number comes from`,
      ).toBe(true);
    }
  });
});

describe('the small contracts the drill depends on', () => {
  it('PF-594(c): the peer-dependency check fires on the words an installer actually uses', () => {
    for (const marker of PEER_DEPENDENCY_MARKERS) {
      expect(hasPeerDependencyComplaint(`something something ${marker} something`)).toBe(true);
    }
    // A clean install must not trip it — a check that fires on everything is a
    // check that gets deleted.
    expect(hasPeerDependencyComplaint('Packages: +1\nProgress: resolved 1, downloaded 0, added 1')).toBe(
      false,
    );
  });

  it('the harness ready prefix is spelled the same on both sides of the process boundary', () => {
    const harnessSource = readFileSync(
      new URL('../../../scripts/ttfe/harness.ts', import.meta.url),
      'utf8',
    );
    // Read as TEXT, not imported: importing the harness would pull `pg` and the
    // server's world into this package's module graph, which is the boundary
    // PF-588 exists to keep. A mismatched prefix would otherwise hang the drill
    // for its full timeout with no explanation.
    expect(harnessSource).toContain(`export const READY_PREFIX = '${READY_PREFIX}'`);
  });

  it('the stage ids the drill asserts are the ids the thresholds file budgets', () => {
    const budgeted = Object.keys(thresholds().stageMs).sort();
    expect(budgeted).toEqual([...STAGE_IDS].sort() as unknown as StageId[]);
  });
});
