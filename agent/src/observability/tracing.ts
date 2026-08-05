/**
 * Tracing configuration, and the one thing it exists to prevent.
 *
 * ── LangChain picks tracing up from the environment on its own ──────────────
 * There is no client to construct. If `LANGCHAIN_TRACING_V2` is the string
 * "true" and `LANGCHAIN_API_KEY` is set, every graph run is traced; otherwise
 * nothing is. So this module configures nothing — it REPORTS.
 *
 * ── Why reporting is worth a file ──────────────────────────────────────────
 * A disabled tracer is indistinguishable from a graph that never ran. Both
 * produce an empty LangSmith project, and the natural conclusion — "the agent
 * isn't working" — sends you debugging the wrong system entirely.
 *
 * The failure modes are all quiet:
 *
 *   LANGCHAIN_TRACING_V2=1        LangChain compares against the string "true".
 *                                 "1" and "yes" both disable tracing silently.
 *   tracing on, no key            The tracer never starts. No warning.
 *   key set, tracing unset        Also nothing. The key alone does not enable it.
 *
 * So the cron logs its tracing state once per run. One line, at the top, saying
 * whether traces are going anywhere — which turns "why is LangSmith empty" from
 * an investigation into a glance.
 */

/**
 * Make tracing synchronous, or a short-lived process loses every trace.
 *
 * LangChain uploads traces on a background queue. That is correct for a server,
 * which stays alive long enough to drain it. A cron container does not: it
 * scans, exits, and the queue dies with the process. The run completes, the
 * scan is correct, and LangSmith stays empty forever.
 *
 * Measured, not assumed. The first quiet run against a live key produced zero
 * sessions in LangSmith; the identical run with this flag produced the trace
 * immediately. Same code, same workspace, one environment variable apart.
 *
 * The cost is real — the scan now waits on the upload before exiting — and it
 * is the right trade here. A trace that never arrives has no value, and this
 * process has nothing else to do with the time.
 *
 * Not forced: an explicit setting in the environment wins, so a long-running
 * host can turn it back off.
 */
export function ensureSynchronousCallbacks(env: NodeJS.ProcessEnv = process.env): void {
  if (env.LANGCHAIN_CALLBACKS_BACKGROUND === undefined) {
    env.LANGCHAIN_CALLBACKS_BACKGROUND = 'false';
  }
}

export interface TracingStatus {
  enabled: boolean;
  project: string | null;
  /** Set when the configuration looks like an attempt that will not work. */
  warning: string | null;
}

export function tracingStatus(env: NodeJS.ProcessEnv = process.env): TracingStatus {
  const flag = env.LANGCHAIN_TRACING_V2;
  const key = env.LANGCHAIN_API_KEY;
  const project = env.LANGCHAIN_PROJECT ?? null;

  const flagOn = flag === 'true';
  const enabled = flagOn && Boolean(key);

  let warning: string | null = null;

  if (flag && !flagOn) {
    // The one that costs the most time, because it looks correct.
    warning =
      `LANGCHAIN_TRACING_V2 is "${flag}" — LangChain checks for the literal ` +
      'string "true", so tracing is OFF';
  } else if (flagOn && !key) {
    warning = 'LANGCHAIN_TRACING_V2 is true but LANGCHAIN_API_KEY is unset — tracing is OFF';
  } else if (!flagOn && key) {
    warning =
      'LANGCHAIN_API_KEY is set but LANGCHAIN_TRACING_V2 is not "true" — ' +
      'the key alone does not enable tracing';
  } else if (enabled && !project) {
    warning =
      'LANGCHAIN_PROJECT is unset — runs will land in the LangSmith default ' +
      'project, mixed in with everything else';
  }

  return { enabled, project, warning };
}

/**
 * One line, once per process. Never logs the key — only whether one is present.
 */
export function logTracingStatus(env: NodeJS.ProcessEnv = process.env): TracingStatus {
  const status = tracingStatus(env);

  console.log(
    JSON.stringify({
      event: 'fleetgraph.tracing',
      enabled: status.enabled,
      project: status.project,
      ...(status.warning ? { warning: status.warning } : {}),
    })
  );

  return status;
}
