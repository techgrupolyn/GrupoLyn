import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { askProtocolAgent, type ProtocolLog } from '../protocol-agent.ts';
import { createProtocolCorpus, type ProtocolFile } from '../protocol-corpus.ts';
import { callProtocolGemini, transcribeProtocolTable } from '../protocol-gemini.ts';
import { protocolCorpusPrompt } from '../protocol-corpus.ts';
import { applyProtocolVision, protocolTableColumnCount, type ProtocolVisionPage } from '../protocol-vision.ts';
import { protocolQaCases } from './protocol-qa-cases.ts';

const directory = process.env.PROTOCOL_QA_DOC_DIR;
const environmentFile = process.env.PROTOCOL_QA_ENV_FILE;
const python = process.env.PROTOCOL_QA_PYTHON || 'python3';
const limit = Number(process.env.PROTOCOL_QA_LIMIT || protocolQaCases.length);
const startIndex = Number(process.env.PROTOCOL_QA_START || 0);
const paceMs = Number(process.env.PROTOCOL_QA_PACE_MS || 0);
const visionPage = Number(process.env.PROTOCOL_QA_VISION_PAGE || 0);
const visionFile = process.env.PROTOCOL_QA_VISION_FILE || 'Proceso_Diseno_';
const visionAll = process.env.PROTOCOL_QA_VISION_ALL === '1';
const visionCacheDirectory = process.env.PROTOCOL_QA_VISION_CACHE_DIR || '';
const visionRejectDirectory = process.env.PROTOCOL_QA_VISION_REJECT_DIR || '';
const qaReportFile = process.env.PROTOCOL_QA_REPORT_FILE || '';

if (!directory || !environmentFile || !Number.isSafeInteger(limit) || limit < 1 || limit > protocolQaCases.length || !Number.isSafeInteger(startIndex) || startIndex < 0 || startIndex >= protocolQaCases.length || !Number.isSafeInteger(paceMs) || paceMs < 0) {
  throw new Error('Configura PROTOCOL_QA_DOC_DIR, PROTOCOL_QA_ENV_FILE y un límite válido');
}

const environment = await readFile(environmentFile, 'utf8');
const keyLine = environment.split(/\r?\n/u).find(line => /^\s*(GOOGLE_GEMINI_API_KEY|GOOGLE_API_KEY)\s*=/u.test(line));
const apiKey = keyLine?.split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/gu, '');
if (!apiKey) throw new Error('Falta la clave Gemini local');

const extractor = fileURLToPath(new URL('../protocol-extract.py', import.meta.url));
const files: ProtocolFile[] = [];
let visionDone = false;
for (const name of (await readdir(directory)).sort()) {
  const kind = name.toLowerCase().endsWith('.pdf') ? 'pdf' : name.toLowerCase().endsWith('.pptx') ? 'pptx' : null;
  if (!kind) continue;
  const source = await readFile(join(directory, name));
  const parsed = await new Promise<{ sections: ProtocolFile['sections']; warnings: string[]; visionPages?: ProtocolVisionPage[] }>((resolve, reject) => {
    const child = spawn(python, [extractor, kind], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let error = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) reject(new Error(`${basename(name)}: ${error || output.slice(0, 300)}`));
      else {
        try { resolve(JSON.parse(output)); }
        catch { reject(new Error(`${basename(name)}: extractor devolvió JSON inválido`)); }
      }
    });
    child.stdin.end(source);
  });
  if ((visionPage || visionAll) && name.includes(visionFile)) {
    const targets = visionAll ? parsed.visionPages || [] : parsed.visionPages?.filter(page => page.ref.endsWith(` ${visionPage}`)) || [];
    if (!targets.length) throw new Error('No hay páginas de tabla visual para la prueba');
    if (visionCacheDirectory) await mkdir(visionCacheDirectory, { recursive: true });
    for (const target of targets) {
      const image = Buffer.from(target.image, 'base64');
      const hash = createHash('sha256').update(image).digest('hex');
      const cachePath = visionCacheDirectory ? join(visionCacheDirectory, `${hash}.json`) : '';
      const cached = cachePath ? await readFile(cachePath, 'utf8').then(value => JSON.parse(value) as { markdown: string }).catch(() => null) : null;
      let generated = '';
      const sourceText = parsed.sections.find(section => section.ref === target.ref)?.text || '';
      const expectedColumns = protocolTableColumnCount(sourceText) || undefined;
      const transcribe = async () => {
        generated = await transcribeProtocolTable(image, { apiKey, expectedColumns, structuredRows: process.env.PROTOCOL_QA_VISION_STRUCTURED === '1' });
        return generated;
      };
      let result;
      try {
        result = await applyProtocolVision(parsed.sections, [target], async () => cached?.markdown || transcribe());
        if (cached?.markdown && !result.sections.some(section => section.ref === target.ref)) {
          await transcribe();
          result = await applyProtocolVision(parsed.sections, [target], async () => generated);
        }
      } catch (error) {
        console.error(JSON.stringify({ phase: 'vision_error', page: target.ref, error: error instanceof Error ? error.message : 'Modelo no disponible' }));
        visionDone = true;
        break;
      }
      const accepted = result.sections.some(section => section.ref === target.ref);
      if (accepted && generated && cachePath) await writeFile(cachePath, JSON.stringify({ markdown: generated }));
      if (!accepted && generated && visionRejectDirectory) {
        await mkdir(visionRejectDirectory, { recursive: true });
        await writeFile(join(visionRejectDirectory, `${hash}.json`), JSON.stringify({ page: target.ref, markdown: generated }));
      }
      console.log(JSON.stringify({ phase: 'vision', page: target.ref, accepted, cached: Boolean(cached), warnings: result.warnings }));
    }
    visionDone = true;
    break;
  }
  if (!visionPage && !visionAll && visionCacheDirectory && parsed.visionPages?.length) {
    const vision = await applyProtocolVision(parsed.sections, parsed.visionPages, async (image, page) => {
      const hash = createHash('sha256').update(image).digest('hex');
      const cachePath = join(visionCacheDirectory, `${hash}.json`);
      const cached = await readFile(cachePath, 'utf8').then(value => JSON.parse(value) as { markdown: string }).catch(() => null);
      if (!cached?.markdown) throw new Error(`${page.ref}: falta transcripción visual verificada`);
      return cached.markdown;
    });
    if (vision.warnings.length) throw new Error(`${basename(name)}: ${vision.warnings.join('; ')}`);
    parsed.sections = vision.sections;
  }
  if (!parsed.sections.length) throw new Error(`${basename(name)}: no contiene secciones`);
  files.push({ id: `DOC${files.length + 1}`, name, mimeType: kind === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.presentationml.presentation', modifiedTime: '2026-10-27', revision: 'evaluacion-local', sections: parsed.sections, warnings: parsed.warnings });
}
if (!visionDone) {
if (files.length !== 7) throw new Error(`Se esperaban siete archivos y hay ${files.length}`);
const corpus = createProtocolCorpus(files, 100_000);
console.log(JSON.stringify({ phase: 'corpus', files: files.length, sections: files.reduce((total, file) => total + file.sections.length, 0), tokensEstimate: corpus.tokenEstimate }));
if (process.env.PROTOCOL_QA_DRY_RUN === '1') {
  for (const [index, testCase] of protocolQaCases.entries()) {
    const context = protocolCorpusPrompt(corpus);
    console.log(JSON.stringify({ phase: 'retrieval', index: index + 1, category: testCase.category, tokensEstimate: Math.ceil(context.length / 3), documentCount: (context.match(/<documento /gu) || []).length, sectionCount: (context.match(/<seccion /gu) || []).length }));
  }
  process.exit(0);
}

const outcomes: Array<{ category: string; expected: string; classification: string; validation: string; sources: number; reason: string | null; semanticPass: boolean; modelCalls: number }> = [];
const detailedOutcomes: Array<Record<string, unknown>> = [];
const factualMarkers = [
  ['viernes'], ['viernes'], ['30'], ['interiorista'], ['interiorista', 'planimetrista', 'primero'],
  ['pmc'], ['club lyn'], ['pmc', 'revis'], ['pmc'], ['revis', 'sub'],
  ['responsable'], ['responsable', 'subcontrata'], ['aprobacion', 'fabricacion', 'transporte', 'recepcion'], ['fabricacion'], ['recepcion'],
];
function semanticMatch(index: number, answer: string, reason: string | null, sources: number, contradiction: unknown): boolean {
  const normalized = answer.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').toLowerCase();
  if (index === 6) return normalized.includes('club lyn') && normalized.indexOf('revisa') >= 0 && normalized.indexOf('sube') > normalized.indexOf('revisa');
  if (index < factualMarkers.length) return factualMarkers[index].every(marker => normalized.includes(marker));
  if (index < 20) return reason === 'sin_protocolo' && sources === 0 && normalized.includes('no encuentro');
  if (index < 23) return normalized.includes('no esperes') && normalized.includes('112');
  return Boolean(contradiction) && sources >= 2;
}
let providerUnavailable = false;
for (const [index, testCase] of protocolQaCases.slice(startIndex, startIndex + limit).entries()) {
  if (index > 0 && paceMs) await delay(paceMs);
  const logs: ProtocolLog[] = [];
  let modelCalls = 0;
  const result = await askProtocolAgent({ userId: 1, role: 'PMC', question: testCase.question, channel: 'superagente' }, {
    loadCorpus: async () => corpus,
    clientNames: async () => [],
    roles: async () => [{ name: 'PMC' }, { name: 'Operaciones' }, { name: 'Dirección' }],
    generate: async (system, user) => {
      modelCalls += 1;
      const generated = await callProtocolGemini(system, user, {
        apiKey,
        fetcher: async (input, init) => {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            let response: Response;
            try {
              response = await fetch(input, { ...init, signal: AbortSignal.timeout(60_000) });
            } catch (error) {
              console.error(JSON.stringify({ phase: 'model_network', name: error instanceof Error ? error.name : 'unknown', code: error instanceof Error && error.cause && typeof error.cause === 'object' && 'code' in error.cause ? String(error.cause.code) : null }));
              throw error;
            }
            if (response.ok) {
              const payload = await response.clone().json().catch(() => null) as Record<string, unknown> | null;
              if (payload?.status === 'incomplete' || (!payload?.output_text && !payload?.outputText && !payload?.steps)) {
                console.error(JSON.stringify({ phase: 'model_payload', status: payload?.status || 'sin_salida', incompleteReason: typeof payload?.incomplete_details === 'object' && payload.incomplete_details !== null ? (payload.incomplete_details as Record<string, unknown>).reason : null }));
              }
              return response;
            }
            const errorPayload = await response.clone().json().catch(() => null) as { error?: { status?: string; details?: Array<{ '@type'?: string; retryDelay?: string; violations?: Array<{ quotaId?: string }> }> } } | null;
            const retryAfter = response.headers.get('retry-after') || errorPayload?.error?.details?.find(detail => detail.retryDelay)?.retryDelay || null;
            console.error(JSON.stringify({ phase: 'model_http', status: response.status, attempt: attempt + 1, errorStatus: errorPayload?.error?.status || null, retryAfter, quotaIds: errorPayload?.error?.details?.flatMap(detail => detail.violations?.map(violation => violation.quotaId) || []).filter(Boolean) || [] }));
            if (![429, 503].includes(response.status) || attempt === 2 || (retryAfter && Number.parseInt(retryAfter, 10) > 120)) {
              providerUnavailable = true;
              return response;
            }
            await delay((attempt + 1) * 30_000);
          }
          throw new Error('Proveedor no disponible');
        },
      });
      return generated;
    },
    save: async log => { logs.push(log); },
  });
  const outcome = { category: testCase.category, expected: testCase.expected, classification: result.classification, validation: result.validation, sources: result.sources.length, reason: logs[0]?.reason ?? null, failure: logs[0]?.error ?? null, semanticPass: semanticMatch(startIndex + index, result.answer, logs[0]?.reason ?? null, result.sources.length, result.contradiction), modelCalls };
  outcomes.push(outcome);
  detailedOutcomes.push({ index: startIndex + index + 1, question: testCase.question, answer: result.answer, sourceDetails: result.sources, contradiction: result.contradiction, ...outcome });
  console.log(JSON.stringify({ phase: 'case', index: startIndex + index + 1, ...outcome }));
  if (providerUnavailable) break;
}
const matches = outcomes.filter(item => item.classification === item.expected && item.validation !== 'rechazada').length;
console.log(JSON.stringify({ phase: 'summary', total: outcomes.length, matches, semanticMatches: outcomes.filter(item => item.validation !== 'rechazada' && item.semanticPass).length, modelCalls: outcomes.reduce((total, item) => total + item.modelCalls, 0), rejected: outcomes.filter(item => item.validation === 'rechazada').length }));
if (qaReportFile) await writeFile(qaReportFile, JSON.stringify(detailedOutcomes, null, 2));
}
