/**
 * `ship docs ls` / `get` / `create` — PF-568 through PF-571.
 *
 * p.6's third line is the headline: `ship docs create --title "hello"`. p.8's
 * integrations menu adds `ls` and `get`. All three go through
 * `client.documents.*`, which is Build Strategy §7's *"write through SDK +
 * public API"* — the write lands on `/api/v1/documents` and shows up in the
 * public audit trail, which is the assertion that actually matters.
 *
 * ── `--json` (PF-571) ───────────────────────────────────────────────────────
 * Exactly one JSON value on stdout, every human word on stderr. `docs ls
 * --json | jq .` parses; so does `get` and `create`. Without `--json` the same
 * data is a human table and stdout still carries only results.
 *
 * ── No cursor, in either direction (PF-569) ─────────────────────────────────
 * There is no `--cursor` flag and no cursor in any output mode. p.4:
 * *"Cursors handled internally; consumer code never sees them."* `--all` drains
 * `iterate()`, which is the SDK's generator; `--limit` takes one page through
 * `list()`, which is the only reason PF-536 exposed `list()` at all.
 */
import type { ShipDocument } from '@ship/sdk';
import { EXIT_CODES, type ExitCode } from '../exitCodes.js';
import { reportFailure } from '../errors.js';
import { buildClient, type CommandContext } from '../context.js';

/** L08's PF-225 default page size, restated as the CLI's default `--limit`. */
export const DEFAULT_LIMIT = 25;

/**
 * The fields `get` and `ls` print.
 *
 * `content` is deliberately absent (PF-570): the event payloads do not carry it
 * (L14's PF-408), so a CLI that printed it would show a developer something the
 * webhook they are about to subscribe to will never contain.
 */
export const PRINTED_DOCUMENT_FIELDS = [
  'id',
  'document_type',
  'title',
  'parent_id',
  'created_at',
  'updated_at',
  'created_by',
] as const;

function projectDocument(document: ShipDocument): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of PRINTED_DOCUMENT_FIELDS) out[field] = document[field];
  return out;
}

/** Fixed-width columns, truncated rather than wrapped — a wrapped table is unreadable. */
function pad(value: string, width: number): string {
  return value.length > width ? `${value.slice(0, width - 1)}…` : value.padEnd(width);
}

function renderTable(documents: ShipDocument[]): string[] {
  const lines = [
    `${pad('ID', 38)}${pad('TYPE', 14)}TITLE`,
    `${'─'.repeat(38)}${'─'.repeat(14)}${'─'.repeat(26)}`,
  ];
  for (const document of documents) {
    lines.push(`${pad(document.id, 38)}${pad(document.document_type, 14)}${document.title}`);
  }
  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// ls
// ─────────────────────────────────────────────────────────────────────────────

export interface DocsLsOptions {
  /** Page size. Defaults to `DEFAULT_LIMIT`. */
  limit?: number | undefined;
  /** Drain the iterator instead of taking one page. */
  all?: boolean | undefined;
}

export async function runDocsLs(
  context: CommandContext,
  options: DocsLsOptions = {},
): Promise<ExitCode> {
  const { client } = buildClient(context);
  const limit = options.limit ?? DEFAULT_LIMIT;

  try {
    const documents: ShipDocument[] = [];
    if (options.all === true) {
      // The cursor is the SDK's business. This loop never sees one.
      for await (const document of client.documents.iterate({ limit })) {
        documents.push(document);
      }
    } else {
      const page = await client.documents.list({ limit });
      documents.push(...page.data);
    }

    if (context.json) {
      // ONE value. An array, not newline-delimited objects — `jq .` on a stream
      // of top-level objects works by accident and `jq 'length'` does not.
      context.sink.out(JSON.stringify(documents.map(projectDocument)));
    } else {
      for (const line of renderTable(documents)) context.sink.out(line);
      context.sink.err(
        `ship: ${documents.length} document(s)` +
          (options.all === true ? ' (all pages)' : ` (first page, --limit ${limit})`),
      );
    }
    return EXIT_CODES.success;
  } catch (error) {
    return reportFailure(error, context.sink, { nowMs: context.clock.now() });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// get
// ─────────────────────────────────────────────────────────────────────────────

export async function runDocsGet(context: CommandContext, id: string): Promise<ExitCode> {
  if (id.trim() === '') {
    context.sink.err('ship: docs get needs a document id.');
    context.sink.err('Usage: ship docs get <id>');
    return EXIT_CODES.usage;
  }

  const { client } = buildClient(context);
  try {
    const document = await client.documents.get(id);
    if (context.json) {
      context.sink.out(JSON.stringify(projectDocument(document)));
    } else {
      for (const field of PRINTED_DOCUMENT_FIELDS) {
        context.sink.out(`${field.padEnd(16)}${String(document[field] ?? '')}`);
      }
    }
    return EXIT_CODES.success;
  } catch (error) {
    // PF-570 — the id is echoed back on `not_found`. A malformed id renders as
    // `validation` and not as `server`, which is L17's PF-501 fallback table
    // doing its job through a reverse proxy; the CLI is where a user sees
    // whether it did.
    return reportFailure(error, context.sink, {
      subject: id,
      nowMs: context.clock.now(),
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// create — p.6's third line, exactly as written there
// ─────────────────────────────────────────────────────────────────────────────

export interface DocsCreateOptions {
  title?: string | undefined;
}

export async function runDocsCreate(
  context: CommandContext,
  options: DocsCreateOptions,
): Promise<ExitCode> {
  const title = options.title;
  if (title === undefined || title.trim() === '') {
    // PF-568: absence of `--title` is a usage error with the correct invocation
    // shown. NEVER an `Untitled` document — a CLI that silently creates the
    // wrong thing is worse than one that refuses.
    context.sink.err('ship: docs create needs a title.');
    context.sink.err('Usage: ship docs create --title "hello"');
    return EXIT_CODES.usage;
  }

  const { client } = buildClient(context);
  try {
    const document = await client.documents.create({ title });
    if (context.json) {
      context.sink.out(JSON.stringify(projectDocument(document)));
    } else {
      // The id on stdout and nothing else, so `ID=$(ship docs create --title x)`
      // does the obvious thing.
      context.sink.out(document.id);
      context.sink.err(`ship: created ${document.document_type} "${document.title}"`);
    }
    return EXIT_CODES.success;
  } catch (error) {
    // A token without `documents:write` lands on the `auth` / `forbidden` path,
    // where the renderer names the missing scope (p.2's gate item 6) rather than
    // reporting an opaque failure.
    return reportFailure(error, context.sink, { nowMs: context.clock.now() });
  }
}
