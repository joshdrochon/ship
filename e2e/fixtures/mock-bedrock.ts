/**
 * In-process mock of the AWS Bedrock InvokeModel endpoint, for E2E runs.
 *
 * Implementation Rule 3 requires tests to run against stable fakes rather than live
 * external services. Before this existed, the isolated E2E environment set neither
 * `BEDROCK_ENDPOINT` nor any AWS credential in the API child process, so on a developer
 * or CI machine that happened to have real AWS credentials in the environment (or in
 * `~/.aws`, or an instance role) `e2e/ai-analysis-api.spec.ts` made real, billed calls
 * to `bedrock-runtime.us-east-1.amazonaws.com` — eleven of them in the rate-limit test
 * alone, each with a 2048-token Opus budget. The tests could not tell, because the
 * assertions accepted `{ error: 'ai_unavailable' }` as a pass.
 *
 * This is not a Bedrock emulator. It answers exactly the one call
 * `api/src/services/ai-analysis.ts` makes — `POST /model/{modelId}/invoke` — with a
 * well-formed Anthropic Messages payload whose single text block is the JSON that
 * `analyzePlan`/`analyzeRetro` parse. It ignores SigV4 entirely: the SDK signs with the
 * dummy credentials the fixture injects and this never looks at the signature.
 *
 * The response is *derived from the request* rather than canned, so an assertion can
 * check that the analysis actually corresponds to the plan that was submitted. Both
 * prompts number their items (`1. …`), which is what gets echoed back.
 *
 * Why an in-process Node server rather than the `mockserver` container in
 * `docker-compose.mocks.yml`: the E2E fixture already spawns one API process per
 * Playwright worker on its own port, and a per-worker HTTP listener costs nothing and
 * needs no Docker. Reusing the compose service would make every E2E run depend on a
 * container the Playwright config does not manage.
 */

// HTTP/2, not HTTP/1.1. `@aws-sdk/client-bedrock-runtime` defaults to `NodeHttp2Handler`
// -- Bedrock's streaming operations require it, and the handler is client-wide, so even
// the non-streaming `InvokeModel` is sent over h2. An HTTP/1.1 listener answers that with
// `ERR_HTTP2_ERROR: Protocol error` before any body is read, `callBedrock` throws, and the
// route degrades to `ai_unavailable` -- which is indistinguishable from "no credentials"
// unless someone reads the API log. `allowHTTP1: true` keeps the server usable from curl
// or any future HTTP/1.1 caller; the compat `request` event serves both protocols.
import { createServer, type Http2Server, type Http2ServerRequest } from 'http2';
import type { AddressInfo } from 'net';

export interface MockBedrock {
  /** Endpoint override to hand the API child process as `BEDROCK_ENDPOINT`. */
  url: string;
  /** Number of InvokeModel calls served — lets a test assert the mock was actually hit. */
  invocations: () => number;
  /** Number of Converse calls served — the FleetGraph agent's path (FG-271). */
  converseInvocations: () => number;
  close: () => Promise<void>;
}

/** The Bedrock request body `callBedrock` builds. */
interface InvokeBody {
  system?: string;
  messages?: Array<{ role: string; content: string }>;
}

/**
 * Pull `1. item` / `2. item` lines out of a prompt.
 *
 * Both `analyzePlan` and `analyzeRetro` format their items this way
 * (`items.map((item, i) => \`${i + 1}. ${item}\`).join('\n')`), so one parser serves
 * both. `slice` on the retro prompt keeps the RETRO CONTENT section out of it.
 */
function numberedItems(prompt: string): string[] {
  const planSection = prompt.includes('RETRO CONTENT:')
    ? prompt.slice(0, prompt.indexOf('RETRO CONTENT:'))
    : prompt;

  const items: string[] = [];
  for (const line of planSection.split('\n')) {
    const match = /^\s*\d+\.\s+(.*\S)\s*$/.exec(line);
    if (match?.[1]) items.push(match[1]);
  }
  return items;
}

/**
 * The JSON text block the model is expected to return.
 *
 * Deterministic by construction: scores are fixed, and the item list mirrors the
 * submitted items in order. A test can therefore assert on exact structure and exact
 * item text without asserting on model behaviour.
 */
function analysisJson(body: InvokeBody): string {
  const system = body.system ?? '';
  const prompt = body.messages?.[0]?.content ?? '';
  const items = numberedItems(prompt);
  const isRetro = system.includes('weekly retrospectives');

  if (isRetro) {
    return JSON.stringify({
      overall_score: 0.75,
      plan_coverage: items.map((text, i) => ({
        plan_item: text,
        addressed: i % 2 === 0,
        has_evidence: i % 2 === 0,
        feedback: `MOCK: deterministic coverage verdict for item ${i + 1}.`,
      })),
      suggestions: ['MOCK: add a link to the deliverable for each completed item.'],
    });
  }

  return JSON.stringify({
    overall_score: 0.6,
    items: items.map((text, i) => ({
      text,
      score: 0.6,
      feedback: `MOCK: deterministic verdict for item ${i + 1}.`,
      issues: ['too_vague'],
      conciseness_score: 0.8,
      is_verbose: false,
      conciseness_feedback: '',
    })),
    workload_assessment: 'moderate',
    workload_feedback: 'MOCK: deterministic workload verdict.',
  });
}

function readBody(req: Http2ServerRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}


/**
 * ── The Converse endpoint (FG-271) ──────────────────────────────────────────
 *
 * FleetGraph's agent uses `ChatBedrockConverse`, which calls
 * `POST /model/{modelId}/converse` — a different operation from the
 * `/invoke` above that `api/src/services/ai-analysis.ts` uses. Until this
 * existed the mock 404'd it, so CI could not exercise judgement at ALL: every
 * judged run degraded to `ai_unavailable`, and the tests accepted that as a
 * pass. Exactly the failure this file was written to stop, one endpoint over.
 *
 * The response is derived from the request, and it has to be. `judgeSignals`
 * copies each finding's fingerprint through, and `routeAction` drops any
 * finding whose fingerprint does not match a measured signal. A canned response
 * would therefore be silently discarded by the graph and the run would look
 * quiet — indistinguishable from a healthy project, which is the one confusion
 * this whole system is built to avoid.
 */

/** The Converse request body the SDK sends. */
interface ConverseBody {
  system?: Array<{ text?: string }>;
  messages?: Array<{ role: string; content?: Array<{ text?: string }> }>;
  toolConfig?: { tools?: Array<{ toolSpec?: { name?: string } }> };
}

/** Everything the mock needs from one rendered ITEM block. */
interface ParsedItem {
  fingerprint: string;
  accountable: string | null;
}

/**
 * Pull the measured items back out of the rendered judge prompt.
 *
 * Parses the shape `renderSignal` in `agent/src/llm/prompts/judge.ts` writes.
 * Coupled to that format on purpose: if the prompt changes shape, this stops
 * finding fingerprints and the graph starts discarding findings, which is a
 * loud failure in the E2E run rather than a quiet one in production.
 */
function parseJudgeItems(text: string): ParsedItem[] {
  const items: ParsedItem[] = [];
  for (const block of text.split(/^ITEM \d+$/m).slice(1)) {
    const fingerprint = /^\s*fingerprint:\s*(\S+)\s*$/m.exec(block)?.[1];
    if (!fingerprint) continue;
    const accountable = /^\s*accountable_user_id:\s*(\S+)\s*$/m.exec(block)?.[1] ?? null;
    items.push({
      fingerprint,
      accountable: accountable && accountable !== 'unresolved' ? accountable : null,
    });
  }
  return items;
}

/**
 * A judgment for every item, all worth surfacing.
 *
 * Deliberately not selective. A mock that dropped items would make an E2E
 * assertion about "the agent surfaced the stalled issue" depend on the mock's
 * taste rather than the graph's wiring. Whether a finding is worth surfacing is
 * the model's judgement in production and is tested against a fake judge in
 * `agent/src/llm/judge.test.ts`; here the job is to prove the plumbing carries
 * a finding end to end.
 */
function judgmentPayload(items: ParsedItem[]): unknown {
  return {
    judgments: items.map((item, i) => ({
      fingerprint: item.fingerprint,
      worth_surfacing: true,
      // Varied rather than uniform so an assertion about ordering or severity
      // has something to bite on.
      severity: i === 0 ? 'high' : i === 1 ? 'medium' : 'low',
      recipient: item.accountable,
      phrasing: `MOCK JUDGEMENT from mock-bedrock: item ${i + 1} of ${items.length} crossed its threshold.`,
    })),
  };
}

/**
 * Start the mock on an ephemeral loopback port.
 *
 * Binds 127.0.0.1 deliberately — nothing outside this machine should be able to reach a
 * service that answers every request with a fabricated model response.
 */
export async function startMockBedrock(): Promise<MockBedrock> {
  let invocations = 0;
  let converseInvocations = 0;

  const server: Http2Server = createServer({ allowHTTP1: true }, (req, res) => {
    void (async () => {
      const path = req.url ?? '';

      // The SDK URL-encodes the model id, so match on the operation suffix.
      if (req.method === 'POST' && path.endsWith('/converse')) {
        converseInvocations++;
        let body: ConverseBody;
        try {
          body = JSON.parse(await readBody(req)) as ConverseBody;
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: 'mock-bedrock: converse body was not JSON' }));
          return;
        }

        const userText = (body.messages ?? [])
          .flatMap((m) => m.content ?? [])
          .map((c) => c.text ?? '')
          .join('\n');

        // The tool name is echoed from the request rather than guessed.
        // `withStructuredOutput` picks it, and guessing would make this mock
        // break on a LangChain upgrade for no reason.
        const toolName = body.toolConfig?.tools?.[0]?.toolSpec?.name;

        const payload = toolName
          ? {
              output: {
                message: {
                  role: 'assistant',
                  content: [
                    {
                      toolUse: {
                        toolUseId: `mock-tool-use-${converseInvocations}`,
                        name: toolName,
                        input: judgmentPayload(parseJudgeItems(userText)),
                      },
                    },
                  ],
                },
              },
              stopReason: 'tool_use',
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              metrics: { latencyMs: 0 },
            }
          : {
              // No toolConfig means the grounded-answer path, which asks for
              // prose rather than a schema.
              output: {
                message: {
                  role: 'assistant',
                  content: [
                    {
                      text:
                        'MOCK ANSWER from mock-bedrock. The local stack is wired to a fake ' +
                        'model, so this carries no analysis of the document.',
                    },
                  ],
                },
              },
              stopReason: 'end_turn',
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              metrics: { latencyMs: 0 },
            };

        res.writeHead(200, {
          'content-type': 'application/json',
          'x-amzn-requestid': 'mock-e2e-converse',
        });
        res.end(JSON.stringify(payload));
        return;
      }

      if (req.method !== 'POST' || !path.endsWith('/invoke')) {
        // Loud rather than silent: a 404 surfaces in the API log as a Bedrock error
        // instead of quietly degrading to `ai_unavailable`.
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: `mock-bedrock: unhandled ${req.method} ${path}` }));
        return;
      }

      let parsed: InvokeBody;
      try {
        parsed = JSON.parse(await readBody(req)) as InvokeBody;
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'mock-bedrock: request body was not JSON' }));
        return;
      }

      invocations++;

      const payload = JSON.stringify({
        id: 'msg_mock_e2e',
        type: 'message',
        role: 'assistant',
        model: 'mock-e2e-bedrock',
        stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
        content: [{ type: 'text', text: analysisJson(parsed) }],
      });

      res.writeHead(200, {
        'content-type': 'application/json',
        'x-amzn-requestid': 'mock-e2e-request',
      });
      res.end(payload);
    })();
  });

  // The SDK holds its h2 session open between calls, so `server.close()` alone waits for a
  // connection that never ends and the worker teardown hangs until Playwright's timeout.
  // `closeAllConnections()` is a `http.Server` method and does not exist on `Http2Server`,
  // so track the transport sockets and destroy them directly -- one path that covers both
  // the h2 sessions and any HTTP/1.1 connection `allowHTTP1` admits.
  const sockets = new Set<import('net').Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    invocations: () => invocations,
    converseInvocations: () => converseInvocations,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
