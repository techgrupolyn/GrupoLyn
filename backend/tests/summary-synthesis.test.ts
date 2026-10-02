import { describe, expect, it, vi } from 'vitest';
import { parseReportDraft, synthesizeGlobalReport, type ReportDraft, type SynthesisCheckpoint } from '../summary-synthesis.ts';
import { generateBatchedGlobalSummary, SUMMARY_BATCH_CHARS } from '../global-summary-batches.ts';
import type { GroundedGroup } from '../summary-evidence.ts';
import { evidencePayload, evidenceResponse } from './summary-evidence-fixtures.ts';
import { SummarySynthesisError } from '../summary-jobs.ts';

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
    expect(() => parseReportDraft(JSON.stringify({ ...draft, entries: [{ ...draft.entries[0], sources: ['F1', 'F1'] }] }), [source], 'detail')).toThrow('duplicada');
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
    const report = await generateBatchedGlobalSummary([{ name: 'Obra Dana', items: [{ id: 'valid', line: source.text }] }], options);
    expect(report.skippedMessages).toEqual([]);
    expect(report.text).toContain(source.text);
    expect(report.text).toContain('Asuntos verificados pendientes de agrupar');
    expect(report.evidence.synthesis.entries[0].text).toBe(source.text);
  });

  it('guarda el motivo, etapa y referencias cuando tampoco puede validar el detalle individual', async () => {
    const input = group('Dana', [source.text]);
    input.findings = [];
    const operation = synthesizeGlobalReport([input], role, asOf, async (prompt, _phase, validate) => {
      const data = evidencePayload(prompt);
      const response = data.draft ? { ...evidenceResponse(prompt), text: JSON.stringify({ approved: false, issues: ['No se ha confirmado el responsable'] }) } : evidenceResponse(prompt);
      validate(response.text);
      return response;
    }, async () => {});
    await expect(operation).rejects.toBeInstanceOf(SummarySynthesisError);
    await expect(operation).rejects.toMatchObject({ diagnostic: { code: 'synthesis_validation_failed', mode: 'describe', sources: ['M0'], reason: expect.stringContaining('No se ha confirmado el responsable') } });
  });

  it('el tercer intento repara con la propuesta rechazada y las observaciones del auditor', async () => {
    let audits = 0;
    let repaired = false;
    const result = await synthesizeGlobalReport([group('Dana', [source.text])], role, asOf, async (prompt, _phase, validate) => {
      const data = evidencePayload(prompt);
      let response = evidenceResponse(prompt);
      if (data.mode === 'detail' && data.draft && ++audits <= 2) response = { ...response, text: JSON.stringify({ approved: false, issues: ['Mantén el pendiente explícito'] }) };
      if (data.mode === 'detail' && !data.draft && audits === 2) {
        expect(prompt).toContain('PROPUESTA_RECHAZADA');
        expect(prompt).toContain('Mantén el pendiente explícito');
        repaired = true;
      }
      validate(response.text);
      return response;
    }, async () => {});
    expect(repaired).toBe(true);
    expect(result.text).toContain(source.text);
  });

  it('conserva todo el detalle validado si falla reformularlo o preparar la selección ejecutiva', async () => {
    const texts = ['Obra Dana: falta confirmar el material.', 'Obra Dana: Ana revisará los planos el viernes.'];
    const report = await synthesizeGlobalReport([group('Obra Dana', texts)], role, asOf, async (prompt, _phase, validate) => {
      const data = evidencePayload(prompt);
      let response = evidenceResponse(prompt);
      if (data.mode !== 'detail') response = { ...response, text: JSON.stringify(data.draft ? { approved: false, issues: ['La reformulación altera el estado'] } : { entries: data.sources.map((item: typeof source) => ({ subject: item.subject, section: 'Decisiones', text: 'Todo ejecutado y confirmado.', sources: [item.id] })), excluded: [] }) };
      validate(response.text);
      return response;
    }, async () => {});
    for (const text of texts) expect(report.text).toContain(text);
    expect(report.text).not.toContain('Todo ejecutado');
    expect(report.synthesis.entries.flatMap((entry) => entry.sources)).toEqual(['G1-F1', 'G1-F2']);
    expect(report.synthesis.overview).toEqual([]);
    expect(report.synthesis.recoveries.map((item) => item.mode)).toEqual(['merge', 'overview']);
    expect(report.text).toContain('detalle completo validado');
  });

  it('un error del proveedor al redactar no se disfraza como recuperación de validación', async () => {
    await expect(synthesizeGlobalReport([group('Dana', [source.text])], role, asOf, async (prompt, _phase, validate) => {
      if (evidencePayload(prompt).mode === 'overview') throw new Error('402 créditos agotados');
      const response = evidenceResponse(prompt);
      validate(response.text);
      return response;
    }, async () => {})).rejects.toThrow('402 créditos agotados');
  });

  it('una fuente puede sustentar asuntos distintos sin permitir exclusiones contradictorias ni referencias ajenas', () => {
    const entries = [draft.entries[0], { ...draft.entries[0], section: 'Problemas', text: 'El material sigue sin confirmación.' }];
    for (const mode of ['detail', 'merge', 'overview'] as const) {
      expect(parseReportDraft(JSON.stringify({ entries, excluded: [] }), [source], mode).entries).toHaveLength(2);
    }
    expect(() => parseReportDraft(JSON.stringify({ entries, excluded: [{ source: 'F1', reason: 'routine' }] }), [source], 'detail')).toThrow('representada');
    expect(() => parseReportDraft(JSON.stringify({ entries: [], excluded: [{ source: 'F1', reason: 'routine' }, { source: 'F1', reason: 'routine' }] }), [source], 'detail')).toThrow('previamente');
    expect(() => parseReportDraft(JSON.stringify({ entries: [{ ...entries[0], sources: ['ajena'] }], excluded: [] }), [source], 'detail')).toThrow('desconocida');
  });

  it('acota rechazos masivos sin perder hallazgos ni subdividir la consolidación por entidad', async () => {
    const texts = Array.from({ length: 500 }, (_, index) => `Obra Dana: pendiente ${index}, fecha sin confirmar.`);
    const calls = new Map<string, number>();
    const progress = vi.fn(async () => {});
    const result = await synthesizeGlobalReport([group('Obra Dana', texts)], role, asOf, async (prompt, _phase, validate) => {
      const data = evidencePayload(prompt);
      calls.set(data.mode, (calls.get(data.mode) || 0) + 1);
      const response = { ...evidenceResponse(prompt), text: JSON.stringify(data.draft ? { approved: false, issues: ['No se acredita el nuevo estado'] } : { entries: (data.mode === 'overview' ? data.sources.slice(0, 5) : data.sources).map((item: typeof source) => ({ subject: item.subject || 'Obra Dana', section: 'Decisiones', text: 'Todo ejecutado.', sources: [item.id] })), excluded: [] }) };
      validate(response.text);
      return response;
    }, progress);
    const groups = [group('Obra Dana', texts)];
    const serialized = JSON.stringify(groups).length;
    expect(calls.get('detail')).toBeLessThan(12 * (Math.ceil(serialized / 14000) + 2));
    expect(calls.get('merge') || 0).toBe(0);
    expect(calls.get('overview')).toBe(6);
    expect(result.text).not.toContain('Todo ejecutado.');
    expect(new Set(result.synthesis.entries.flatMap((entry) => entry.sources)).size).toBe(500);
    for (const text of texts) expect(result.text).toContain(text);
    expect(result.synthesis.overview).toEqual([]);
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ mode: 'detail', operation: 'retained', recoveredParts: expect.any(Number) }));
  });

  it('merge conserva todo un lote validado tras tres rechazos en vez de abrir un árbol por fuente', async () => {
    const texts = Array.from({ length: 40 }, (_, index) => `Obra Dana: pendiente ${index}.`);
    let mergeCalls = 0;
    const result = await synthesizeGlobalReport([group('Obra Dana', texts)], role, asOf, async (prompt, _phase, validate) => {
      const data = evidencePayload(prompt);
      let response = evidenceResponse(prompt);
      if (data.mode === 'merge') {
        mergeCalls++;
        response = { ...response, text: JSON.stringify({ entries: data.sources.map((item: typeof source) => ({ subject: 'Otra obra', section: 'Pendientes', text: item.text, sources: [item.id] })), excluded: [] }) };
      }
      validate(response.text);
      return response;
    }, async () => {});
    expect(mergeCalls).toBe(3);
    expect(result.synthesis.entries).toHaveLength(40);
    expect(result.text).not.toContain('Otra obra');
    expect(result.synthesis.recoveries.filter((item) => item.mode === 'merge')).toHaveLength(1);
  });

  it('reanuda árboles v3 antiguos sin nuevas llamadas de detalle en hojas profundas y conserva las aprobadas', async () => {
    const texts = Array.from({ length: 32 }, (_, index) => `Obra Dana: pendiente ${index}.`);
    const read = async (key: string): Promise<SynthesisCheckpoint | null> => {
      const [version, , mode, , sources] = JSON.parse(key);
      expect(version).toBe('synthesis-v3');
      if (mode !== 'detail') return null;
      if (sources.length > 1) return { kind: 'split' };
      if (sources[0].id === 'G1-F1') return { kind: 'validated', draft: { entries: [{ subject: 'Obra Dana', section: 'Pendientes', text: 'Obra Dana: pendiente 0, sin confirmación.', sources: ['G1-F1'] }], excluded: [] } };
      return null;
    };
    const invoke = vi.fn(async (prompt: string, _phase: unknown, validate: (text: string) => void) => {
      expect(evidencePayload(prompt).mode).not.toBe('detail');
      const response = evidenceResponse(prompt);
      validate(response.text);
      return response;
    });
    const result = await synthesizeGlobalReport([group('Obra Dana', texts)], role, asOf, invoke, async () => {}, async () => {}, { read, write: async () => {} });
    expect(result.text).toContain('pendiente 0, sin confirmación.');
    expect(new Set(result.synthesis.entries.flatMap((entry) => entry.sources)).size).toBe(32);
    expect(result.synthesis.recoveries.filter((item) => item.mode === 'detail')).toHaveLength(31);
  });

  it('las reglas de generación y auditoría delimitan cada etapa sin exigir un informe completo', async () => {
    const modes = new Set<string>();
    await synthesizeGlobalReport([group('Obra Dana', ['Dana: falta material.', 'Dana: falta permiso.'])], role, asOf, async (prompt, _phase, validate) => {
      const data = evidencePayload(prompt);
      modes.add(data.mode);
      expect(prompt).toContain(`ALCANCE_DE_ESTA_ETAPA (${data.mode})`);
      expect(prompt).toContain('No redactes ni exijas RESUMEN EJECUTIVO DEL PERIODO en detail, merge o describe');
      if (data.mode === 'merge') expect(prompt).toContain('Conserva literalmente subject');
      if (data.mode === 'overview') expect(prompt).toContain('No exijas repetir todos los detalles');
      const response = evidenceResponse(prompt);
      validate(response.text);
      return response;
    }, async () => {});
    expect([...modes]).toEqual(['detail', 'merge', 'overview']);
  });

  it('limita también las pasadas ejecutivas aunque cada reducción pequeña supere la auditoría', async () => {
    const texts = Array.from({ length: 400 }, (_, index) => `Asunto ${index}: ${'contenido verificado '.repeat(35)}`);
    let maximumLevel = 0;
    const report = await synthesizeGlobalReport([group('QA', texts)], role, asOf, async (prompt, _phase, validate) => {
      const data = evidencePayload(prompt);
      if (data.draft) {
        const response = evidenceResponse(prompt);
        validate(response.text);
        return response;
      }
      for (const item of data.sources) maximumLevel = Math.max(maximumLevel, Number(/^L(\d+)-/.exec(item.id)?.[1] || 0));
      const response = { ...evidenceResponse(prompt), text: JSON.stringify({ entries: (data.mode === 'overview' ? data.sources.slice(0, 10) : data.sources).map((item: typeof source) => ({ subject: item.subject || item.id, section: 'Pendientes', text: item.text.slice(0, data.mode === 'overview' ? 599 : 1800), sources: [item.id] })), excluded: [] }) };
      validate(response.text);
      return response;
    }, async () => {});
    expect(report.synthesis.entries).toHaveLength(400);
    expect(report.synthesis.overview).toEqual([]);
    expect(report.synthesis.recoveries.at(-1)?.reason).toContain('límite de pasadas');
    expect(maximumLevel).toBeGreaterThan(0);
  });

  it('reanuda 5656 textos sin repetir extracción ni síntesis aprobada y elimina borradores rechazados', async () => {
    const cache = new Map();
    const checkpoints = new Map<string, SynthesisCheckpoint>();
    const approvedPrompts = new Set<string>();
    let reject = true;
    const options = {
      systemPrompt: role, asOf, cacheScope: 'resume-5656',
      synthesis: { read: async (key: string) => checkpoints.get(key) || null, write: async (key: string, value: SynthesisCheckpoint) => { checkpoints.set(key, value); } },
      read: async (key: string) => cache.get(key) || null,
      write: async (key: string, value: unknown) => { cache.set(key, value); },
      remove: vi.fn(async (key: string) => { cache.delete(key); }),
      progress: vi.fn(async () => {}),
      generate: vi.fn(async (prompt: string) => {
        const data = evidencePayload(prompt);
        let response = evidenceResponse(prompt);
        const problem = data.mode === 'describe' && data.sources.some((item: typeof source) => item.text.includes('MSG05000'));
        if (reject && problem && data.draft) response = { ...response, text: JSON.stringify({ approved: false, issues: ['Conservar la incertidumbre de la fuente'] }) };
        if (reject && data.mode === 'describe' && !problem && !data.draft) approvedPrompts.add(prompt);
        return response;
      }),
    };
    const groups = [{ name: 'Obra Dana', items: Array.from({ length: 5656 }, (_, index) => ({ id: `qa-${index}`, line: `Obra Dana: MSG${String(index).padStart(5, '0')} pendiente de confirmar.` })) }];
    await expect(generateBatchedGlobalSummary(groups, options)).rejects.toBeInstanceOf(SummarySynthesisError);
    expect(options.remove).toHaveBeenCalled();
    expect(approvedPrompts.size).toBeGreaterThan(0);
    expect([...checkpoints.values()].some((value) => value.kind === 'split')).toBe(true);
    reject = false;
    options.generate.mockClear();
    const result = await generateBatchedGlobalSummary(groups, options);
    expect(options.generate.mock.calls.some(([prompt]) => /^ETAPA: (EXTRACCION|VERIFICACION)/.test(prompt))).toBe(false);
    expect(options.generate.mock.calls.some(([prompt]) => approvedPrompts.has(prompt))).toBe(false);
    expect(new Set(result.evidence.synthesis.entries.flatMap((entry) => entry.sources)).size).toBe(5656);
    expect(result.skippedMessages).toEqual([]);
  }, 30000);

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

  it('343 textos sin hallazgos del rol producen un reporte descriptivo con evidencia de todos los textos', async () => {
    const cache = new Map();
    const options = {
      systemPrompt: role, cacheScope: 'descriptive-QA', generate: vi.fn(async (prompt: string) => evidenceResponse(prompt)),
      read: async (key: string) => cache.get(key) || null, write: async (key: string, value: unknown) => { cache.set(key, value); }, progress: async () => {},
    };
    const groups = [{ name: 'Familia', items: Array.from({ length: 343 }, (_, index) => ({ id: `family-${index}`, line: `Saludo familiar ${index}.` })) }];
    const result = await generateBatchedGlobalSummary(groups, options);
    expect(result.text).toContain('REPORTE DEL CONTENIDO ANALIZADO');
    expect(result.text).toContain('## Familia');
    expect(result.evidence.synthesis).toMatchObject({ kind: 'descriptive', rolePrompt: role });
    expect(result.evidence.groups[0].findings).toEqual([]);
    expect(result.evidence.groups[0].sources).toHaveLength(343);
    expect(new Set(result.evidence.synthesis.entries.flatMap((entry) => entry.sources)).size).toBe(343);
    expect(result.skippedMessages).toEqual([]);
    expect(options.generate.mock.calls.filter(([prompt]) => evidencePayload(prompt).mode === 'describe').every(([prompt]) => !prompt.includes(JSON.stringify(role)))).toBe(true);
    options.generate.mockClear();
    await generateBatchedGlobalSummary(groups, options);
    expect(options.generate).not.toHaveBeenCalled();
  });

  it('una exclusión total en la síntesis del rol también activa descripción de los originales', async () => {
    const input = group('Ventas', ['Se ofrecen 40 dólares.']);
    const result = await synthesizeGlobalReport([input], role, asOf, async (prompt, phase, validate) => {
      const data = evidencePayload(prompt);
      const response = phase === 'synthesize' && data.mode === 'detail' ? { ...evidenceResponse(prompt), text: JSON.stringify({ entries: [], excluded: data.sources.map((source: { id: string }) => ({ source: source.id, reason: 'outside_scope' })) }) } : evidenceResponse(prompt);
      validate(response.text);
      return response;
    }, async () => {});
    expect(result.synthesis.kind).toBe('descriptive');
    expect(result.synthesis.entries[0].sources).toEqual(['M0']);
    expect(result.synthesis.excluded).toHaveLength(1);
    expect(result.text).toContain('## Ventas');
  });

  it('no admite un reporte descriptivo vacío, exclusiones ni cambio de grupo', () => {
    const original = { id: 'M1', group: 'Familia', text: 'Buenos días.' };
    expect(() => parseReportDraft(JSON.stringify({ entries: [], excluded: [{ source: 'M1', reason: 'routine' }] }), [original], 'describe')).toThrow('Exclusión');
    expect(() => parseReportDraft(JSON.stringify({ entries: [], excluded: [] }), [original], 'describe')).toThrow('Faltan');
    expect(() => parseReportDraft(JSON.stringify({ ...draft, entries: [{ ...draft.entries[0], sources: ['M1'] }] }), [original], 'describe')).toThrow('mezcló grupos');
  });
});
