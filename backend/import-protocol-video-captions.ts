import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { containsUnmaskedPersonalData } from './protocol-privacy.ts';
import { ensureProtocolSchema, saveProtocolVideoCache } from './protocol-storage.ts';
import { parseProtocolVideoCaptions } from './protocol-video.ts';

const [fileId, revision, captionPath] = process.argv.slice(2);
if (!/^[A-Za-z0-9_-]{10,100}$/u.test(fileId || '') || !/^[A-Za-z0-9._-]{1,100}$/u.test(revision || '') || !captionPath || !process.env.DATABASE_URL) {
  throw new Error('Uso: DATABASE_URL=... tsx import-protocol-video-captions.ts <drive-file-id> <revision> <archivo.vtt>');
}

const captions = await readFile(captionPath, 'utf8');
const sections = parseProtocolVideoCaptions(captions);
if (sections.some(section => containsUnmaskedPersonalData(section.text))) throw new Error('Subtítulos con datos personales detectables; no se importaron');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  await ensureProtocolSchema(pool);
  await saveProtocolVideoCache(pool, fileId, revision, sections);
  process.stdout.write(`Subtítulos importados: ${sections.length} secciones para ${fileId}, revisión ${revision}\n`);
} finally {
  await pool.end();
}
