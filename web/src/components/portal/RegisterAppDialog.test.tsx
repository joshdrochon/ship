/**
 * PF-664 — the register-app form, driven through the DOM.
 *
 * The two properties worth a test are both about where information COMES FROM,
 * not about what the form looks like:
 *
 *   1. The scope checkboxes are whatever `GET /api/apps/registry` returned. The
 *      test proves it by serving a registry the production one has never heard
 *      of — if the component held a literal list of the seven real scopes, the
 *      assertion could not pass.
 *   2. Validation is the SERVER's. An unregistered scope is rejected by
 *      `validateRequestedScopes` (PF-073) and rendered under the field it names,
 *      rather than blocked locally by a rule that would drift from the server's.
 *
 * `web/src/lib/api` is faked at the module boundary because these are the two
 * calls under test; going through the real `apiPost` would test `csrf-sync`,
 * which `portalWriteSurface.test.ts` already does against a real Express app.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

const apiGet = vi.fn();
const apiPost = vi.fn();
vi.mock('@/lib/api', () => ({
  apiGet: (...args: unknown[]) => apiGet(...args),
  apiPost: (...args: unknown[]) => apiPost(...args),
}));

const { RegisterAppDialog } = await import('./RegisterAppDialog');

/**
 * A registry the production one does not contain.
 *
 * If the checkboxes were hard-coded, `mercury:read` could never render — which
 * is the whole assertion. A fixture that reused the real seven would pass
 * against a hard-coded list and prove nothing.
 */
const FAKE_REGISTRY = {
  scopes: [
    { scope: 'mercury:read', resource: 'mercury', action: 'read', description: 'Read mercury' },
    {
      scope: 'mercury:write',
      resource: 'mercury',
      action: 'write',
      description: 'Write mercury',
    },
  ],
  rotation_policy: 'instant',
};

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

beforeEach(() => {
  apiGet.mockResolvedValue(jsonResponse(200, { success: true, data: FAKE_REGISTRY }));
  apiPost.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PF-664 — the scope checkboxes are GENERATED from the registry', () => {
  it('renders exactly the scopes the server returned, with their descriptions', async () => {
    render(<RegisterAppDialog onCancel={() => {}} onRegistered={() => {}} />);

    await waitFor(() => expect(screen.getByTestId('scope-mercury:read')).toBeInTheDocument());
    expect(screen.getByTestId('scope-mercury:write')).toBeInTheDocument();
    expect(screen.getByText('Read mercury')).toBeInTheDocument();

    // And nothing the server did not send — no literal seven hiding in the JSX.
    expect(screen.queryByTestId('scope-documents:read')).not.toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith('/api/apps/registry');
  });

  it('renders no fallback list when the registry cannot be read', async () => {
    apiGet.mockResolvedValue(jsonResponse(500, { success: false, error: { message: 'boom' } }));
    render(<RegisterAppDialog onCancel={() => {}} onRegistered={() => {}} />);

    await waitFor(() => expect(screen.getByTestId('scopes-error')).toBeInTheDocument());
    // A stale hard-coded set here would register apps against scopes that may
    // not exist. Failing loudly is the cheaper mistake.
    expect(document.querySelectorAll('[data-testid^="scope-"]')).toHaveLength(0);
  });

  it('submits name, one-URI-per-line redirects, and the ticked scopes', async () => {
    apiPost.mockResolvedValue(
      jsonResponse(201, {
        success: true,
        data: {
          id: 'app-1',
          client_id: 'ship_app_x',
          client_secret: 'ship_secret_y',
          name: 'Mercury Bot',
          rotation_policy: 'instant',
        },
      })
    );
    const onRegistered = vi.fn();
    render(<RegisterAppDialog onCancel={() => {}} onRegistered={onRegistered} />);
    await waitFor(() => expect(screen.getByTestId('scope-mercury:read')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('register-app-name'), {
      target: { value: '  Mercury Bot  ' },
    });
    fireEvent.change(screen.getByTestId('register-app-redirects'), {
      // Blank lines and stray whitespace are the normal result of pasting.
      // https, never a loopback URI: the deployed CloudFront WAF blocks a
      // request body containing `http://localhost` and answers with an HTML
      // error page that looks nothing like a validation failure.
      target: { value: 'https://a.example/cb\n\n  https://b.example/cb  \n' },
    });
    fireEvent.click(screen.getByTestId('scope-mercury:read'));

    fireEvent.click(screen.getByTestId('register-app-submit'));

    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    expect(apiPost).toHaveBeenCalledWith('/api/apps', {
      name: 'Mercury Bot',
      redirect_uris: ['https://a.example/cb', 'https://b.example/cb'],
      requested_scopes: ['mercury:read'],
    });

    // The raw secret goes straight to the caller and is not retained here.
    expect(onRegistered).toHaveBeenCalledWith(
      expect.objectContaining({ client_secret: 'ship_secret_y', name: 'Mercury Bot' })
    );
  });
});

describe('PF-664 — server-side validation renders field by field', () => {
  it('an unknown scope is rejected by the SERVER and shown under the scope field, named', async () => {
    apiPost.mockResolvedValue(
      jsonResponse(400, {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
          details: {
            fieldErrors: { requested_scopes: ['unknown scope "apps:manage"'] },
          },
        },
      })
    );
    render(<RegisterAppDialog onCancel={() => {}} onRegistered={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('scope-mercury:read')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('register-app-submit'));

    await waitFor(() => expect(screen.getByTestId('field-error-scopes')).toBeInTheDocument());
    // The name matters: "invalid scope" sends a developer to read the list
    // themselves. PF-041 echoes the offending name for exactly this reason.
    expect(screen.getByTestId('field-error-scopes').textContent).toContain('apps:manage');
  });

  it('a bad redirect URI is shown under the redirect field, not as a banner', async () => {
    apiPost.mockResolvedValue(
      jsonResponse(400, {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
          details: {
            fieldErrors: {
              redirect_uris: ['redirect_uris[0] must use https (http is permitted only for loopback addresses)'],
            },
          },
        },
      })
    );
    render(<RegisterAppDialog onCancel={() => {}} onRegistered={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('scope-mercury:read')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('register-app-submit'));

    await waitFor(() => expect(screen.getByTestId('field-error-redirects')).toBeInTheDocument());
    expect(screen.getByTestId('field-error-redirects').textContent).toContain('https');
  });

  it('the form does NOT block an unregistered scope locally — the server has to', async () => {
    // PF-664 requires the rejection to come from `validateRequestedScopes`
    // "rather than by the form". That is only assertable if the form is willing
    // to send whatever is ticked: here, a scope the production registry has
    // never heard of goes out on the wire.
    apiPost.mockResolvedValue(jsonResponse(400, { success: false, error: { message: 'nope' } }));
    render(<RegisterAppDialog onCancel={() => {}} onRegistered={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('scope-mercury:write')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('scope-mercury:write'));
    fireEvent.click(screen.getByTestId('register-app-submit'));

    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    expect(apiPost.mock.calls[0]![1]).toMatchObject({ requested_scopes: ['mercury:write'] });
  });
});
