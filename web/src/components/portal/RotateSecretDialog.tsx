/**
 * PF-670 — rotate `client_secret`, behind a destructive-grade confirmation.
 *
 * PRD p.4 lists *"viewing/rotating client_secret (shown once)"* as portal work.
 * The confirmation is not ceremony: under **D3**'s shipped model
 * (`ROTATION_POLICY = 'instant'` in `api/src/routes/apps.ts`) the old secret
 * stops verifying on the very next call, so this button is the moment every live
 * integration using that app breaks. A click that does that must cost more than
 * a click — hence typing the app's name, the same bar GitHub and Stripe put on
 * deleting a repository or revoking a key.
 *
 * ── This ticket does NOT decide D3 (L99, owned by L02, unresolved) ──────────
 * The choice between instant revocation and a Stripe-style grace period is L02's
 * to land. What this component does is render whichever model the API reports:
 * `rotation_policy` arrives on the rotate response and is passed to
 * `SecretOnceDialog`, which writes the consequence sentence from it. The
 * pre-rotation warning below is driven by the app record's own
 * `rotation_policy` for the same reason.
 *
 * If the copy were hard-coded to "the old secret dies now" and D3 flipped to a
 * grace period, the UI would describe a security model the server does not
 * implement — a lie about credentials, which is worse than either model being
 * chosen.
 *
 * ── Rotation is not revocation, and the dialog says so ──────────────────────
 * `api/src/routes/apps.ts` records the blast radius explicitly: rotating does
 * NOT revoke access tokens already issued, because the secret is an issuance
 * credential rather than a session. An operator responding to a leak needs both,
 * and a dialog that implied one covered the other would send them away believing
 * the incident was closed.
 */
import { useCallback, useState } from 'react';
import { apiPost } from '@/lib/api';
import type { RotationPolicy } from './SecretOnceDialog';

export interface RotatedSecret {
  client_id: string;
  client_secret: string;
  name: string;
  rotation_policy: RotationPolicy;
}

export interface RotateSecretDialogProps {
  appId: string;
  appName: string;
  /**
   * What the API says happens to the retiring secret. Defaults to nothing —
   * the dialog renders "the API did not say" rather than guessing `instant`,
   * because guessing the reassuring answer is the failure mode that matters.
   */
  rotationPolicy: RotationPolicy | null;
  onCancel: () => void;
  onRotated: (result: RotatedSecret) => void;
}

export function RotateSecretDialog({
  appId,
  appName,
  rotationPolicy,
  onCancel,
  onRotated,
}: RotateSecretDialogProps) {
  const [typed, setTyped] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  /** Exact match, trimmed. Case-insensitive would defeat the point of typing it. */
  const confirmed = typed.trim() === appName;

  const onRotate = useCallback(async () => {
    setSubmitting(true);
    setFailure(null);
    try {
      const res = await apiPost(`/api/apps/${encodeURIComponent(appId)}/rotate-secret`, {});
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.success) {
        setFailure(body?.error?.message ?? `Rotation failed (${res.status})`);
        return;
      }
      onRotated({
        client_id: body.data.client_id,
        client_secret: body.data.client_secret,
        name: body.data.name,
        rotation_policy: (body.data.rotation_policy ?? 'instant') as RotationPolicy,
      });
    } catch (e: unknown) {
      setFailure(e instanceof Error ? e.message : 'Rotation failed');
    } finally {
      setSubmitting(false);
    }
  }, [appId, onRotated]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rotate-secret-title"
      data-testid="rotate-secret-dialog"
    >
      <div className="w-full max-w-lg rounded-lg border border-red-400/40 bg-background p-5 shadow-xl">
        <h2 id="rotate-secret-title" className="m-0 text-base font-medium text-foreground">
          Rotate the client secret
        </h2>

        <div
          className="mt-3 mb-4 rounded border border-red-400/40 bg-red-400/5 p-3 text-sm text-red-300"
          data-testid="rotate-consequence"
        >
          {rotationPolicy === 'grace' ? (
            <>
              A new secret is issued now and the current one keeps working until its grace period
              ends. Update your integrations before then.
            </>
          ) : rotationPolicy === 'instant' ? (
            <>
              The current secret stops working <strong>immediately</strong>. Every integration
              still using it starts failing at the moment you click Rotate.
            </>
          ) : (
            <>
              This server has not reported a rotation policy for this app, so what happens to the
              current secret is unknown. Treat it as immediate.
            </>
          )}
          <p className="m-0 mt-2 text-xs text-muted">
            Rotation does not revoke access tokens that were already issued — the secret is an
            issuance credential, not a session. Responding to a leak means rotating and revoking.
          </p>
        </div>

        <label
          htmlFor="rotate-confirm-input"
          className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted"
        >
          Type <code className="font-mono text-foreground">{appName}</code> to confirm
        </label>
        <input
          id="rotate-confirm-input"
          data-testid="rotate-confirm-input"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          className="w-full rounded border border-border bg-background px-2 py-1 text-sm text-foreground"
        />

        {failure && (
          <p className="mt-3 mb-0 text-sm text-red-400" role="alert" data-testid="rotate-failure">
            {failure}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            data-testid="rotate-cancel"
            onClick={onCancel}
            className="rounded border border-border px-3 py-1 text-sm text-muted hover:bg-border/40 hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="rotate-confirm"
            disabled={!confirmed || submitting}
            onClick={() => void onRotate()}
            className="rounded border border-red-400 bg-red-400/10 px-3 py-1 text-sm text-red-300 hover:bg-red-400/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Rotating…' : 'Rotate secret'}
          </button>
        </div>
      </div>
    </div>
  );
}
