/**
 * PF-666 / PF-668 / PF-670 — the shown-once secret and the rotate confirmation,
 * driven through the rendered DOM.
 *
 * Every assertion here is about what a screenshot would capture, what the
 * clipboard receives and what a Back navigation can recover — the three vectors
 * Pre-Search 1.4 (p.15) names. None of them is checkable by reading the
 * component; the masked state has to be asserted as an ABSENCE from the
 * document, because `display:none` and a CSS blur both look identical to a
 * reader and neither of them is safe.
 *
 * `fireEvent` rather than `user-event`: this workspace does not ship
 * `@testing-library/user-event`, and adding a dependency to write a test is a
 * worse trade than driving the DOM directly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react';
import { SecretOnceDialog, AUTO_REMASK_MS } from './SecretOnceDialog';
import { RotateSecretDialog } from './RotateSecretDialog';

/** A value shaped like the real thing, so a substring match cannot pass by luck. */
const SECRET = 'ship_secret_4f9c2a71e0b84d3c9a6f1e5d8c7b2a94';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function renderSecret(overrides: Partial<Parameters<typeof SecretOnceDialog>[0]> = {}) {
  const onDismiss = vi.fn();
  render(
    <SecretOnceDialog
      title="App registered"
      appName="Deployment Bot"
      clientId="ship_app_abc123"
      secret={SECRET}
      rotationPolicy="instant"
      onDismiss={onDismiss}
      {...overrides}
    />
  );
  return { onDismiss };
}

describe('PF-666 — the secret is masked by default and revealed deliberately', () => {
  it('the secret string is ABSENT from the document before Reveal', () => {
    renderSecret();
    // Not "hidden": absent. `display:none` still ships the characters to dev
    // tools, to an accessibility-tree dump and to a screen reader.
    expect(document.body.textContent).not.toContain(SECRET);
    expect(screen.getByTestId('secret-once-masked')).toBeInTheDocument();
    expect(screen.queryByTestId('secret-once-value')).not.toBeInTheDocument();
  });

  it('Reveal puts it in the document, and Hide takes it back out', () => {
    renderSecret();
    fireEvent.click(screen.getByTestId('secret-once-reveal'));
    expect(screen.getByTestId('secret-once-value')).toHaveTextContent(SECRET);

    fireEvent.click(screen.getByTestId('secret-once-reveal'));
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it('re-masks itself after 30 seconds', () => {
    vi.useFakeTimers();
    renderSecret();
    fireEvent.click(screen.getByTestId('secret-once-reveal'));
    expect(document.body.textContent).toContain(SECRET);

    act(() => {
      vi.advanceTimersByTime(AUTO_REMASK_MS);
    });
    // The realistic leak: revealed, then left on screen while the developer
    // does something else.
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it('re-masks the moment the window loses focus', () => {
    renderSecret();
    fireEvent.click(screen.getByTestId('secret-once-reveal'));
    expect(document.body.textContent).toContain(SECRET);

    fireEvent.blur(window);
    // Tabbing away to paste it is exactly when a screen share starts capturing.
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it('Copy writes the secret to the clipboard WITHOUT rendering it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderSecret();
    fireEvent.click(screen.getByTestId('secret-once-copy'));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SECRET));
    // The common path — copy, paste into .env, never look at it — must not put
    // the value on screen at all.
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it('is not an <input>, so no password manager offers to store it', () => {
    renderSecret();
    fireEvent.click(screen.getByTestId('secret-once-reveal'));
    const node = screen.getByTestId('secret-once-value');
    expect(node.tagName).toBe('CODE');
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  it('Done is disabled until the developer acknowledges the value is unrecoverable', () => {
    const { onDismiss } = renderSecret();
    const done = screen.getByTestId('secret-once-dismiss');
    expect(done).toBeDisabled();

    fireEvent.click(done);
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('secret-once-ack'));
    expect(done).toBeEnabled();
    fireEvent.click(done);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('states p.2’s "never recoverable" before the value is lost, not after', () => {
    renderSecret();
    expect(document.body.textContent).toMatch(/not recoverable/i);
    expect(document.body.textContent).toMatch(/rotating the secret is the only way/i);
  });
});

describe('PF-668 — unmounting is what makes the secret unreachable', () => {
  it('a remount renders no secret, because the value lived only in the parent’s state', () => {
    const { unmount } = render(
      <SecretOnceDialog
        title="App registered"
        appName="Deployment Bot"
        clientId="ship_app_abc123"
        secret={SECRET}
        rotationPolicy="instant"
        onDismiss={() => {}}
      />
    );
    fireEvent.click(screen.getByTestId('secret-once-reveal'));
    expect(document.body.textContent).toContain(SECRET);

    unmount();
    expect(document.body.textContent).not.toContain(SECRET);

    // The dialog has no props of its own to recover the value from — remounting
    // it is only possible by supplying the secret again, which nothing can do
    // after the create response is gone. The Playwright half of PF-668 asserts
    // the same fact through an actual Back navigation and a reload.
    expect(document.querySelector('[data-testid="secret-once-dialog"]')).toBeNull();
  });

  it('the secret is never written to a URL or to history.state', () => {
    renderSecret();
    fireEvent.click(screen.getByTestId('secret-once-reveal'));
    expect(window.location.href).not.toContain(SECRET);
    expect(JSON.stringify(window.history.state ?? null)).not.toContain(SECRET);
  });
});

describe('PF-670 — the consequence copy comes from `rotation_policy`, not from a literal', () => {
  it('`instant` says the old secret is already dead', () => {
    renderSecret({ rotationPolicy: 'instant' });
    const notice = screen.getByTestId('rotation-policy-notice');
    expect(notice.textContent).toMatch(/stopped working immediately/i);
  });

  it('`grace` names the retiring secret and when it dies — SAME component', () => {
    renderSecret({
      rotationPolicy: 'grace',
      previousSecretPrefix: 'ship_sec_0f11',
      previousSecretExpiresAt: '2026-09-01T00:00:00.000Z',
    });
    const notice = screen.getByTestId('rotation-policy-notice');
    expect(notice.textContent).toContain('ship_sec_0f11');
    expect(notice.textContent).toContain('2026-09-01T00:00:00.000Z');
    expect(notice.textContent).not.toMatch(/stopped working immediately/i);
  });
});

describe('PF-670 — rotation is gated on a destructive-grade confirmation', () => {
  function renderRotate(policy: 'instant' | 'grace' | null = 'instant') {
    const onRotated = vi.fn();
    const onCancel = vi.fn();
    render(
      <RotateSecretDialog
        appId="11111111-1111-4111-8111-111111111111"
        appName="Deployment Bot"
        rotationPolicy={policy}
        onCancel={onCancel}
        onRotated={onRotated}
      />
    );
    return { onRotated, onCancel };
  }

  it('Rotate stays disabled until the app name is typed EXACTLY', () => {
    renderRotate();
    const confirm = screen.getByTestId('rotate-confirm');
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByTestId('rotate-confirm-input'), {
      target: { value: 'deployment bot' },
    });
    // Case-insensitive matching would defeat the point of typing it at all.
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByTestId('rotate-confirm-input'), {
      target: { value: 'Deployment Bot' },
    });
    expect(confirm).toBeEnabled();
  });

  it('the pre-rotation warning is driven by the policy, and says what rotation does NOT do', () => {
    renderRotate('instant');
    const warning = screen.getByTestId('rotate-consequence');
    expect(warning.textContent).toMatch(/stops working/i);
    // The blast radius L02's route header records: rotation is not revocation.
    expect(warning.textContent).toMatch(/does not revoke access tokens/i);
  });

  it('`grace` renders the other model against the same component', () => {
    renderRotate('grace');
    expect(screen.getByTestId('rotate-consequence').textContent).toMatch(/keeps working until/i);
  });

  it('an unknown policy is stated as unknown rather than assumed to be the safe one', () => {
    renderRotate(null);
    // Defaulting to the reassuring answer is the failure mode that matters: a
    // dialog that says "instant" when the server never said so is a UI making a
    // claim about credentials it cannot support.
    expect(screen.getByTestId('rotate-consequence').textContent).toMatch(/has not reported/i);
  });
});

describe('PF-669 — no code path that touches a secret writes to the console', () => {
  let spies: ReturnType<typeof vi.spyOn>[] = [];

  beforeEach(() => {
    spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {})
    );
  });

  it('rendering, revealing and copying a secret produce no console output', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderSecret();
    fireEvent.click(screen.getByTestId('secret-once-reveal'));
    fireEvent.click(screen.getByTestId('secret-once-copy'));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('secret-once-ack'));
    fireEvent.click(screen.getByTestId('secret-once-dismiss'));

    for (const spy of spies) {
      const calls = (spy.mock.calls as unknown[][]).map((c) => c.join(' ')).join('\n');
      expect(calls, `console output during the secret flow:\n${calls}`).toBe('');
    }
  });
});
