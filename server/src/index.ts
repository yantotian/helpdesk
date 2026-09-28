import './env.js';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import { testConnection } from './db/index.js';
import { runMigrations, ensureAdminUser } from './db/migrate.js';
import { checkSlaBreaches, autoCloseVerified } from './jobs.js';
import authRoutes from './routes/auth.js';
import profileRoutes from './routes/profiles.js';
import categoryRoutes from './routes/categories.js';
import ticketRoutes from './routes/tickets.js';
import idRequestRoutes from './routes/idRequests.js';
import ictRoutes from './routes/ict.js';
import notificationRoutes from './routes/notifications.js';
import templateRoutes from './routes/templates.js';
import miscRoutes from './routes/misc.js';
import uploadRoutes from './routes/upload.js';
import fileRoutes from './routes/files.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);
const uploadDir = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'));

app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '10mb' }));

for (const d of ['', 'ticket-attachments', 'id-photos', 'id-signatures']) {
  fs.mkdirSync(path.join(uploadDir, d), { recursive: true });
}

// NOTE: uploaded files are NOT exposed as a public static mount — ID photos and
// signatures are PII. They are served through /api/files/<signed-token>, which
// re-checks the caller's permission. See routes/files.ts.

// ── Health check (must be registered before the routers / SPA catch-all) ────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── API routes ──────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/profiles', profileRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/id-requests', idRequestRoutes);
app.use('/api/ict', ictRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api', miscRoutes);

// ── API 404 for unknown /api paths (before the SPA fallback) ───────────────
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Static frontend + SPA fallback (production only) ────────────────────────
const distCandidates = [
  path.join(__dirname, '..', '..', 'dist'),
  path.join(process.cwd(), 'dist'),
  path.join(process.cwd(), '..', 'dist'),
];
const distDir = distCandidates.find((d) => fs.existsSync(path.join(d, 'index.html')));
if (distDir) {
  app.use(express.static(distDir));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

// ── Scheduled jobs (replacing pg_cron) ──────────────────────────────────────
if (process.env.DISABLE_CRON !== 'true') {
  cron.schedule('*/5 * * * *', async () => {
    try {
      const n = await checkSlaBreaches();
      if (n > 0) console.log(`[cron] SLA: flagged ${n} breached ticket(s)`);
    } catch (e) {
      console.error('[cron] SLA check failed:', e);
    }
  });

  cron.schedule('*/15 * * * *', async () => {
    try {
      const n = await autoCloseVerified();
      if (n > 0) console.log(`[cron] auto-closed ${n} verified ticket(s)`);
    } catch (e) {
      console.error('[cron] auto-close failed:', e);
    }
  });
}

// ── Error handler ───────────────────────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  const status = /not allowed/i.test(err.message) ? 400 : 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
});

// ── Startup: apply schema, seed admin, then listen ──────────────────────────
async function start() {
  if (!(await testConnection())) {
    console.error('Cannot reach PostgreSQL. Check DATABASE_URL and that the database is running.');
    process.exit(1);
  }

  // Idempotent, so the schema is guaranteed to exist on first boot.
  await runMigrations();
  await ensureAdminUser();
  console.log('[init] schema ready');

  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
    if (distDir) console.log(`Serving frontend from ${distDir}`);
    else console.log('No frontend build found — run `npm run build` in the project root, or use the Vite dev server.');
  });
}

start().catch((error) => {
  console.error('Failed to start:', error);
  process.exit(1);
});
