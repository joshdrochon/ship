/**
 * FleetGraph OpenAPI registration — the six agent endpoints plus /ready.
 *
 * Registering is a project rule, not documentation polish: Swagger and the MCP
 * tool surface are both generated from this registry, so an unregistered route
 * is a route Claude cannot call.
 *
 * The request schemas are IMPORTED from `routes/fleetgraph/schemas.ts` rather
 * than restated here. Every other module in this directory restates them, and
 * that is how a published contract drifts from an enforced one — the drift is
 * invisible until a client believes the docs. Importing means the `.strict()`
 * chat body that enforces PRESEARCH.md Q7's privacy boundary is the same object
 * that gets published.
 */
import { z, registry } from '../registry.js';
import {
  chatBodySchema,
  emptyBodySchema,
  snoozeBodySchema,
} from '../../routes/fleetgraph/schemas.js';

// ============== Responses ==============

const NotificationSchema = z
  .object({
    id: z.string().uuid(),
    observationId: z.string().uuid(),
    title: z.string(),
    body: z.string().nullable(),
    targetId: z.string().uuid().nullable(),
    targetTitle: z.string().nullable(),
    targetType: z.string().nullable(),
    signalType: z.string(),
    fingerprint: z.string(),
    pendingThreadId: z
      .string()
      .nullable()
      .describe('LangGraph thread id of a run suspended at interrupt(). Null if none.'),
    requiresApproval: z
      .boolean()
      .describe('True when the finding is gated on a human answer — render Accept/Dismiss/Snooze.'),
    createdAt: z.string().datetime(),
  })
  .openapi('FleetGraphNotification');

registry.register('FleetGraphNotification', NotificationSchema);

const NotificationListSchema = z
  .object({ notifications: z.array(NotificationSchema) })
  .openapi('FleetGraphNotificationList');

registry.register('FleetGraphNotificationList', NotificationListSchema);

const AcknowledgeResultSchema = z
  .object({
    id: z.string().uuid(),
    state: z.literal('acknowledged'),
  })
  .openapi('FleetGraphAcknowledgeResult');

registry.register('FleetGraphAcknowledgeResult', AcknowledgeResultSchema);

const ApprovalResultSchema = z
  .object({
    id: z.string().uuid().describe('The notification acted on.'),
    observationId: z.string().uuid(),
    resolution: z.enum(['accepted', 'dismissed', 'snoozed']),
    snoozeUntil: z
      .string()
      .datetime()
      .nullable()
      .describe('Wake time for a snooze, 00:00 UTC on the Nth business day. Null otherwise.'),
    threadId: z.string().nullable().describe('Suspended LangGraph thread the decision resumes.'),
    resumed: z
      .boolean()
      .describe('Whether the graph has already consumed the decision. False while it is queued.'),
  })
  .openapi('FleetGraphApprovalResult');

registry.register('FleetGraphApprovalResult', ApprovalResultSchema);

const ChatResultSchema = z
  .object({
    answer: z.string(),
    threadId: z.string().nullable().describe('Continue this thread for a follow-up turn.'),
    documentId: z.string().uuid(),
  })
  .openapi('FleetGraphChatResult');

registry.register('FleetGraphChatResult', ChatResultSchema);

const DependencyCheckSchema = z
  .object({
    status: z.enum(['ok', 'degraded', 'error']),
  })
  .passthrough()
  .openapi('DependencyCheck');

const ReadinessSchema = z
  .object({
    status: z.enum(['ready', 'not_ready']),
    revision: z.string(),
    checks: z.object({
      postgres: DependencyCheckSchema,
      bedrock: DependencyCheckSchema,
    }),
  })
  .openapi('Readiness');

registry.register('Readiness', ReadinessSchema);

const IdParam = z.object({
  id: z.string().uuid().openapi({ description: 'Notification id, as returned by GET /fleetgraph/notifications.' }),
});

// ============== Endpoints ==============

registry.registerPath({
  method: 'get',
  path: '/fleetgraph/notifications',
  tags: ['FleetGraph'],
  summary: "The current user's open agent findings",
  description:
    'Pending FleetGraph notifications for the authenticated user, newest first. ' +
    'Filtered by document visibility: a finding about a document the caller cannot ' +
    'read is never returned, because its title and body quote that document.',
  responses: {
    200: {
      description: 'Open notifications',
      content: { 'application/json': { schema: NotificationListSchema } },
    },
    401: { description: 'Not authenticated' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/fleetgraph/notifications/{id}/acknowledge',
  tags: ['FleetGraph'],
  summary: 'Mark a notification seen',
  description:
    'Marks the notification acknowledged without judging the finding — the underlying ' +
    'observation stays open. Idempotent. Use the approvals endpoints to accept, dismiss ' +
    'or snooze the finding itself.',
  request: {
    params: IdParam,
    body: { content: { 'application/json': { schema: emptyBodySchema } }, required: false },
  },
  responses: {
    200: {
      description: 'Acknowledged',
      content: { 'application/json': { schema: AcknowledgeResultSchema } },
    },
    401: { description: 'Not authenticated' },
    404: {
      description:
        'No such notification for this user. Also returned when the caller is not the ' +
        'recipient, or cannot read the target document — deliberately indistinguishable.',
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/fleetgraph/approvals/{id}/accept',
  tags: ['FleetGraph'],
  summary: 'Accept the proposed action',
  description:
    'Records approval and resumes the suspended LangGraph run, which executes the proposal ' +
    'through Ship\'s own API. The observation is resolved as accepted.',
  request: {
    params: IdParam,
    body: { content: { 'application/json': { schema: emptyBodySchema } }, required: false },
  },
  responses: {
    200: {
      description: 'Decision recorded',
      content: { 'application/json': { schema: ApprovalResultSchema } },
    },
    401: { description: 'Not authenticated' },
    404: { description: 'No such notification for this user' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/fleetgraph/approvals/{id}/dismiss',
  tags: ['FleetGraph'],
  summary: 'Dismiss the finding — permanently, for this fingerprint',
  description:
    'The agent was wrong, or the human has context it lacks. The observation is resolved as ' +
    'dismissed and that fingerprint NEVER fires again for that target. Not a TTL, not a mute: ' +
    'a dismissed finding that returns next week is the fastest route to the agent being ' +
    'switched off. A worse threshold bucket for the same issue is a different fingerprint and ' +
    'may still surface once.',
  request: {
    params: IdParam,
    body: { content: { 'application/json': { schema: emptyBodySchema } }, required: false },
  },
  responses: {
    200: {
      description: 'Decision recorded',
      content: { 'application/json': { schema: ApprovalResultSchema } },
    },
    401: { description: 'Not authenticated' },
    404: { description: 'No such notification for this user' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/fleetgraph/approvals/{id}/snooze',
  tags: ['FleetGraph'],
  summary: 'Defer the finding for N business days',
  description:
    'Suppresses the finding until 00:00 UTC on the Nth business day, then RE-RUNS the ' +
    'detector rather than replaying the stored finding — so a condition that resolved itself ' +
    'in the meantime never comes back. Horizons are business days (1, 3 or 5, default 3), ' +
    'matching the unit every detector threshold is measured in.',
  request: {
    params: IdParam,
    body: { content: { 'application/json': { schema: snoozeBodySchema } }, required: false },
  },
  responses: {
    200: {
      description: 'Decision recorded, with the computed wake time',
      content: { 'application/json': { schema: ApprovalResultSchema } },
    },
    400: { description: 'days was not one of 1, 3, 5, or an unrecognised field was sent' },
    401: { description: 'Not authenticated' },
    404: { description: 'No such notification for this user' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/fleetgraph/chat',
  tags: ['FleetGraph'],
  summary: 'Ask the agent about the document in view',
  description:
    'On-demand, read-only invocation of the same graph the proactive cron runs.\n\n' +
    'The body carries ROUTE PARAMETERS ONLY — document id, document type, active tab — and ' +
    'never rendered content. This is a privacy boundary, not a convention: an id is re-read ' +
    'server-side under the caller\'s own visibility rules, whereas rendered HTML cannot be ' +
    'checked at all and would ship whatever the browser happened to have on screen to the ' +
    'model. The schema is strict, so sending `content`, `html` or a DOM snapshot is a 400.\n\n' +
    'Rate limited to 120 requests per hour per user, sharing a bucket with /ai/analyze-*.',
  request: {
    body: { content: { 'application/json': { schema: chatBodySchema } }, required: true },
  },
  responses: {
    200: {
      description: 'Grounded answer',
      content: { 'application/json': { schema: ChatResultSchema } },
    },
    400: { description: 'Invalid body, including any unrecognised field' },
    401: { description: 'Not authenticated' },
    404: { description: 'Document not found, or not readable by this user' },
    429: { description: 'Rate limit exceeded (120/hour/user)' },
    503: {
      description:
        'The agent is unavailable — {"error":"ai_unavailable"}. Render the chat as ' +
        'unavailable; nothing else in Ship is affected.',
    },
  },
});

/**
 * `/ready` is served at the ORIGIN ROOT, not under `/api` — a load-balancer
 * probe should not have to know the API's mount path, and `/health` set that
 * precedent. The document's default server is `/api`, so this path carries its
 * own server override; without it the published URL would be `/api/ready`,
 * which 404s.
 */
registry.registerPath({
  method: 'get',
  path: '/ready',
  tags: ['FleetGraph'],
  servers: [{ url: '/', description: 'Origin root — /ready is not under /api' }],
  security: [],
  summary: 'Readiness probe — can this process serve a request',
  description:
    'Distinct from /health, which reports liveness and the build revision without touching ' +
    'any dependency. /ready reaches Postgres (2s timeout) and reports the Bedrock circuit ' +
    'breaker.\n\n' +
    '503 when Postgres is unreachable — every route needs it. An open Bedrock breaker is ' +
    'reported as `degraded` but still returns 200: AI is one advisory feature with a designed ' +
    'fallback, and failing readiness on it would turn a degraded feature into a full outage. ' +
    'Unauthenticated, like /health.',
  responses: {
    200: {
      description: 'Ready. Bedrock may still report degraded.',
      content: { 'application/json': { schema: ReadinessSchema } },
    },
    503: {
      description: 'Not ready — a hard dependency is unreachable',
      content: { 'application/json': { schema: ReadinessSchema } },
    },
  },
});
