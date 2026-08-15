/**
 * PF-671 / PF-672 / PF-673 — the subscription surface, driven through the DOM.
 *
 * `@/lib/portalClient` is faked at the module boundary so the `ShipClient` under
 * test is one this file controls. That is deliberate and it is not a shortcut:
 * every assertion below is about **which SDK method the UI calls and what it
 * renders from the answer**, and a real client would be testing L15's route and
 * L17's transport, both of which have their own suites. What cannot be faked
 * away is the shape — the fake returns the SDK's real `Page<WebhookSubscription>`
 * and the real `WebhookSubscriptionWithSecret`, so a field the UI reads that the
 * contract does not carry is a `pnpm type-check` failure at the keyboard.
 *
 * `fireEvent` rather than `user-event`: this workspace does not ship
 * `@testing-library/user-event`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type {
  Page,
  WebhookSubscription,
  WebhookSubscriptionWithSecret,
} from '@ship/sdk';
import { ShipError } from '@ship/sdk';

const list = vi.fn();
const create = vi.fn();
const update = vi.fn();
const remove = vi.fn();
const invalidatePortalClient = vi.fn();

/**
 * One fake client, shaped like the real one's `webhooks` resource.
 *
 * `getPortalClient` returning the SAME object each call is what lets the
 * auth-retry test below count calls: the retry has to be visible as a second
 * `list()` on a client obtained after `invalidatePortalClient`, not as a new
 * object nobody can see.
 */
const fakeClient = {
  webhooks: {
    list: (...a: unknown[]) => list(...a),
    create: (...a: unknown[]) => create(...a),
    update: (...a: unknown[]) => update(...a),
    delete: (...a: unknown[]) => remove(...a),
  },
};

vi.mock('@/lib/portalClient', () => ({
  getPortalClient: async () => fakeClient,
  invalidatePortalClient: (...a: unknown[]) => invalidatePortalClient(...a),
  PortalTokenError: class PortalTokenError extends Error {
    constructor(
      message: string,
      readonly status: number
    ) {
      super(message);
    }
  },
}));

const { SubscriptionsPanel } = await import('./SubscriptionsPanel');

const APP_ID = '11111111-1111-4111-8111-111111111111';

function subscription(over: Partial<WebhookSubscription> = {}): WebhookSubscription {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    event: 'issue.created',
    target_url: 'https://subscriber.example/hooks/ship',
    active: true,
    secret_prefix: 'whsec_1a',
    secret_version: 1,
    created_at: '2026-08-15T10:00:00.000Z',
    updated_at: '2026-08-15T10:00:00.000Z',
    deactivated_at: null,
    ...over,
  };
}

function page(data: WebhookSubscription[], nextCursor: string | null = null): Page<WebhookSubscription> {
  return { data, next_cursor: nextCursor };
}

function renderPanel(onShowDeliveries = vi.fn()) {
  render(
    <SubscriptionsPanel appId={APP_ID} appName="Deployment Bot" onShowDeliveries={onShowDeliveries} />
  );
  return { onShowDeliveries };
}

beforeEach(() => {
  list.mockReset();
  create.mockReset();
  update.mockReset();
  remove.mockReset();
  invalidatePortalClient.mockReset();
  list.mockResolvedValue(page([subscription()]));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PF-671 — the list is `client.webhooks.list`, cursor-paginated', () => {
  it('renders target URL, event, `secret_prefix` and state from the SDK response', async () => {
    renderPanel();

    await screen.findByText('https://subscriber.example/hooks/ship');
    expect(screen.getByText('issue.created')).toBeInTheDocument();
    // PF-423 — the clear-text identifier says WHICH secret without being one.
    expect(document.body.textContent).toContain('whsec_1a');
    expect(screen.getByTestId('subscription-state-22222222-2222-4222-8222-222222222222'))
      .toHaveTextContent('active');
  });

  it('asks for one page and never for an offset', async () => {
    renderPanel();
    await waitFor(() => expect(list).toHaveBeenCalled());

    const options = list.mock.calls[0][0] as Record<string, unknown>;
    expect(options).toEqual({ limit: 25 });
    // No `offset`, no page number, and no `cursor: null` — `ListOptions` has no
    // slot for the first two and the strict allowlist (PF-226) has none for a
    // null third.
    expect(Object.keys(options)).not.toContain('offset');
    expect(Object.keys(options)).not.toContain('cursor');
  });

  it('a null `next_cursor` disables Next; a cursor enables it and is sent back verbatim', async () => {
    list.mockResolvedValueOnce(page([subscription()], 'opaque-cursor-1'));
    renderPanel();

    const nextButton = await screen.findByTestId('subscriptions-next');
    await waitFor(() => expect(nextButton).toBeEnabled());

    list.mockResolvedValueOnce(page([subscription({ id: '33333333-3333-4333-8333-333333333333' })]));
    fireEvent.click(nextButton);

    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(list.mock.calls[1][0]).toEqual({ limit: 25, cursor: 'opaque-cursor-1' });
    // PF-224 — the end of the collection is a disabled control, not a click that
    // returns an empty page.
    await waitFor(() => expect(screen.getByTestId('subscriptions-next')).toBeDisabled());
  });

  it('`active: false` renders as a distinct STATE, not as absence', async () => {
    list.mockResolvedValue(
      page([
        subscription({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', active: false }),
        subscription({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', active: true }),
      ])
    );
    renderPanel();

    // PF-426 makes deactivation a matcher input rather than a delete. Hiding the
    // row would make a deactivated subscription look destroyed.
    expect(await screen.findByTestId('subscription-state-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))
      .toHaveTextContent('inactive');
    expect(screen.getByTestId('subscription-state-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'))
      .toHaveTextContent('active');
  });

  it('an empty list is an explanatory state, not a blank pane (PF-660)', async () => {
    list.mockResolvedValue(page([]));
    renderPanel();

    const empty = await screen.findByTestId('subscriptions-empty');
    // It names what would produce a row, which is also the reason the delivery
    // log next door is empty.
    expect(empty.textContent).toMatch(/binds one event type to one target URL/i);
  });
});

describe('PF-660 — the error and 429 states are rendered, and the 429 disables the control', () => {
  it('a ShipError renders its message and `request_id`', async () => {
    list.mockRejectedValue(
      new ShipError({
        kind: 'server',
        status: 500,
        code: 'server_error',
        message: 'Something failed upstream.',
        requestId: 'req_abc123',
      })
    );
    renderPanel();

    expect(await screen.findByText('Something failed upstream.')).toBeInTheDocument();
    // PF-502 — quotable in a bug report rather than described as "it broke".
    expect(document.body.textContent).toContain('req_abc123');
    expect(screen.getByTestId('subscription-retry')).toBeEnabled();
  });

  it('a 429 shows the wait from `Retry-After` and disables Retry until it elapses', async () => {
    list.mockRejectedValue(
      new ShipError({
        kind: 'rate_limit',
        status: 429,
        code: 'rate_limited',
        message: 'Too many requests.',
        requestId: 'req_limited',
        retryAfterSeconds: 12,
      })
    );
    renderPanel();

    await screen.findByText('Too many requests.');
    expect(document.body.textContent).toMatch(/Try again in 12s/);
    // The portal spends the same per-app bucket the developer's own integration
    // spends (PF-304). Letting them hammer it is worse than saying the number.
    expect(screen.getByTestId('subscription-retry')).toBeDisabled();
  });

  it('an expired portal token re-mints ONCE, silently, and the user sees data', async () => {
    list
      .mockRejectedValueOnce(
        new ShipError({ kind: 'auth', status: 401, code: 'unauthorized', message: 'Token expired.' })
      )
      .mockResolvedValueOnce(page([subscription()]));

    renderPanel();

    await screen.findByText('https://subscriber.example/hooks/ship');
    expect(invalidatePortalClient).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(2);
    // The banner is what a user should never see for the expected case of a
    // 15-minute token outliving nothing.
    expect(screen.queryByText('Token expired.')).not.toBeInTheDocument();
  });

  it('a SECOND auth failure surfaces rather than retrying forever', async () => {
    list.mockRejectedValue(
      new ShipError({ kind: 'auth', status: 401, code: 'unauthorized', message: 'Token expired.' })
    );
    renderPanel();

    expect(await screen.findByText('Token expired.')).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
  });
});

describe('PF-672 — create a subscription', () => {
  it('the event field is a select over the registry, and there is no free-text way in', async () => {
    renderPanel();
    fireEvent.click(await screen.findByTestId('create-subscription-open'));

    const select = screen.getByTestId('subscription-event') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    // Eight registered types (PF-391), asserted against the SDK's own array in
    // `sdk`'s parity test — so an unregistered type is unreachable from the UI.
    expect(select.options.length).toBe(8);
    expect([...select.options].map((o) => o.value)).toContain('sprint.completed');
  });

  it('sends exactly `{event, target_url}` and shows the signing secret ONCE', async () => {
    const created: WebhookSubscriptionWithSecret = {
      ...subscription({ id: '44444444-4444-4444-8444-444444444444', event: 'sprint.completed' }),
      signing_secret: 'whsec_live_9f3a7c1b5e2d8a460f11c37b9d4e5a28',
    };
    create.mockResolvedValue(created);

    renderPanel();
    fireEvent.click(await screen.findByTestId('create-subscription-open'));
    fireEvent.change(screen.getByTestId('subscription-event'), {
      target: { value: 'sprint.completed' },
    });
    fireEvent.change(screen.getByTestId('subscription-target-url'), {
      target: { value: 'https://new-subscriber.example/hook' },
    });
    fireEvent.click(screen.getByTestId('create-subscription-submit'));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).toEqual({
      event: 'sprint.completed',
      target_url: 'https://new-subscriber.example/hook',
    });

    // PF-666's component, unchanged: the secret is ABSENT from the document
    // until Reveal — not `display:none`, absent.
    const dialog = await screen.findByTestId('secret-once-dialog');
    expect(dialog).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(created.signing_secret);

    fireEvent.click(screen.getByTestId('secret-once-reveal'));
    expect(screen.getByTestId('secret-once-value')).toHaveTextContent(created.signing_secret);

    fireEvent.click(screen.getByTestId('secret-once-reveal'));
    expect(document.body.textContent).not.toContain(created.signing_secret);
  });

  it('labels the value `signing_secret`, and says nothing was replaced', async () => {
    create.mockResolvedValue({
      ...subscription(),
      signing_secret: 'whsec_live_0000',
    } satisfies WebhookSubscriptionWithSecret);

    renderPanel();
    fireEvent.click(await screen.findByTestId('create-subscription-open'));
    fireEvent.change(screen.getByTestId('subscription-target-url'), {
      target: { value: 'https://new-subscriber.example/hook' },
    });
    fireEvent.click(screen.getByTestId('create-subscription-submit'));

    await screen.findByTestId('secret-once-dialog');
    expect(document.body.textContent).toContain('signing_secret');
    // A first issue has no previous secret, so the dialog must not claim one
    // just stopped working — see `SecretIssueContext`.
    const notice = screen.getByTestId('rotation-policy-notice');
    expect(notice.textContent).not.toMatch(/stopped working immediately/i);
    expect(notice.textContent).toMatch(/Nothing was replaced/i);
  });

  it("a server `target_url` rejection renders under the field, and the form's values survive", async () => {
    create.mockRejectedValue(
      new ShipError({
        kind: 'validation',
        status: 422,
        code: 'validation_failed',
        message: 'The request is not valid.',
        requestId: 'req_v1',
        details: {
          fields: [{ field: 'target_url', message: 'Must be an absolute https URL.' }],
        },
      })
    );

    renderPanel();
    fireEvent.click(await screen.findByTestId('create-subscription-open'));
    fireEvent.change(screen.getByTestId('subscription-target-url'), {
      target: { value: 'http://insecure.example/hook' },
    });
    fireEvent.click(screen.getByTestId('create-subscription-submit'));

    // Rendered where the developer is looking, from the SERVER's answer — this
    // form re-implements none of PF-425's rules, which is why the loopback
    // exception cannot drift out of it.
    expect(await screen.findByTestId('field-error-target-url')).toHaveTextContent(
      'Must be an absolute https URL.'
    );
    expect(screen.getByTestId('create-subscription-dialog')).toBeInTheDocument();
    expect((screen.getByTestId('subscription-target-url') as HTMLInputElement).value).toBe(
      'http://insecure.example/hook'
    );
    expect(document.body.textContent).toContain('req_v1');
  });
});

describe('PF-673 — deactivation is reversible and nothing on this screen destroys anything', () => {
  it('Deactivate calls `PATCH {active:false}` and the row comes back inactive', async () => {
    const active = subscription({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', active: true });
    list.mockResolvedValueOnce(page([active]));
    update.mockResolvedValue({ ...active, active: false });
    list.mockResolvedValue(page([{ ...active, active: false }]));

    renderPanel();
    fireEvent.click(await screen.findByTestId('subscription-toggle-cccccccc-cccc-4ccc-8ccc-cccccccccccc'));

    await waitFor(() => expect(update).toHaveBeenCalledWith(active.id, { active: false }));
    // Re-read, not patched in place: `active` is a dispatcher matcher input
    // (PF-426), so showing the optimistic value would show the opposite of what
    // the integration is doing if the write failed.
    await waitFor(() =>
      expect(screen.getByTestId(`subscription-state-${active.id}`)).toHaveTextContent('inactive')
    );
  });

  it('an inactive row offers Reactivate, and it goes the other way', async () => {
    const inactive = subscription({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', active: false });
    list.mockResolvedValue(page([inactive]));
    update.mockResolvedValue({ ...inactive, active: true });

    renderPanel();
    const toggle = await screen.findByTestId(`subscription-toggle-${inactive.id}`);
    expect(toggle).toHaveTextContent('Reactivate');

    fireEvent.click(toggle);
    await waitFor(() => expect(update).toHaveBeenCalledWith(inactive.id, { active: true }));
  });

  it('states that the history is kept, and offers no destructive control', async () => {
    renderPanel();

    const note = await screen.findByTestId('subscription-lifecycle-note');
    expect(note.textContent).toMatch(/reversible/i);
    expect(note.textContent).toMatch(/retained/i);
    // The measured correction to PF-673: `DELETE /api/v1/webhooks/:id` is
    // declared *"Deactivate a subscription. Idempotent; the row is retained"*.
    // There is no cascade and no erasure, so a "Delete" button promising one
    // would be the UI lying about the API.
    expect(screen.queryByText(/^Delete$/)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/permanently/i);
  });

  it('a failed toggle is reported and does not silently leave the row wrong', async () => {
    const active = subscription({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' });
    list.mockResolvedValue(page([active]));
    update.mockRejectedValue(
      new ShipError({
        kind: 'auth',
        status: 403,
        code: 'forbidden',
        message: 'This token is missing webhooks:manage.',
      })
    );

    renderPanel();
    fireEvent.click(await screen.findByTestId(`subscription-toggle-${active.id}`));

    expect(await screen.findByTestId('subscription-action-error')).toHaveTextContent(
      'This token is missing webhooks:manage.'
    );
    expect(screen.getByTestId(`subscription-state-${active.id}`)).toHaveTextContent('active');
  });

  it('Deliveries hands the subscription id to the delivery log rather than making the user copy it', async () => {
    const { onShowDeliveries } = renderPanel();
    fireEvent.click(
      await screen.findByTestId('subscription-deliveries-22222222-2222-4222-8222-222222222222')
    );
    expect(onShowDeliveries).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222');
  });
});
