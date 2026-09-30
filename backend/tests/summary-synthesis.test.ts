import { describe, expect, it, vi } from 'vitest';
import { parseReportDraft, synthesizeGlobalReport, type ReportDraft } from '../summary-synthesis.ts';
import { generateBatchedGlobalSummary, SUMMARY_BATCH_CHARS } from '../global-summary-batches.ts';
import type { GroundedGroup } from '../summary-evidence.ts';
import { evidencePayload, evidenceResponse } from './summary-evidence-fixtures.ts';

const role = 'Agrupar siempre por obra. Obra Dana y Obra Pepe no se mezclan. Resumen general, Problemas detectados, Soluciones y decisiones tomadas, Pendientes, Cambios relevantes, Riesgos / bloqueos. Omitir conversaciones vecinales y apartados vacíos. No considerar solucionado un problema simplemente porque se haya hablado de él.';
const asOf = '2026-09-30T12:00:00Z';
const source = { id: 'F1', subject: 'Obra Dana', text: 'Dana: falta confirmar el material. Responsable y fecha no definidos.' };
const draft: ReportDraft = { entries: [{ subject: source.subject, section: 'Pendientes', text: source.text, sources: ['F1'] }], excluded: [] };

function group(name: string, texts: string[]): GroundedGroup {
  return { name, messageCount: texts.length,
    sources: texts.map((line, index) => ({ ref: `M${index}`, messageId: `${name}-${index}`, line, order: index })),
    findings: texts.map((text, index) => ({ kind: 'information', state: 'unknown', text, topicRef: null, evidence: [{ source: `M${index}`, quote: text }] })),
  };
}

describe('síntesis final guiada por el prompt del rol', () => {
  it('exige referencias, cobertura y aislamiento de entidades al consolidar', () => {
    expect(parseReportDraft(JSON.stringify(draft), [source], 'detail')).toEqual(draft);
    expect(() => parseReportDraft(JSON.stringify({ entries: [], excluded: [] }), [source], 'detail')).toThrow('Faltan asuntos');
    expect(() => parseReportDraft(JSON.stringify({ ...draft, entries: [{ ...draft.entries[0], sources: ['otra-cuenta'] }] }), [source], 'detail')).toThrow('desconocida');
    expect(() => parseReportDraft(JSON.stringify({ ...draft, entries: [...draft.entries, ...draft.entries] }), [source], 'detail')).toThrow('duplicada');
    expect(() => parseReportDraft(JSON.stringify({ ...draft, entries: [{ ...draft.entries[0], subject: 'Obra Pepe' }] }), [source], 'merge')).toThrow('entidad');
    expect(() => parseReportDraft(JSON.stringify({ entries: [], excluded: [{ source: 'F1', reason: 'routine' }] }), [source], 'merge')).toThrow('Exclusión');
  });

  it('consolida la misma obra entre chats, separa obras y excluye ruido con trazabilidad', async () => {
    const progress = vi.fn(async () => {});
    const calls: string[] = [];
    const report = await synthesizeGlobalReport([
      group('Coordinación', ['Obra Dana: falta confirmar el material.', 'Obra Pepe: Luis ejecutará el cambio el 2 de octubre.']),
      group('Compras', ['Obra Dana: material todavía pendiente de confirmar.', 'Vendo 40 dólares.']),
    ], role, asOf, async (prompt, _phase, validate) => {
      calls.push(prompt);
      expect(prompt).toContain(JSON.stringify(role));
      const data = evidencePayload(prompt);
      let result = evidenceResponse(prompt);
      if (data.mode === 'detail' && !data.draft) {
        result = { ...result, text: JSON.stringify({ entries: data.sources.filter((item: typeof source) => !item.text.startsWith('Vendo')).map((item: typeof source) => ({ subject: item.text.includes('Dana') ? 'Obra Dana' : 'Obra Pepe', section: 'Pendientes', text: item.text, sources: [item.id] })), excluded: data.sources.filter((item: typeof source) => item.text.startsWith('Vendo')).map((item: typeof source) => ({ source: item.id, reason: 'outside_scope' })) }) };
      }
      if (data.mode === 'merge' && !data.draft) result = { ...result, text: JSON.stringify({ entries: [{ subject: 'Obra Dana', section: 'Pendientes', text: 'Pendiente de confirmación: material. Responsable y fecha: No definido.', sources: data.sources.map((item: typeof source) => item.id) }], excluded: [] }) };
      validate(result.text);
      return result;
    }, progress);
    expect(report.text.match(/## Obra Dana/g)).toHaveLength(1);
    expect(report.text.match(/## Obra Pepe/g)).toHaveLength(1);
    expect(report.text).not.toMatch(/Vendo|Coordinación|Compras|HALLAZGOS|Problemas detectados/);
    expect(report.text).toContain('RESUMEN EJECUTIVO DEL PERIODO');
    expect(report.text).toContain('Responsable y fecha: No definido');
    expect(report.synthesis.entries.find((item) => item.subject === 'Obra Dana')?.sources).toEqual(['G1-F1', 'G2-F1']);
    expect(report.synthesis.excluded).toEqual([{ source: 'G2-F2', reason: 'outside_scope' }]);
    expect(calls.filter((prompt) => prompt.startsWith('ETAPA: AUDITORIA_SINTESIS')).length).toBe(calls.length / 2);
    expect(progress).toHaveBeenCalled();
  });

  it('reintenta una conclusión rechazada y no acepta un cierre sin evidencia', async () => {
    let audits = 0;
    const report = await synthesizeGlobalReport([group('Dana', [source.text])], role, asOf, async (prompt, _phase, validate) => {
      const data = evidencePayload(prompt);
      const result = data.draft && ++audits === 1 ? { ...evidenceResponse(prompt), text: JSON.stringify({ approved: false, issues: ['Hablar no demuestra que el problema esté solucionado'] }) } : evidenceResponse(prompt);
      if (!data.draft && audits === 1) expect(prompt).toContain('Hablar no demuestra');
      validate(result.text);
      return result;
    }, async () => {});
    expect(audits).toBeGreaterThan(1);
    expect(report.text).toContain('falta confirmar');
  });

  it('una auditoría inválida no convierte mensajes válidos en omitidos', async () => {
    const options = { cacheScope: 'rol-QA', systemPrompt: role, read: async () => null, write: async () => {}, progress: async () => {}, generate: vi.fn(async (prompt: string) => {
      const data = evidencePayload(prompt);
      if (data.draft) return { ...evidenceResponse(prompt), text: JSON.stringify({ approved: false, issues: ['Responsable inventado'] }) };
      if (!data.sources && !data.analysis) return { ...evidenceResponse(prompt), text: JSON.stringify({ findings: [{ kind: 'task', state: 'pending', text: source.text, topicRef: null, evidence: [{ source: data.primary[0].ref, quote: source.text }] }], informational: [] }) };
      return evidenceResponse(prompt);
    }) };
    await expect(generateBatchedGlobalSummary([{ name: 'Obra Dana', items: [{ id: 'valid', line: source.text }] }], options)).rejects.toThrow('síntesis final');
  });

  it('no impone obras a otro rol ni muestra apartados vacíos cuando no hay hallazgos', async () => {
    const invoke = vi.fn();
    const report = await synthesizeGlobalReport([group('Familia', [])], 'Resume avisos familiares.', asOf, invoke, async () => {});
    expect(invoke).not.toHaveBeenCalled();
    expect(report.text).toContain('No se identificaron asuntos relevantes');
    expect(report.text).not.toContain('OBRA');
  });

  it('conserva otro alcance configurado y agrupa repeticiones exactas con todas sus referencias', async () => {
    const familyRole = 'Resume acuerdos de la familia, sin estructura empresarial ni obras.';
    const report = await synthesizeGlobalReport([group('Familia', ['Ana recogerá a Luis el viernes.', 'Ana recogerá a Luis el viernes.'])], familyRole, asOf, async (prompt, _phase, validate) => {
      expect(prompt).toContain(JSON.stringify(familyRole));
      const result = evidenceResponse(prompt);
      validate(result.text);
      return result;
    }, async () => {});
    expect(report.synthesis.entries).toHaveLength(1);
    expect(report.synthesis.entries[0].sources).toEqual(['G1-F1', 'G1-F2']);
    expect(report.text).toContain('## Familia');
    expect(report.text).not.toContain('Obra');
  });

  it('un prompt excesivo falla antes de descartar mensajes', async () => {
    const generate = vi.fn();
    await expect(generateBatchedGlobalSummary([{ name: 'QA', items: [{ id: 'keep', line: 'texto' }] }], {
      generate, systemPrompt: 'x'.repeat(SUMMARY_BATCH_CHARS), cacheScope: 'QA', read: async () => null, write: async () => {}, progress: async () => {},
    })).rejects.toThrow('prompt del rol');
    expect(generate).not.toHaveBeenCalled();
  });
});
