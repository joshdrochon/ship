/**
 * PF-425 — `target_url` validation. Absolute `https`, and not pointed back at us.
 *
 * ## The SSRF half is OURS, not the PRD's
 *
 * p.3 says only *"Target URL"*. The scheme and credential checks are plainly
 * implementing that column; the private-range block is an addition and is
 * recorded as such.
 *
 * The reason it is not optional: an unvalidated `target_url` turns an
 * authenticated `webhooks:manage` token into a server-side request forgery
 * primitive against anything reachable from the API container — the cloud
 * metadata endpoint at 169.254.169.254 first among them — and L16's delivery
 * log would faithfully record the response body for the attacker to read back
 * through the portal. The subscription endpoint is the *ideal* SSRF vector
 * because a webhook is, by construction, "make a request to a URL I chose".
 *
 * ## What this check is NOT
 *
 * It is a write-time check on the literal host in the URL. It is **not** a
 * defence against DNS rebinding: a hostname that resolves to a public address
 * now and to 169.254.169.254 at delivery time passes here. Closing that needs
 * resolution-time pinning in the deliverer's HTTP client, which is L16's, and it
 * is named here rather than left for someone to discover. What this does buy is
 * that the obvious literal cases — `https://localhost`, `https://10.0.0.5`,
 * `https://[::1]` — are refused at the door with an error naming the field,
 * rather than silently succeeding and failing at delivery time.
 */

/**
 * PF-575 — the opt-in that lets a LOCAL instance accept a loopback target.
 *
 * Spelled once, here. `checkTargetUrl` is the only reader and it reads it
 * through `localTargetsPermitted`, so grepping this string finds the whole
 * feature. Nothing else in the repository may spell it — an operator who has to
 * set it in two places will set it in one.
 *
 * Default OFF, and off by *absence*: only the exact string `'true'` enables it.
 * A deployed environment that never mentions the variable therefore rejects
 * loopback targets no matter what `NODE_ENV` says, which is the property the
 * deployed-configuration test asserts.
 */
export const LOCAL_WEBHOOK_TARGETS_ENV_VAR = 'SHIP_ALLOW_LOOPBACK_WEBHOOK_TARGETS';

/**
 * The one named exception. `http://localhost` and `http://127.0.0.1` are
 * permitted only when this is true.
 *
 * A single greppable constant rather than an inline `process.env.NODE_ENV`
 * check, because there are two of them below and a future third would be the
 * one that drifts.
 *
 * TWO ways in, and they are deliberately different in kind:
 *
 *   `NODE_ENV === 'test'`     the test runner and CI, which must not have to
 *                             configure anything to run the suite that already
 *                             exists.
 *   the env var above         PF-575's ask, and the only one available to a
 *                             human. It was B8 in `lane-99-unassigned.md`: the
 *                             person recording the demo video and the developer
 *                             running `pnpm dev` are on `NODE_ENV=development`,
 *                             so `ship webhooks tail --listen` failed at
 *                             subscription creation with `validation_failed`.
 *                             L19 is the consumer, so L19 added it.
 *
 * What this does NOT do is widen anything for a deployed instance. Elastic
 * Beanstalk runs `NODE_ENV=production` and does not set the variable, so both
 * doors are shut; and a deployment that *did* set it would still only be able to
 * POST to its own loopback, which is the SSRF surface the module header
 * describes rather than a new one. It is an opt-in an operator has to type.
 */
export function localTargetsPermitted(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'test' || env[LOCAL_WEBHOOK_TARGETS_ENV_VAR] === 'true';
}

export type TargetUrlRejection =
  | 'not-absolute'
  | 'scheme'
  | 'credentials'
  | 'private-host'
  | 'no-host';

export interface TargetUrlProblem {
  reason: TargetUrlRejection;
  message: string;
}

/** Messages, as data, so the route and the tests read the same strings. */
export const TARGET_URL_MESSAGES: Record<TargetUrlRejection, string> = {
  'not-absolute':
    'Must be an absolute URL including the scheme, e.g. `https://example.com/hooks/ship`. ' +
    'A relative path has no host to deliver to.',
  scheme:
    'Must use `https`. A signed payload over plaintext `http` is readable by anyone on the ' +
    'path, and the signature proves authenticity, not confidentiality.',
  credentials:
    'Must not carry a username or password in the authority. Credentials in a URL are stored ' +
    'in the subscription row, echoed in the delivery log, and cannot be rotated independently ' +
    'of the subscription.',
  'private-host':
    'Must not resolve to a loopback, link-local or private address. A webhook target inside ' +
    'the API\'s own network turns this endpoint into a request-forgery primitive, and the ' +
    'delivery log would record the response.',
  'no-host': 'Must include a host.',
};

/**
 * Hosts that are private by name rather than by address. `localhost` is the one
 * that matters and it is not an IP literal, so the numeric checks below miss it.
 */
const LOOPBACK_NAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost']);

/** Strips the brackets an IPv6 authority is written with. */
function bareHost(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

/**
 * Whether a literal host is in loopback, link-local or RFC 1918 space.
 *
 * Written against the literal because that is what we have at write time; see
 * the DNS-rebinding caveat in the module header.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = bareHost(hostname.toLowerCase());
  if (LOOPBACK_NAMES.has(host)) return true;
  // `.local` (mDNS) and any `.internal` suffix — the conventional private zones.
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) {
    return true;
  }

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // loopback
    if (a === 0) return true; // "this network"
    if (a === 169 && b === 254) return true; // link-local — the metadata endpoint
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    return false;
  }

  if (host.includes(':')) {
    // IPv6. `::1` loopback, `fe80::/10` link-local, `fc00::/7` unique-local, and
    // `::ffff:a.b.c.d` IPv4-mapped — the last of which is how a v4 private
    // address sneaks past a v6-shaped check.
    if (host === '::1' || host === '::') return true;
    if (/^fe[89ab]/.test(host)) return true;
    if (/^f[cd]/.test(host)) return true;

    // IPv4-mapped. `new URL()` NORMALISES `[::ffff:10.0.0.1]` to `[::ffff:a00:1]`
    // — the dotted form never survives to here, and a check written only against
    // the readable spelling passes every test the author writes and blocks
    // nothing. Both forms are handled; the hex one is the one that matters.
    const dotted = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (dotted?.[1]) return isPrivateHost(dotted[1]);
    const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const high = Number.parseInt(hex[1]!, 16);
      const low = Number.parseInt(hex[2]!, 16);
      return isPrivateHost(
        `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`,
      );
    }
    return false;
  }

  return false;
}

/**
 * Validate a target URL. Returns `null` when acceptable, or the problem.
 *
 * A returned value rather than a throw, because the caller is a Zod refinement
 * that needs the reason to build `details.fields[]` naming `target_url`.
 */
export function checkTargetUrl(
  raw: string,
  env: NodeJS.ProcessEnv = process.env,
): TargetUrlProblem | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { reason: 'not-absolute', message: TARGET_URL_MESSAGES['not-absolute'] };
  }

  // Credentials are checked BEFORE the scheme, because `http://user:pw@host` has
  // two problems and the credential one is the one a caller is least likely to
  // have noticed they wrote.
  if (url.username.length > 0 || url.password.length > 0) {
    return { reason: 'credentials', message: TARGET_URL_MESSAGES.credentials };
  }

  const local = url.hostname.length > 0 && isPrivateHost(url.hostname);

  if (url.protocol !== 'https:') {
    // The one exception, and only for a local host: TS-6 and the TTFE drill both
    // point at a listener on 127.0.0.1, which has no certificate. A non-local
    // `http://` target is refused even under the exception — the exception is
    // for the loopback, not for plaintext.
    if (!(local && url.protocol === 'http:' && localTargetsPermitted(env))) {
      return { reason: 'scheme', message: TARGET_URL_MESSAGES.scheme };
    }
  }

  // AFTER the scheme check, deliberately. `file:///etc/passwd` parses with an
  // empty hostname, and reporting it as "must include a host" would tell the
  // caller to add one rather than to stop using `file:`.
  if (url.hostname.length === 0) {
    return { reason: 'no-host', message: TARGET_URL_MESSAGES['no-host'] };
  }

  if (local && !localTargetsPermitted(env)) {
    return { reason: 'private-host', message: TARGET_URL_MESSAGES['private-host'] };
  }

  return null;
}
