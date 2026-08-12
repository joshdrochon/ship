/**
 * SSM Parameter Store - Application Configuration
 *
 * This file loads application configuration from AWS SSM Parameter Store.
 *
 * Secrets Storage:
 * ─────────────────
 * SSM Parameter Store (/ship/{env}/):
 *   - DATABASE_URL, SESSION_SECRET, CORS_ORIGIN
 *   - Application config that changes per environment
 *   - CAIA OAuth credentials (CAIA_ISSUER_URL, CAIA_CLIENT_ID, etc.)
 */
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

// Lazy-initialized client to avoid keeping Node.js alive during import tests
let _client: SSMClient | null = null;

function getClient(): SSMClient {
  if (!_client) {
    _client = new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' });
  }
  return _client;
}

export async function getSSMSecret(name: string): Promise<string> {
  const command = new GetParameterCommand({
    Name: name,
    WithDecryption: true,
  });

  const response = await getClient().send(command);
  if (!response.Parameter?.Value) {
    throw new Error(`SSM parameter ${name} not found`);
  }
  return response.Parameter.Value;
}

export async function loadProductionSecrets(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') {
    return; // Use .env files for local dev
  }

  // Already configured by the platform (Render, Fly, a container runtime, CI):
  // there is no SSM to reach and nothing to fetch. Elastic Beanstalk does not
  // set DATABASE_URL, so it still takes the SSM path below unchanged.
  //
  // This guard lives here rather than at the call sites because all three
  // entrypoints reach for secrets — index.ts, db/migrate.ts and db/seed.ts —
  // and migrate.ts runs first in the container CMD. Guarding only index.ts
  // leaves the process dying in migrate with a credentials error.
  if (process.env.DATABASE_URL) {
    console.log('DATABASE_URL already set — skipping SSM');
    return;
  }

  const environment = process.env.ENVIRONMENT || 'prod';
  const basePath = `/ship/${environment}`;

  console.log(`Loading secrets from SSM path: ${basePath}`);

  const [databaseUrl, sessionSecret, corsOrigin, cdnDomain, appBaseUrl] = await Promise.all([
    getSSMSecret(`${basePath}/DATABASE_URL`),
    getSSMSecret(`${basePath}/SESSION_SECRET`),
    getSSMSecret(`${basePath}/CORS_ORIGIN`),
    getSSMSecret(`${basePath}/CDN_DOMAIN`),
    getSSMSecret(`${basePath}/APP_BASE_URL`),
  ]);

  process.env.DATABASE_URL = databaseUrl;
  process.env.SESSION_SECRET = sessionSecret;
  process.env.CORS_ORIGIN = corsOrigin;
  process.env.CDN_DOMAIN = cdnDomain;
  process.env.APP_BASE_URL = appBaseUrl;

  // PF-630 — the first-party OAuth app secrets (L21, for L02's seeder).
  //
  // `seedPlatformApps()` runs on every `db:migrate` and reads these three from
  // the environment; `assertPlatformAppSecrets()` THROWS in production when any
  // is absent. Without them the deployed database has no grader app, which is
  // MVP gate item 10 failing silently -- the server still boots, /health still
  // goes green, and the credential a grader was told to use simply does not
  // exist.
  //
  // Loaded SEPARATELY from the five above, and tolerantly. The five are
  // required for the process to function at all, so a failure there should be
  // fatal. These three are required for the *grading story*, and a hard failure
  // here would take the whole API down over a missing OAuth seed -- trading a
  // degraded deployment for no deployment. So a miss is logged loudly and left
  // to `assertPlatformAppSecrets()`, which already has the right words for it,
  // rather than throwing from inside a config loader.
  //
  // Note these are read from the SAME `/ship/${ENVIRONMENT}/` prefix, so the
  // instance role's existing path-scoped `ssm:GetParameter*` covers them and no
  // IAM change is needed (PF-625).
  const appSecretNames = [
    'AGENT_CLIENT_SECRET',
    'GRADER_CLIENT_SECRET',
    'DEMO_CLIENT_SECRET',
  ] as const;

  const appSecrets = await Promise.allSettled(
    appSecretNames.map((n) => getSSMSecret(`${basePath}/${n}`))
  );

  appSecrets.forEach((result, i) => {
    const name = appSecretNames[i];
    if (result.status === 'fulfilled') {
      process.env[name] = result.value;
    } else {
      console.error(
        `WARNING: ${basePath}/${name} could not be read (${String(result.reason)}). ` +
          `The OAuth app it seeds will not exist in this environment.`
      );
    }
  });

  console.log('Secrets loaded from SSM Parameter Store');
  console.log(`CORS_ORIGIN: ${corsOrigin}`);
  console.log(`CDN_DOMAIN: ${cdnDomain}`);
  console.log(`APP_BASE_URL: ${appBaseUrl}`);
  console.log(
    `Platform app secrets present: ${appSecretNames.filter((n) => process.env[n]).join(', ') || 'none'}`
  );
}
