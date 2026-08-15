/**
 * PF-666 / PF-667 / PF-668 / PF-669 — the shown-once secret display.
 *
 * PRD p.2 requires the raw `client_secret` to be *"shown exactly once on
 * creation"* and to be *"never recoverable thereafter"*. Pre-Search 1.4 (p.15)
 * asks how that display is protected from leaking via **screenshot**, via the
 * **Back button**, and via a **log line**. This component is the answer to all
 * three, and one honest admission:
 *
 * **A screenshot cannot be prevented.** No web API stops it. What a component
 * controls is what a screenshot CAPTURES, so the default state of this dialog
 * shows `••••••••` and the plaintext exists in the DOM only during a window the
 * developer deliberately opened and that closes itself again.
 *
 * ── The four rules, and why each is not decoration ──────────────────────────
 *
 * 1. **Masked by default; Reveal is a deliberate act.** The value is ABSENT from
 *    the DOM until Reveal — not `display:none`, not `visibility:hidden`, not a
 *    CSS blur. Every one of those still ships the bytes to anyone with dev tools
 *    open, still lands in an accessibility-tree dump, and still appears in a
 *    screen reader's output.
 * 2. **Auto-remask after 30 s and on window blur.** The realistic leak is not an
 *    attacker; it is a revealed secret still on screen when the developer
 *    tabs away to paste it and someone starts screen-sharing. Blur is the exact
 *    moment that risk begins.
 * 3. **Copy never renders the plaintext.** `navigator.clipboard.writeText` takes
 *    the value from a closure, so the common path — reveal nothing, click Copy,
 *    paste into `.env` — never puts the secret on screen at all. The old
 *    `execCommand('copy')` trick requires a populated element in the document
 *    and would defeat the entire component.
 * 4. **Dismiss is gated on an acknowledgement.** p.2's "never recoverable" is a
 *    fact the user must be told BEFORE they lose the value, not one they
 *    discover afterwards by looking for it. The checkbox is what makes closing
 *    the dialog a decision.
 *
 * ── Not an `<input>` (PF-666, stated because it looks like a downgrade) ──────
 * A password manager offers to save an `<input type="password">`, and Chrome
 * autofills into one. Saving an OAuth client secret into a browser password
 * store is a second uncontrolled copy of a credential we promised to show once.
 * So the value renders in a `<code>` element and the Copy button replaces the
 * select-and-copy affordance an input would have given.
 *
 * ── What this component must never do (PF-667 / PF-669) ─────────────────────
 * It takes the secret as a PROP and holds it in no store. The caller keeps it in
 * component state and drops it on dismiss. It must never reach TanStack query
 * state — `web/src/lib/queryClient.ts` persists that cache to IndexedDB, which
 * survives reload and logout, so a secret in query state is a secret written to
 * disk. There is no `console.*` call in this file and none anywhere on the
 * create/rotate path; `portalSecretHygiene.test.ts` fails the build if one
 * appears.
 *
 * ── Why one component and not two (PF-670, PF-672) ──────────────────────────
 * Registration, rotation and — when L22's S4 lands — webhook signing secrets all
 * show a value exactly once. A second implementation would be a second place to
 * get the masking wrong, and the two would drift the first time one of them was
 * fixed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * D3's rotation model, as DATA (PF-670).
 *
 * The API returns `rotation_policy` on both the create and rotate responses so
 * this dialog can render whichever model ships. `instant` is what L02's
 * `ROTATION_POLICY` constant holds today. If D3 flips to a Stripe-style grace
 * period and this copy were hard-coded, the UI would state a security model the
 * server does not implement — worse than either model.
 */
export type RotationPolicy = 'instant' | 'grace';

/**
 * What this dialog says about the value it REPLACED — PF-670, plus the case
 * PF-672 exposed.
 *
 * `'none'` means nothing was replaced: a first issue, where there is no previous
 * secret to have any fate at all. Before it existed, a freshly registered app
 * was shown *"the previous secret stopped working immediately. Any integration
 * still using it is failing now"* — a sentence about an integration that has
 * never existed, on the screen where a developer is being told the security
 * rules. That is the same class of defect PF-670 exists to prevent (a UI stating
 * a model the server does not implement), arriving from the other direction.
 */
export type SecretIssueContext = RotationPolicy | 'none';

export interface SecretOnceDialogProps {
  /** Heading — "App registered", "Secret rotated", "Subscription created". */
  title: string;
  /** The app this secret belongs to, named so a rotation cannot be misread. */
  appName: string;
  /** `client_id` is NOT a secret (PF-032) and renders in full, always visible. */
  clientId: string;
  /** The raw secret. Held by the caller in component state and nowhere else. */
  secret: string;
  /**
   * What the server says about the old secret's fate, or `'none'` on a first
   * issue.
   */
  rotationPolicy: SecretIssueContext;
  /**
   * Field names, for the one reuse the same component serves (PF-672).
   *
   * A webhook signing secret is the same CLASS of value as a `client_secret` —
   * shown once, hashed at rest, unrecoverable — so it gets the same masking, the
   * same copy-without-render and the same acknowledgement. What it does not
   * share is the labels: calling a subscription's identifier `client_id` would
   * send a developer looking for it in the wrong place. A second implementation
   * would be a second place to leak (PF-666), so the labels are props.
   */
  identifierLabel?: string;
  secretLabel?: string;
  /** `grace` only: the retiring secret's prefix and expiry, straight from the API. */
  previousSecretPrefix?: string | null;
  previousSecretExpiresAt?: string | null;
  onDismiss: () => void;
}

/** How long a revealed secret stays on screen before it re-masks itself. */
export const AUTO_REMASK_MS = 30_000;

export function SecretOnceDialog({
  title,
  appName,
  clientId,
  secret,
  rotationPolicy,
  identifierLabel = 'client_id',
  secretLabel = 'client_secret',
  previousSecretPrefix = null,
  previousSecretExpiresAt = null,
  onDismiss,
}: SecretOnceDialogProps) {
  const [revealed, setRevealed] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const remask = useCallback(() => {
    setRevealed(false);
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /** Rule 2 — the 30-second ceiling. Restarted on every reveal, cleared on unmount. */
  useEffect(() => {
    if (!revealed) return;
    timerRef.current = setTimeout(() => setRevealed(false), AUTO_REMASK_MS);
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [revealed]);

  /**
   * Rule 2, second half — the window losing focus is the moment a screen share,
   * a second monitor or a colleague walking past becomes the threat.
   */
  useEffect(() => {
    if (!revealed) return;
    window.addEventListener('blur', remask);
    return () => window.removeEventListener('blur', remask);
  }, [revealed, remask]);

  /**
   * Rule 3 — the value goes from a closure to the clipboard, touching no node.
   *
   * A failure is REPORTED rather than worked around. The `execCommand` fallback
   * needs the plaintext in a selectable element, which is exactly what this
   * component exists to avoid; telling the developer to reveal and copy by hand
   * keeps that choice theirs.
   */
  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  }, [secret]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="secret-once-title"
      data-testid="secret-once-dialog"
    >
      <div className="w-full max-w-lg rounded-lg border border-border bg-background p-5 shadow-xl">
        <h2 id="secret-once-title" className="m-0 text-base font-medium text-foreground">
          {title}
        </h2>
        <p className="mt-1 mb-4 text-sm text-muted">
          <span className="font-medium text-foreground">{appName}</span> — this secret is shown
          once and is stored only as a hash. It is not recoverable; if you lose it, rotating the
          secret is the only way to get a working one.
        </p>

        <div className="mb-3 flex flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">
            {identifierLabel}
          </span>
          {/* Not a secret, and a developer has to copy it into their config. */}
          <code
            className="break-all rounded bg-border/30 p-2 font-mono text-xs text-foreground"
            data-testid="secret-once-client-id"
          >
            {clientId}
          </code>
        </div>

        <div className="mb-4 flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">
              {secretLabel}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                data-testid="secret-once-copy"
                onClick={() => void onCopy()}
                className="rounded border border-border px-2 py-0.5 text-xs text-foreground hover:bg-border/40"
              >
                {copyState === 'copied' ? 'Copied' : 'Copy'}
              </button>
              <button
                type="button"
                data-testid="secret-once-reveal"
                aria-expanded={revealed}
                onClick={() => (revealed ? remask() : setRevealed(true))}
                className="rounded border border-border px-2 py-0.5 text-xs text-foreground hover:bg-border/40"
              >
                {revealed ? 'Hide' : 'Reveal'}
              </button>
            </div>
          </div>

          {/*
            Rule 1. The two branches render DIFFERENT CONTENT, not the same
            content styled differently: masked, the secret's characters are not
            in the document at all.

            `<code>`, never `<input type="password">` — see the header.
          */}
          {revealed ? (
            <code
              className="break-all rounded bg-border/30 p-2 font-mono text-xs text-foreground"
              data-testid="secret-once-value"
            >
              {secret}
            </code>
          ) : (
            <code
              className="rounded bg-border/30 p-2 font-mono text-xs text-muted"
              data-testid="secret-once-masked"
              aria-label="Client secret, hidden"
            >
              {'•'.repeat(24)}
            </code>
          )}

          <span className="text-xs text-muted">
            {revealed
              ? `Visible for ${AUTO_REMASK_MS / 1000} seconds, and hidden again as soon as this window loses focus.`
              : 'Hidden. Copy puts it on your clipboard without showing it.'}
          </span>
          {copyState === 'failed' && (
            <span className="text-xs text-red-400" role="alert">
              The browser refused clipboard access. Reveal the secret and copy it by hand.
            </span>
          )}
        </div>

        {/*
          PF-670 — the blast radius, from the server's `rotation_policy` rather
          than from a sentence written here.
        */}
        <div
          className="mb-4 rounded border border-amber-400/40 bg-amber-400/5 p-3 text-xs text-amber-200"
          data-testid="rotation-policy-notice"
        >
          {rotationPolicy === 'none' ? (
            <>
              This is the first secret for {appName}. Nothing was replaced, so no existing
              integration is affected — but this value is the only copy, and it is stored here as a
              hash.
            </>
          ) : rotationPolicy === 'instant' ? (
            <>
              The previous secret stopped working immediately. Any integration still using it is
              failing now.
            </>
          ) : (
            <>
              The previous secret{' '}
              {previousSecretPrefix ? (
                <code className="font-mono">{previousSecretPrefix}…</code>
              ) : (
                'still works'
              )}{' '}
              keeps working until{' '}
              {previousSecretExpiresAt ?? 'the end of the grace period'}. Update your integrations
              before then.
            </>
          )}
        </div>

        <label className="mb-4 flex items-start gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            data-testid="secret-once-ack"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="mt-0.5"
          />
          <span>I have stored this secret. I understand it cannot be shown again.</span>
        </label>

        <div className="flex justify-end">
          <button
            type="button"
            data-testid="secret-once-dismiss"
            disabled={!acknowledged}
            onClick={onDismiss}
            className="rounded border border-border px-3 py-1 text-sm text-foreground hover:bg-border/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
