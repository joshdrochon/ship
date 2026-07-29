import { createServer } from 'http';
import { config } from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables (.env.local takes precedence)
config({ path: join(__dirname, '../.env.local') });
config({ path: join(__dirname, '../.env') });

async function main() {
  // Load secrets from SSM in production (before importing app).
  //
  // Skipped when DATABASE_URL is already present, which means the platform
  // injected configuration directly (Render, Fly, a container runtime) and there
  // is no SSM to reach. Elastic Beanstalk is unaffected: it does not set
  // DATABASE_URL, so SSM still populates it there exactly as before.
  //
  // Without this guard the process exits before binding a port on any host
  // without AWS credentials — getSSMSecret throws and main() rejects.
  const platformProvidedConfig = Boolean(process.env.DATABASE_URL);
  if (process.env.NODE_ENV === 'production' && !platformProvidedConfig) {
    const { loadProductionSecrets } = await import('./config/ssm.js');
    await loadProductionSecrets();
  }

  // Now import app after secrets are loaded
  const { createApp } = await import('./app.js');
  const { setupCollaboration } = await import('./collaboration/index.js');

  const PORT = process.env.PORT || 3000;
  const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';

  const app = createApp(CORS_ORIGIN);
  const server = createServer(app);

  // DDoS protection: Set server-wide timeouts to prevent slow-read attacks (Slowloris)
  server.timeout = 60000; // 60 seconds max request duration
  server.keepAliveTimeout = 65000; // 65 seconds (slightly longer than timeout)
  server.headersTimeout = 66000; // 66 seconds (slightly longer than keepAlive)

  // Setup WebSocket collaboration server
  setupCollaboration(server);

  // Start server
  server.listen(PORT, () => {
    console.log(`API server running on http://localhost:${PORT}`);
    console.log(`CORS origin: ${CORS_ORIGIN}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
