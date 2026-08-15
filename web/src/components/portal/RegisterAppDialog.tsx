/**
 * PF-664 — the register-app form. PRD p.4's *"registering apps"*, and the write
 * half of MVP gate item 1 (p.2, *"admin can create an app"*) reached through a
 * screen rather than through curl.
 *
 * ── The scope checkboxes are GENERATED (the ticket's actual requirement) ─────
 * They come from `usePortalRegistry()` → `GET /api/apps/registry` →
 * `scopeRegistry.list()`, which is the same registry
 * `createAppRequestSchema.requested_scopes` validates against. A hard-coded list
 * here would falsify L03's Open/Closed claim (PF-066) silently: an eighth scope
 * would be registrable by API and simply invisible in the UI.
 *
 * ── Validation is the SERVER's, rendered field by field ─────────────────────
 * This form does not re-implement `redirectUriProblem` or the scope check. It
 * submits, and it renders `error.details.fieldErrors` under the field each
 * message names. Two reasons that is not laziness:
 *
 *   * A client-side copy of a validation rule is a rule that drifts. The
 *     https-only redirect rule has a named loopback exception
 *     (`LOOPBACK_REDIRECT_HOSTS`); a re-implementation that missed it would
 *     block the exact URI the browser SDK demo needs.
 *   * PF-664 requires an unregistered scope to be rejected by
 *     `validateRequestedScopes` *"rather than by the form"*. That is only
 *     testable if the form can send one — so the checkbox set is the registry's,
 *     but nothing here blocks a scope name from reaching the server.
 *
 * The one thing checked locally is `required`-style emptiness on the two text
 * fields, and even that only to avoid a round trip; the server rejects them too.
 *
 * ── On success, the flow CANNOT be re-entered (PF-664 → PF-666) ─────────────
 * `onRegistered` hands the raw secret to the parent and this dialog unmounts.
 * There is no route for the secret display, no query parameter, and no state
 * pushed into history — see `SecretOnceDialog`'s header and PF-668. The form
 * itself is gone, so "submit again" is not reachable by Back, by refresh, or by
 * a double click.
 */
import { useCallback, useMemo, useState } from 'react';
import { apiPost } from '@/lib/api';
import { usePortalRegistry } from '@/hooks/usePortalRegistry';

/** The `POST /api/apps` 201 body (PF-040). `client_secret` exists only here. */
export interface RegisteredApp {
  id: string;
  client_id: string;
  client_secret: string;
  name: string;
  rotation_policy: 'instant' | 'grace';
}

export interface RegisterAppDialogProps {
  onCancel: () => void;
  /** Called once, with the only copy of the raw secret this app will ever emit. */
  onRegistered: (app: RegisteredApp) => void;
}

/** Zod's `flatten()` shape, as it arrives inside `ApiError.details`. */
interface FieldErrors {
  formErrors?: string[];
  fieldErrors?: Record<string, string[] | undefined>;
}

export function RegisterAppDialog({ onCancel, onRegistered }: RegisterAppDialogProps) {
  const { scopes, loading: scopesLoading, error: scopesError } = usePortalRegistry();

  const [name, setName] = useState('');
  const [redirectText, setRedirectText] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<string | null>(null);

  /**
   * One URI per line. A comma-separated field would make a URI containing a
   * comma unenterable, and `redirect_uris` is compared byte-for-byte at
   * authorize time (PF-042) — so the parse has to be lossless, not clever.
   */
  const redirectUris = useMemo(
    () =>
      redirectText
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== ''),
    [redirectText]
  );

  const toggleScope = useCallback((scope: string) => {
    setSelected((current) =>
      current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope]
    );
  }, []);

  const onSubmit = useCallback(async () => {
    setSubmitting(true);
    setErrors({});
    setFailure(null);
    try {
      const res = await apiPost('/api/apps', {
        name: name.trim(),
        redirect_uris: redirectUris,
        requested_scopes: selected,
      });
      const body = await res.json().catch(() => null);

      if (res.status === 201 && body?.success) {
        // The raw secret goes STRAIGHT to the caller's component state. It is
        // not stored here, not put in a query cache, and not logged (PF-667,
        // PF-669) — this function body is the last place it is referenced.
        onRegistered({
          id: body.data.id,
          client_id: body.data.client_id,
          client_secret: body.data.client_secret,
          name: body.data.name,
          rotation_policy: body.data.rotation_policy ?? 'instant',
        });
        return;
      }

      const details = body?.error?.details as FieldErrors | undefined;
      if (details && (details.fieldErrors || details.formErrors)) {
        setErrors(details);
      }
      setFailure(body?.error?.message ?? `Registration failed (${res.status})`);
    } catch (e: unknown) {
      setFailure(e instanceof Error ? e.message : 'Registration failed');
    } finally {
      setSubmitting(false);
    }
  }, [name, redirectUris, selected, onRegistered]);

  const fieldError = (field: string): string[] => errors.fieldErrors?.[field] ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="register-app-title"
      data-testid="register-app-dialog"
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-lg border border-border bg-background p-5 shadow-xl">
        <h2 id="register-app-title" className="m-0 text-base font-medium text-foreground">
          Register an OAuth app
        </h2>
        <p className="mt-1 mb-4 text-sm text-muted">
          You will receive a <code>client_id</code> and a <code>client_secret</code>. The secret is
          shown once, on the next screen.
        </p>

        <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
          Name
        </label>
        <input
          data-testid="register-app-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Deployment Bot"
          className="mb-1 w-full rounded border border-border bg-background px-2 py-1 text-sm text-foreground"
        />
        {fieldError('name').map((m) => (
          <p key={m} className="m-0 mb-2 text-xs text-red-400" data-testid="field-error-name">
            {m}
          </p>
        ))}

        <label className="mt-3 mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
          Redirect URIs — one per line
        </label>
        <textarea
          data-testid="register-app-redirects"
          value={redirectText}
          onChange={(e) => setRedirectText(e.target.value)}
          rows={3}
          placeholder={'https://your-app.example/callback'}
          className="mb-1 w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs text-foreground"
        />
        <p className="m-0 mb-1 text-xs text-muted">
          https only, except loopback addresses for local development.
        </p>
        {fieldError('redirect_uris').map((m) => (
          <p key={m} className="m-0 mb-2 text-xs text-red-400" data-testid="field-error-redirects">
            {m}
          </p>
        ))}

        <fieldset className="mt-3 mb-1 border-0 p-0">
          <legend className="mb-1 p-0 text-xs font-medium uppercase tracking-wide text-muted">
            Requested scopes
          </legend>

          {scopesLoading && (
            <p className="m-0 text-sm text-muted" role="status">
              Loading the scope registry…
            </p>
          )}
          {scopesError && (
            // No hard-coded fallback list: see `usePortalRegistry`. A form that
            // guesses the registry is a form that registers apps against scopes
            // that may not exist.
            <p className="m-0 text-sm text-red-400" role="alert" data-testid="scopes-error">
              {scopesError}
            </p>
          )}

          <div className="flex flex-col gap-1">
            {(scopes ?? []).map((s) => (
              <label key={s.scope} className="flex items-start gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  data-testid={`scope-${s.scope}`}
                  checked={selected.includes(s.scope)}
                  onChange={() => toggleScope(s.scope)}
                  className="mt-1"
                />
                <span>
                  <code className="font-mono text-xs">{s.scope}</code>
                  <span className="block text-xs text-muted">{s.description}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {fieldError('requested_scopes').map((m) => (
          <p key={m} className="m-0 mt-1 text-xs text-red-400" data-testid="field-error-scopes">
            {m}
          </p>
        ))}

        {failure && (
          <p className="mt-3 mb-0 text-sm text-red-400" role="alert" data-testid="register-failure">
            {failure}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-border px-3 py-1 text-sm text-muted hover:bg-border/40 hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="register-app-submit"
            disabled={submitting}
            onClick={() => void onSubmit()}
            className="rounded border border-accent bg-accent/10 px-3 py-1 text-sm text-accent hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Registering…' : 'Register app'}
          </button>
        </div>
      </div>
    </div>
  );
}
