// Panel de marketing (épico 869fny1et). Ver docs/PANEL_MARKETING.md.
//
//   ensureMarketing(pool)            esquema aditivo (en ensureDatabaseSchema)
//   registerMarketing(app, deps)     API /api/marketing/...
//   createMarketingWorker(pool)      carga diaria de Windsor y ClickUp (en bootstrap)
export { ensureMarketing } from './schema.ts';
export { registerMarketing } from './routes.ts';
export { createMarketingWorker } from './carga.ts';
