/**
 * PF-742 — what a Slack message says, and what it refuses to go and find out.
 *
 * ── The title rule is not cosmetic ─────────────────────────────────────────
 * L14's decision D7 settled the payload as the resource's PUBLIC API
 * representation, and L15 gates private documents at the matcher. So a payload
 * that reaches this listener either carries a `title` or it does not, and when
 * it does not that is a DELIBERATE omission by the platform, not a gap for the
 * subscriber to fill.
 *
 * The renderer therefore degrades to id-and-link. It never fetches the document
 * to recover a title it was not sent — doing that would use the listener's own
 * token to read around a decision the platform already made, which is the
 * subscriber-side version of the exact leak the gate exists to prevent.
 *
 * ── Message contents are OURS, and marked as such ─────────────────────────
 * The PRD never says what a Slack message should contain. p.8 names the two
 * event types and nothing else. Everything below the first sentence of each
 * message is a judgement call and is documented as one in README.md rather than
 * given a manufactured citation.
 */

/** The two event types p.8 names, and the only two this listener posts. */
export const POSTED_EVENT_TYPES = ['document.created', 'issue.assigned'] as const;
export type PostedEventType = (typeof POSTED_EVENT_TYPES)[number];

export function isPostedEventType(type: unknown): type is PostedEventType {
  return typeof type === 'string' && (POSTED_EVENT_TYPES as readonly string[]).includes(type);
}

export interface EventEnvelopeLike {
  id?: unknown;
  type?: unknown;
  data?: unknown;
}

export interface RenderedMessage {
  text: string;
  /** Present only when the payload carried one. Absent is a real state. */
  title: string | null;
  resourceId: string | null;
  link: string;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * A message, or `null` when the envelope is not one of the two types.
 *
 * `null` rather than a throw: a third event type reaching the listener is not an
 * error, it is a subscription somebody created. The handler answers 200 and
 * posts nothing — a 4xx would dead-letter a delivery the platform was right to
 * send.
 */
export function renderMessage(envelope: EventEnvelopeLike, shipBaseUrl: string): RenderedMessage | null {
  const type = envelope.type;
  if (!isPostedEventType(type)) return null;

  const data = (envelope.data ?? {}) as Record<string, unknown>;
  const resourceId = str(data.id);
  const title = str(data.title);
  const link = resourceId === null ? shipBaseUrl : `${shipBaseUrl}/documents/${resourceId}`;

  const headline =
    type === 'document.created' ? 'New document in Ship' : 'Issue assigned in Ship';

  // Title only when the payload carried one. `${title}` on an absent title would
  // print "null" into a channel, which is worse than the honest degraded form.
  const subject = title !== null ? `*${title}*` : `\`${resourceId ?? 'unknown'}\``;

  return {
    text: `${headline}: ${subject}\n<${link}|Open in Ship>`,
    title,
    resourceId,
    link,
  };
}
