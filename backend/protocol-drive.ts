import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { ProtocolFile } from './protocol-corpus.ts';
import { createProtocolCorpus, type ProtocolCorpus } from './protocol-corpus.ts';
import { containsUnmaskedPersonalData } from './protocol-privacy.ts';
import { transcribeProtocolTable } from './protocol-gemini.ts';
import { applyProtocolVision, protocolTableColumnCount, type ProtocolVisionPage } from './protocol-vision.ts';

type DriveEntry = { id: string; name: string; mimeType: string; modifiedTime?: string; version?: string; md5Checksum?: string; parents?: string[]; resourceKey?: string };
type DrivePage = { files?: DriveEntry[]; nextPageToken?: string; incompleteSearch?: boolean };
type DriveRequest = (path: string, resourceKeys?: string) => Promise<Response>;

export type ProtocolSyncReport = {
  checkedAt: string;
  files: Array<{ id: string; name: string; status: 'correcto' | 'con avisos' | 'excluido'; sections: number; tables: number; tokens: number; warnings: string[] }>;
  versionId: string | null;
  error: string | null;
};

const folderId = '14oB0TKbGyvEDMti2JgjXIep54-ZcMbc_';
const googleMime = 'application/vnd.google-apps.';
const extractionVersion = 4;
const extractorPath = fileURLToPath(new URL('./protocol-extract.py', import.meta.url));

function extractionFormat(file: DriveEntry): { kind: string; exportMime?: string } | null {
  if (file.mimeType === `${googleMime}document`) return { kind: 'docx', exportMime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  if (file.mimeType === `${googleMime}presentation`) return { kind: 'pptx', exportMime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
  if (file.mimeType === `${googleMime}spreadsheet`) return { kind: 'xlsx', exportMime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  if (file.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || /\.docx$/iu.test(file.name)) return { kind: 'docx' };
  if (file.mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' || /\.pptx$/iu.test(file.name)) return { kind: 'pptx' };
  if (file.mimeType === 'application/pdf' || /\.pdf$/iu.test(file.name)) return { kind: 'pdf' };
  if (file.mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || /\.xlsx$/iu.test(file.name)) return { kind: 'xlsx' };
  if (file.mimeType.startsWith('text/') || /\.(txt|md)$/iu.test(file.name)) return { kind: 'text' };
  return null;
}

async function listProtocolFiles(request: DriveRequest): Promise<DriveEntry[]> {
  const files: DriveEntry[] = [];
  let pageToken = '';
  const tokens = new Set<string>();
  do {
    if (tokens.has(pageToken)) throw new Error('Drive repitió la paginación');
    tokens.add(pageToken);
    const params = new URLSearchParams({ q: `'${folderId}' in parents and trashed = false`, pageSize: '1000', fields: 'nextPageToken,incompleteSearch,files(id,name,mimeType,modifiedTime,version,md5Checksum,parents,resourceKey)', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
    if (pageToken) params.set('pageToken', pageToken);
    const response = await request(`/files?${params}`);
    if (!response.ok) throw new Error(`Google Drive respondió ${response.status}`);
    const page = await response.json() as DrivePage;
    if (page.incompleteSearch) throw new Error('Google Drive devolvió una búsqueda incompleta');
    files.push(...(page.files || []).filter(file => file.parents?.includes(folderId)));
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  return files;
}

async function extractFile(kind: string, data: Buffer, pythonBin: string): Promise<{ sections: ProtocolFile['sections']; warnings: string[]; visionPages?: ProtocolVisionPage[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, [extractorPath, kind], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let error = '';
    const timeout = setTimeout(() => child.kill(), 120_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 10_000_000) child.kill(); });
    child.stderr.on('data', chunk => { error += chunk; if (error.length > 2_000) child.kill(); });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timeout);
      try {
        const parsed = JSON.parse(output) as { sections: ProtocolFile['sections']; warnings: string[]; visionPages?: ProtocolVisionPage[] };
        if (code !== 0 || !Array.isArray(parsed.sections) || !Array.isArray(parsed.warnings)) reject(new Error(parsed.warnings?.[0] || 'Extracción fallida'));
        else resolve(parsed);
      } catch { reject(new Error(error || 'Extracción fallida')); }
    });
    child.stdin.on('error', reject);
    child.stdin.end(data);
  });
}

export async function syncProtocolDrive(request: DriveRequest, options: {
  maxTokens: number;
  pythonBin?: string;
  extract?: typeof extractFile;
  previous?: ProtocolCorpus | null;
  save: (corpus: ProtocolCorpus) => Promise<void>;
  transcribeTable?: (image: Buffer) => Promise<string>;
  loadVision?: (fileId: string, revision: string, page: string, imageHash: string) => Promise<string | null>;
  saveVision?: (fileId: string, revision: string, page: string, imageHash: string, markdown: string) => Promise<void>;
}): Promise<ProtocolSyncReport> {
  const report: ProtocolSyncReport = { checkedAt: new Date().toISOString(), files: [], versionId: options.previous?.id || null, error: null };
  try {
    const entries = await listProtocolFiles(request);
    const accepted: ProtocolFile[] = [];
    let driveFailure = false;
    let dependencyFailure = false;
    let visionFailure = false;
    let documentFailure = false;
    const normalizedNames = new Map<string, string>();
    for (const entry of entries) {
      if (entry.mimeType === `${googleMime}folder` || entry.name.trim().toLowerCase() === '_obsoletos') continue;
      const format = extractionFormat(entry);
      if (!format) {
        report.files.push({ id: entry.id, name: entry.name, status: 'excluido', sections: 0, tables: 0, tokens: 0, warnings: ['Formato no soportado'] });
        continue;
      }
      const revision = entry.version || entry.md5Checksum || entry.modifiedTime || '';
      const previousFile = options.previous?.files.find(file => file.id === entry.id && file.name === entry.name && file.revision === revision && file.modifiedTime === (entry.modifiedTime || '') && file.extractionVersion === extractionVersion);
      if (previousFile) {
        accepted.push(previousFile);
        report.files.push({ id: entry.id, name: entry.name, status: previousFile.warnings.length ? 'con avisos' : 'correcto', sections: previousFile.sections.length, tables: previousFile.sections.filter(section => /(^|\n)\| /u.test(section.text)).length, tokens: Math.ceil(previousFile.sections.reduce((sum, section) => sum + section.text.length, 0) / 3), warnings: previousFile.warnings });
        continue;
      }
      try {
        const path = format.exportMime
          ? `/files/${encodeURIComponent(entry.id)}/export?mimeType=${encodeURIComponent(format.exportMime)}`
          : `/files/${encodeURIComponent(entry.id)}?alt=media&supportsAllDrives=true`;
        const response = await request(path, entry.resourceKey ? `${entry.id}/${entry.resourceKey}` : undefined);
        if (!response.ok) throw new Error(`Google Drive respondió ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > 30 * 1024 * 1024) throw new Error('Archivo demasiado grande');
        const extracted = await (options.extract || extractFile)(format.kind, bytes, options.pythonBin || process.env.PROTOCOL_PYTHON_BIN || 'python3');
        for (const page of extracted.visionPages?.filter(page => page.kind === 'scanned') || []) {
          const imageHash = createHash('sha256').update(Buffer.from(page.image, 'base64')).digest('hex');
          const reviewedText = await options.loadVision?.(entry.id, revision, page.ref, imageHash);
          if (!reviewedText?.trim() || containsUnmaskedPersonalData(reviewedText)) {
            throw new Error(`${page.ref}: falta una transcripción visual verificada; se conserva el corpus anterior`);
          }
          const pageNumber = Number(/^página (\d+)$/u.exec(page.ref)?.[1]);
          const insertionIndex = extracted.sections.findIndex(section => Number(/^página (\d+)$/u.exec(section.ref)?.[1]) > pageNumber);
          extracted.sections.splice(insertionIndex < 0 ? extracted.sections.length : insertionIndex, 0, { ref: page.ref, text: reviewedText.trim() });
          extracted.warnings = extracted.warnings.filter(warning => warning !== `${page.ref}: sin capa de texto; pendiente de verificación visual`);
          extracted.warnings.push(`${page.ref}: transcripción visual verificada`);
        }
        if (extracted.sections.length && extracted.warnings.some(warning => /página \d+: (?:sin capa de texto|tabla con palabras no verificadas)|se alcanzó el límite de \d+ filas/iu.test(warning))) {
          throw new Error('El documento contiene páginas u hojas omitidas; se conserva el corpus anterior');
        }
        if (format.kind === 'pdf' && extracted.visionPages?.some(page => page.kind !== 'scanned')) {
          for (const page of extracted.visionPages.filter(page => page.kind !== 'scanned')) {
            let generated: string | null = null;
            const image = Buffer.from(page.image, 'base64');
            const imageHash = createHash('sha256').update(image).digest('hex');
            const cached = await options.loadVision?.(entry.id, revision, page.ref, imageHash);
            const sourceText = extracted.sections.find(section => section.ref === page.ref)?.text || '';
            const expectedColumns = protocolTableColumnCount(sourceText) || undefined;
            const transcribe = () => options.transcribeTable ? options.transcribeTable(image) : transcribeProtocolTable(image, { expectedColumns });
            let vision = await applyProtocolVision(extracted.sections, [page], async () => {
              generated = cached || await transcribe();
              return generated;
            });
            if (cached && !vision.sections.some(section => section.ref === page.ref)) {
              generated = await transcribe();
              vision = await applyProtocolVision(extracted.sections, [page], async () => generated!);
            }
            if (!options.transcribeTable && expectedColumns && !vision.sections.some(section => section.ref === page.ref)) {
              generated = await transcribeProtocolTable(image, { expectedColumns, structuredRows: true });
              vision = await applyProtocolVision(extracted.sections, [page], async () => generated!);
            }
            extracted.sections = vision.sections;
            extracted.warnings.push(...vision.warnings);
            const acceptedSection = vision.sections.find(section => section.ref === page.ref);
            if (generated && acceptedSection && !containsUnmaskedPersonalData(acceptedSection.text)) {
              await options.saveVision?.(entry.id, revision, page.ref, imageHash, generated);
            }
            if (vision.warnings.length) throw new Error(vision.warnings.join('; '));
          }
        }
        if (extracted.sections.some(section => containsUnmaskedPersonalData(section.text))) throw new Error('Documento con datos personales detectables; se excluye');
        if (!extracted.sections.length) {
          report.files.push({ id: entry.id, name: entry.name, status: 'excluido', sections: 0, tables: 0, tokens: 0, warnings: extracted.warnings.length ? extracted.warnings : ['Sin texto verificable'] });
          continue;
        }
        const normalizedName = entry.name.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').toLowerCase().replace(/\.(pptx|docx|pdf|xlsx)$/iu, '').replace(/\b(v\d+|version\s*\d+|20\d{2}[-_/]?\d{0,2}[-_/]?\d{0,2})\b/giu, '').replace(/\s+/gu, ' ').trim();
        const duplicate = normalizedNames.get(normalizedName);
        if (duplicate) extracted.warnings.push(`Posible versión duplicada de ${duplicate}`);
        else normalizedNames.set(normalizedName, entry.name);
        accepted.push({ id: entry.id, name: entry.name, mimeType: entry.mimeType, modifiedTime: entry.modifiedTime || '', revision, extractionVersion, sections: extracted.sections, warnings: extracted.warnings });
        report.files.push({ id: entry.id, name: entry.name, status: extracted.warnings.length ? 'con avisos' : 'correcto', sections: extracted.sections.length, tables: extracted.sections.filter(section => /(^|\n)\| /u.test(section.text)).length, tokens: Math.ceil(extracted.sections.reduce((sum, section) => sum + section.text.length, 0) / 3), warnings: extracted.warnings });
      } catch (error) {
        documentFailure = true;
        if (/Google Drive respondi[oó]/iu.test((error as Error).message)) driveFailure = true;
        if (/Falta pdfplumber/iu.test((error as Error).message)) dependencyFailure = true;
        if (format.kind === 'pdf') visionFailure = true;
        report.files.push({ id: entry.id, name: entry.name, status: 'excluido', sections: 0, tables: 0, tokens: 0, warnings: [(error as Error).message] });
      }
    }
    if (driveFailure) throw new Error('Google Drive no permitió leer todos los archivos; se conserva el corpus anterior');
    if (dependencyFailure) throw new Error('Falta pdfplumber para leer tablas PDF; se conserva el corpus anterior');
    if (visionFailure) throw new Error('No se pudo verificar visualmente un PDF; se conserva el corpus anterior');
    if (documentFailure) throw new Error('No se pudo procesar un documento; se conserva el corpus anterior');
    const corpus = createProtocolCorpus(accepted, options.maxTokens);
    if (corpus.id !== options.previous?.id) await options.save(corpus);
    report.versionId = corpus.id;
  } catch (error) {
    report.error = (error as Error).message;
  }
  return report;
}
