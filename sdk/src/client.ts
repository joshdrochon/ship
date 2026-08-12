/**
 * ShipClient — the front door, typed.
 *
 *   const client = new ShipClient({ baseUrl, token });
 *   const me = await client.me();                    // the SDK-skeleton MVP gate
 *   for await (const doc of client.documents.iterate()) { ... }
 */
import { errorFromResponse, type ApiErrorBody } from './errors.js';
import { DocumentsClient, type Transport } from './resources/documents.js';
import type { ITokenStore } from './auth/tokenStore.js';

export interface ShipClientOptions {
  /** e.g. https://ship.example.com — the client appends /api/v1. */
  baseUrl: string;
  /** Static token (simplest path). Mutually exclusive with tokenStore. */
  token?: string;
  /** Managed credentials (rotation-aware). TODO(josh): wire refresh. */
  tokenStore?: ITokenStore;
}

export interface Me {
  app: { client_id: string; name: string };
  user: { id: string; name: string } | null;
  scopes: string[];
}

export class ShipClient {
  readonly documents: DocumentsClient;
  private readonly transport: Transport;

  constructor(private readonly options: ShipClientOptions) {
    this.transport = { request: (m, p, o) => this.request(m, p, o) };
    this.documents = new DocumentsClient(this.transport);
  }

  /** GET /api/v1/me — proves auth + typed round-trip end-to-end. */
  me(): Promise<Me> {
    return this.transport.request<Me>('GET', '/me');
  }

  private async request<T>(
    method: string,
    path: string,
    options: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(`/api/v1${path}`, this.options.baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value);
    }

    const token = await this.resolveToken();
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });

    if (!response.ok) {
      // No initializer: both branches below assign, and `no-useless-assignment`
      // is an error-level rule, so the dead `= null` fails `pnpm lint`.
      let body: ApiErrorBody | null;
      try {
        body = (await response.json()) as ApiErrorBody;
      } catch {
        body = null;
      }
      throw errorFromResponse(response.status, body, response.headers.get('retry-after'));
    }
    return (await response.json()) as T;
  }

  private async resolveToken(): Promise<string> {
    if (this.options.token) return this.options.token;
    const stored = await this.options.tokenStore?.load().catch(() => null);
    if (stored?.accessToken) return stored.accessToken;
    // Corrupted or empty store = logged out (Failure Modes contract).
    const { ShipError } = await import('./errors.js');
    throw new ShipError({ kind: 'auth', message: 'Not authenticated. Run the login flow first.', status: 401 });
  }
}
