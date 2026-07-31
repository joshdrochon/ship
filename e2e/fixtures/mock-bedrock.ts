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

import { createServer, type Server, type IncomingMessage } from 'http';
import type { AddressInfo } from 'net';

export interface MockBedrock {
  /** Endpoint override to hand the API child process as `BEDROCK_ENDPOINT`. */
  url: string;
  /** Number of InvokeModel calls served — lets a test assert the mock was actually hit. */
  invocations: () => number;
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Start the mock on an ephemeral loopback port.
 *
 * Binds 127.0.0.1 deliberately — nothing outside this machine should be able to reach a
 * service that answers every request with a fabricated model response.
 */
export async function startMockBedrock(): Promise<MockBedrock> {
  let invocations = 0;

  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = req.url ?? '';

      // The SDK URL-encodes the model id, so match on the operation suffix.
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

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    invocations: () => invocations,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // The SDK keeps sockets alive; without this, close() never fires its callback
        // and the worker teardown hangs until Playwright's timeout.
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
