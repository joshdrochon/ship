/**
 * Compile-time proofs for three contracts a runtime test cannot express.
 *
 *   PF-525  the signing secret is readable off `create()`/`rotate()` and is a
 *           TYPE ERROR everywhere else
 *   PF-534  `iterate()` admits no cursor, and the yielded item carries none
 *   PF-521  each resource client is its own type, not a slice of one god object
 *
 * Everything here is checked by `pnpm type-check` (`tsconfig.typeproofs.json`)
 * and emitted into no `dist`.
 */
import { ShipClient } from '../src/index.js';
import type { ShipDocument, DocumentsClient } from '../src/resources/documents.js';
import type { WebhookSubscription } from '../src/resources/webhookSubscriptions.js';

declare const token: string;
const client = new ShipClient({ token });

// ── PF-525 · the secret is returned ONCE, and the type says so ──────────────

export async function secretIsReadableOnCreate(): Promise<string> {
  const sub = await client.webhooks.create({
    event: 'document.created',
    target_url: 'https://listener.example.test/hook',
  });
  // p.7's drill reads exactly this off exactly this response.
  return sub.signing_secret;
}

export async function secretIsReadableOnRotate(): Promise<string> {
  const rotated = await client.webhooks.rotate('00000000-0000-4000-8000-000000000000');
  return rotated.signing_secret;
}

export async function secretIsNotOnAListedSubscription(): Promise<void> {
  const page = await client.webhooks.list();
  const first = page.data[0] as WebhookSubscription;

  // @ts-expect-error — PF-525. A listed subscription has NO `signing_secret`.
  // With one optional field instead of two types this line would compile and
  // hand `undefined` to `verifyWebhook`, which fails at 3am against a live
  // subscriber rather than here.
  void first.signing_secret;
}

export async function secretIsNotOnAFetchedSubscription(): Promise<void> {
  const sub = await client.webhooks.get('00000000-0000-4000-8000-000000000000');
  // @ts-expect-error — same contract through `get()`.
  void sub.signing_secret;
}

export async function secretIsNotOnAnUpdatedSubscription(): Promise<void> {
  const sub = await client.webhooks.update('00000000-0000-4000-8000-000000000000', {
    active: false,
  });
  // @ts-expect-error — and through `update()`.
  void sub.signing_secret;
}

// ── PF-534 · consumers never see a cursor ───────────────────────────────────

export async function iterateTakesNoCursor(): Promise<number> {
  let seen = 0;
  // A page size is legal — it is not a position.
  for await (const _doc of client.documents.iterate({ limit: 50 })) seen += 1;
  return seen;
}

export function iterateRejectsACursor(): void {
  // @ts-expect-error — p.4: *"Cursors handled internally; consumer code never
  // sees them."* Expressed on the TYPE, so passing one does not compile rather
  // than being silently ignored.
  void client.documents.iterate({ cursor: 'eyJ0IjoiMjAyNC0wNS0xNyJ9' });
}

export function everyIterateRejectsACursor(): void {
  // @ts-expect-error — issues.
  void client.issues.iterate({ cursor: 'x' });
  // @ts-expect-error — sprints.
  void client.sprints.iterate({ cursor: 'x' });
  // @ts-expect-error — webhooks.
  void client.webhooks.iterate({ cursor: 'x' });
}

export async function theYieldedItemCarriesNoCursor(): Promise<void> {
  for await (const doc of client.documents.iterate()) {
    const typed: ShipDocument = doc;
    void typed.id;
    // @ts-expect-error — the item is the resource, not a paging envelope.
    void doc.next_cursor;
    // @ts-expect-error — and it carries no cursor of its own.
    void doc.cursor;
    break;
  }
}

export async function listStillReturnsTheRawPage(): Promise<string | null | undefined> {
  // PF-536's other half: `list()` exposes the page, cursor and all, because the
  // portal and the CLI's `--limit` need one page without draining a collection.
  const page = await client.documents.list({ limit: 10 });
  return page.next_cursor;
}

// ── PF-521 · four segregated clients ────────────────────────────────────────

export function resourcesAreSegregated(): void {
  // A documents-only consumer sees documents and nothing else.
  // @ts-expect-error — there is no issue verb on the documents client.
  void client.documents.update;
  // @ts-expect-error — and no webhook verb.
  void client.documents.rotate;
  // @ts-expect-error — the sprints client has no `create` for issues' input.
  void client.sprints.create({ title: 'not a sprint' });
}

export function readonlyResourcesDoNotReassign(replacement: DocumentsClient): void {
  // @ts-expect-error — p.7 writes `readonly documents: DocumentsClient`.
  // `defineReadonly` makes it non-writable at RUNTIME too; this is the
  // compile-time half. (A distinct value rather than `client.documents` itself,
  // which `no-self-assign` rejects before the type checker is consulted.)
  client.documents = replacement;
}
