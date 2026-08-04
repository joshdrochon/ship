/**
 * Every one of these is a configuration that looks right and traces nothing.
 *
 * They matter because the symptom is identical in all of them — an empty
 * LangSmith project — and identical to the symptom of a graph that never ran.
 * Without a check, the natural conclusion is "the agent is broken", and the
 * next hour goes into debugging a system that is working fine.
 */
import { describe, it, expect } from 'vitest';

import { tracingStatus, ensureSynchronousCallbacks } from './tracing.js';

const KEY = 'lsv2_pt_notarealkey';

describe('tracingStatus', () => {
  it('is enabled only with the literal string "true" AND a key', () => {
    const s = tracingStatus({ LANGCHAIN_TRACING_V2: 'true', LANGCHAIN_API_KEY: KEY, LANGCHAIN_PROJECT: 'p' });
    expect(s.enabled).toBe(true);
    expect(s.warning).toBeNull();
  });

  it('warns that "1" does not enable tracing', () => {
    // The expensive one. Every other boolean env var in this codebase accepts
    // 1/true/yes; LangChain compares against the string.
    const s = tracingStatus({ LANGCHAIN_TRACING_V2: '1', LANGCHAIN_API_KEY: KEY });
    expect(s.enabled).toBe(false);
    expect(s.warning).toContain('literal string "true"');
  });

  it('warns when tracing is on but no key is set', () => {
    const s = tracingStatus({ LANGCHAIN_TRACING_V2: 'true' });
    expect(s.enabled).toBe(false);
    expect(s.warning).toContain('LANGCHAIN_API_KEY is unset');
  });

  it('warns when a key is set but tracing was never turned on', () => {
    const s = tracingStatus({ LANGCHAIN_API_KEY: KEY });
    expect(s.enabled).toBe(false);
    expect(s.warning).toContain('the key alone does not enable tracing');
  });

  it('warns when traces would land in the default project', () => {
    const s = tracingStatus({ LANGCHAIN_TRACING_V2: 'true', LANGCHAIN_API_KEY: KEY });
    expect(s.enabled).toBe(true);
    expect(s.warning).toContain('default');
  });

  it('is silent when tracing is simply off', () => {
    // Not a misconfiguration. Local runs without a key are normal and should
    // not print a warning every time.
    const s = tracingStatus({});
    expect(s.enabled).toBe(false);
    expect(s.warning).toBeNull();
  });

  it('never carries the key in its output', () => {
    const s = tracingStatus({ LANGCHAIN_TRACING_V2: 'true', LANGCHAIN_API_KEY: KEY });
    expect(JSON.stringify(s)).not.toContain(KEY);
  });
});

describe('ensureSynchronousCallbacks', () => {
  it('defaults background callbacks OFF', () => {
    // The cron exits the moment the scan ends. LangChain uploads traces on a
    // background queue that dies with the process, so leaving this unset means
    // the run is correct and LangSmith stays empty — which is exactly the
    // symptom the rest of this file exists to make diagnosable.
    //
    // Measured before it was fixed: the same quiet run produced zero LangSmith
    // sessions without the flag and a trace with it.
    const env: NodeJS.ProcessEnv = {};
    ensureSynchronousCallbacks(env);
    expect(env.LANGCHAIN_CALLBACKS_BACKGROUND).toBe('false');
  });

  it('does not override an explicit setting', () => {
    // A long-running host should be able to put the queue back.
    const env: NodeJS.ProcessEnv = { LANGCHAIN_CALLBACKS_BACKGROUND: 'true' };
    ensureSynchronousCallbacks(env);
    expect(env.LANGCHAIN_CALLBACKS_BACKGROUND).toBe('true');
  });
});
