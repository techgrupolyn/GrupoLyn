import { describe, expect, it, vi } from 'vitest';
import { generateBatchedGlobalSummary, splitSummaryInputs, SUMMARY_BATCH_CHARS, type SummaryProgress } from '../global-summary-batches.ts';
import { parseEvidenceAnalysis, renderGroundedSummary, validateEvidenceAudit, type EvidenceSource, type SummaryFinding } from '../summary-evidence.ts';
import type { GeminiExecutionResult } from '../geminiService.ts';
import { evidencePayload, evidenceResponse } from './summary-evidence-fixtures.ts';

function harness() {
  const cache = new Map<string, GeminiExecutionResult>();
  return {
    generate: vi.fn(async (prompt: string) => evidenceResponse(prompt)),
    read: vi.fn(async (key: string) => cache.get(key) || null),
    write: vi.fn(async (key: string, value: GeminiExecutionResult) => { cache.set(key, value); }),
    progress: vi.fn(async (_progress: SummaryProgress) => {}),
    wait: vi.fn(async () => {}), cacheScope: 'especialista-QA', cache,
  };
}
const source: EvidenceSource = { ref: 'G1-M1', messageId: 'original-1', line: 'Marta: No se aprobó el pago de 1200 euros de OBRA-23.', order: 0 };
const finding: SummaryFinding = { kind: 'information', state: 'unknown', text: 'El pago de 1200 euros de OBRA-23 no está aprobado.', topicRef: 'OBRA-23', evidence: [{ source: source.ref, quote: source.line }] };

describe('informes sin pérdida por compresión y con evidencias', () => {
  it('procesa y audita 20000 textos con peticiones acotadas y cobertura exacta', async () => {
    const options = harness();
    const groups = Array.from({ length: 10 }, (_, group) => ({ name: `Proyecto ${group}`, items: Array.from({ length: 2000 }, (_, index) => ({ line: `MSG${String(group * 2000 + index).padStart(5, '0')} ${'Texto sintético. '.repeat(15)}` })) }));
    const report = await generateBatchedGlobalSummary(groups, options);
    const primary = options.generate.mock.calls.filter(([prompt]) => prompt.startsWith('ETAPA: EXTRACCION')).flatMap(([prompt]) => evidencePayload(prompt).primary);
    expect(primary).toHaveLength(20000);
    expect(new Set(primary.map((item) => item.ref)).size).toBe(20000);
    expect(options.generate.mock.calls.every(([prompt]) => prompt.length <= SUMMARY_BATCH_CHARS)).toBe(true);
    expect(options.generate.mock.calls.filter(([prompt]) => prompt.startsWith('ETAPA: VERIFICACION')).length).toBe(options.generate.mock.calls.filter(([prompt]) => prompt.startsWith('ETAPA: EXTRACCION')).length);
    expect(report.text).toContain('REPORTE DEL CONTENIDO ANALIZADO');
    for (const group of groups) expect(report.text).toContain(`## ${group.name}`);
    expect(report.evidence.synthesis.kind).toBe('descriptive');
    expect(new Set(report.evidence.synthesis.entries.flatMap((entry) => entry.sources)).size).toBe(20000);
    const progress = options.progress.mock.calls.at(-1)![0];
    expect(progress.completedBatches).toBe(progress.totalBatches);
    expect(progress).toMatchObject({ completedMessages: 20000, totalMessages: 20000 });
    for (const [update] of options.progress.mock.calls) expect(update.totalMessages).toBe(20000);
  });

  it('conserva 20000 tareas distintas sin resumirlas a 6000 caracteres por grupo', async () => {
    const options = harness();
    options.generate.mockImplementation(async (prompt) => {
      const data = evidencePayload(prompt);
      if (data.sources) return evidenceResponse(prompt);
      if (data.analysis) return evidenceResponse(prompt);
      return { ...evidenceResponse(prompt), text: JSON.stringify({ findings: data.primary.map((item: EvidenceSource) => ({ ...finding, text: item.line, topicRef: null, kind: 'task', state: 'pending', evidence: [{ source: item.ref, quote: item.line }] })), informational: [] }) };
    });
    const groups = [{ name: 'Muchas tareas', items: Array.from({ length: 20000 }, (_, index) => ({ id: `id-${index}`, line: `Tarea ${index}: revisar el plano ${index}.` })) }];
    const report = await generateBatchedGlobalSummary(groups, options);
    expect(report.evidence.groups[0].findings).toHaveLength(20000);
    expect(report.text).toContain('Tarea 19999: revisar el plano 19999.');
    expect(report.evidence.groups[0].sources.at(-1)?.messageId).toBe('id-19999');
    expect(options.generate.mock.calls.every(([prompt]) => prompt.length <= SUMMARY_BATCH_CHARS)).toBe(true);
  });

  it('mantiene mensajes gigantes y pares Unicode completos', () => {
    const text = 'a'.repeat(SUMMARY_BATCH_CHARS - 1) + '😀'.repeat(SUMMARY_BATCH_CHARS * 2) + 'FINAL';
    const batches = splitSummaryInputs([text]);
    expect(batches.join('')).toBe(text);
    expect(batches.every((batch) => batch.length <= SUMMARY_BATCH_CHARS && !/[\uD800-\uDBFF]$/.test(batch))).toBe(true);
    expect(() => splitSummaryInputs(['test'], 0)).toThrow();
  });

  it('recupera extracción y auditoría guardadas tras una interrupción', async () => {
    const options = harness();
    const groups = [{ name: 'Grupo QA', items: Array.from({ length: 500 }, (_, index) => ({ line: `${index}: texto` })) }];
    let calls = 0;
    options.generate.mockImplementation(async (prompt) => { if (++calls === 3) throw new Error('Reinicio'); return evidenceResponse(prompt); });
    await expect(generateBatchedGlobalSummary(groups, options)).rejects.toThrow('Reinicio');
    expect(options.cache.size).toBe(2);
    const savedPrompts = options.generate.mock.calls.slice(0, 2).map(([prompt]) => prompt);
    options.generate.mockClear();
    await generateBatchedGlobalSummary(groups, options);
    expect(options.generate.mock.calls.some(([prompt]) => savedPrompts.includes(prompt))).toBe(false);
    options.generate.mockClear();
    await generateBatchedGlobalSummary(groups, options);
    expect(options.generate).not.toHaveBeenCalled();
  });

  it('subdivide lotes densos en vez de recortar hallazgos', async () => {
    const options = harness();
    options.generate.mockImplementation(async (prompt) => evidencePayload(prompt).primary?.length > 2 ? { ...evidenceResponse(prompt), text: '{JSON incompleto' } : evidenceResponse(prompt));
    const report = await generateBatchedGlobalSummary([{ name: 'QA', items: Array.from({ length: 8 }, (_, index) => ({ line: `Texto ${index}` })) }], options);
    expect(report.evidence.groups[0].messageCount).toBe(8);
    const progress = options.progress.mock.calls.at(-1)![0];
    expect(progress.completedBatches).toBe(4);
    expect(progress.totalBatches).toBe(4);
    expect(progress).toMatchObject({ completedMessages: 8, totalMessages: 8 });
    const counts = options.progress.mock.calls.map(([update]) => update.completedMessages);
    expect(counts.every((count, index) => index === 0 || count >= counts[index - 1])).toBe(true);
    expect(options.progress.mock.calls.every(([update]) => update.totalMessages === 8)).toBe(true);
  });

  it('el porcentaje solo cuenta mensajes enteros después de verificar todos sus fragmentos', async () => {
    const options = harness();
    const groups = [{ name: 'QA', items: [{ line: 'Texto largo '.repeat(5000) }, { line: 'Mensaje final' }] }];
    options.generate.mockImplementation(async (prompt) => {
      const latest = options.progress.mock.calls.at(-1)![0];
      expect(latest.completedMessages).toBe(evidencePayload(prompt).sources ? 2 : 0);
      expect(latest.totalMessages).toBe(2);
      return evidenceResponse(prompt);
    });
    await generateBatchedGlobalSummary(groups, options);
    expect(options.progress.mock.calls.at(-1)![0]).toMatchObject({ stage: 'consolidating', completedMessages: 2, totalMessages: 2 });
    options.generate.mockClear();
    options.progress.mockClear();
    await generateBatchedGlobalSummary(groups, options);
    expect(options.generate).not.toHaveBeenCalled();
    expect(options.progress.mock.calls.at(-1)![0].completedMessages).toBe(2);
  });

  it('rechaza citas inexistentes, otras cuentas/grupos, intervalos falsos y mensajes omitidos', () => {
    const valid = { findings: [finding], informational: [] };
    expect(parseEvidenceAnalysis(JSON.stringify(valid), [source])).toEqual(valid);
    for (const citation of [{ source: 'G2-M1', quote: source.line }, { source: source.ref, quote: 'Sí se aprobó el pago de 9000 euros' }]) {
      expect(() => parseEvidenceAnalysis(JSON.stringify({ ...valid, findings: [{ ...finding, evidence: [citation] }] }), [source])).toThrow();
    }
    expect(() => parseEvidenceAnalysis(JSON.stringify({ findings: [], informational: [] }), [source])).toThrow('sin revisar');
    expect(() => parseEvidenceAnalysis(JSON.stringify({ findings: [], informational: [['G1-M1', 'G1-M999']] }), [source])).toThrow('ajeno');
  });

  it('una negación invertida se rechaza y el mensaje aislado no verificable se omite explícitamente', async () => {
    expect(() => validateEvidenceAudit(JSON.stringify({ approved: [], rejected: [{ index: 0, reason: 'Negación invertida' }], missing: [] }), [finding])).toThrow();
    const options = harness();
    options.generate.mockImplementation(async (prompt) => prompt.startsWith('ETAPA: VERIFICACION') ? { ...evidenceResponse(prompt), text: JSON.stringify({ approved: [], rejected: [], missing: [{ source: 'G1-M1', reason: 'Se omitió la tarea' }] }) } : evidenceResponse(prompt));
    const result = await generateBatchedGlobalSummary([{ name: 'QA', items: [{ id: 'bad', line: 'Hay que pedir el plano' }] }], options);
    expect(result.skippedMessages).toEqual([{ messageId: 'bad', reason: 'insufficient_evidence' }]);
    expect(result.evidence.groups).toEqual([]);
    expect(result.text).toContain('No se identificaron asuntos relevantes');
    expect(result.text).toContain('MENSAJES OMITIDOS: 1');
    expect(options.progress.mock.calls.at(-1)![0]).toMatchObject({ completedMessages: 0, skippedMessages: 1, totalMessages: 1 });
  });

  it('aísla un mensaje inválido y verifica el resto sin incluirlo como contexto ni evidencia', async () => {
    const options = harness();
    options.generate.mockImplementation(async (prompt) => {
      const data = evidencePayload(prompt);
      if (data.sources) return evidenceResponse(prompt);
      return data.primary.some((item: EvidenceSource) => item.line === 'INVALIDO') ? { ...evidenceResponse(prompt), text: '{}' } : evidenceResponse(prompt);
    });
    const groups = [{ name: 'QA', items: Array.from({ length: 321 }, (_, index) => ({ id: `message-${index}`, line: index === 200 ? 'INVALIDO' : `Texto ${index}` })) }];
    const result = await generateBatchedGlobalSummary(groups, options);
    expect(result.skippedMessages).toEqual([{ messageId: 'message-200', reason: 'insufficient_evidence' }]);
    expect(result.evidence.groups[0].messageCount).toBe(320);
    expect(options.progress.mock.calls.at(-1)![0]).toMatchObject({ completedMessages: 320, skippedMessages: 1, totalMessages: 321 });
    const calls = options.generate.mock.calls;
    expect(calls.filter(([prompt]) => {
      const data = evidencePayload(prompt);
      return data.primary?.length === 160 && data.primary[0].ref === 'G1-M1';
    })).toHaveLength(2);
    const last = evidencePayload(calls.filter(([prompt]) => prompt.startsWith('ETAPA: VERIFICACION')).at(-1)![0]);
    expect([...last.primary, ...last.context].some((item: EvidenceSource) => item.line === 'INVALIDO')).toBe(false);
  });

  it('omite el mensaje completo si falla un fragmento y elimina sus hallazgos anteriores', async () => {
    const options = harness();
    options.generate.mockImplementation(async (prompt) => {
      const data = evidencePayload(prompt);
      if (data.sources) return evidenceResponse(prompt);
      if (data.primary.some((item: EvidenceSource) => item.ref === 'G1-M1-P5')) return { ...evidenceResponse(prompt), text: '{}' };
      if (data.analysis) return evidenceResponse(prompt);
      return { ...evidenceResponse(prompt), text: JSON.stringify({ findings: data.primary.map((item: EvidenceSource) => ({ ...finding, text: item.line.slice(0, 50), topicRef: null, evidence: [{ source: item.ref, quote: item.line.slice(0, 50) }] })), informational: [] }) };
    });
    const result = await generateBatchedGlobalSummary([{ name: 'QA', items: [{ id: 'giant', line: 'EXTENSO '.repeat(5000) }, { id: 'good', line: 'Revisar plano' }] }], options);
    expect(result.skippedMessages.map((item) => item.messageId)).toEqual(['giant']);
    expect(result.evidence.groups[0].sources.map((item) => item.messageId)).toEqual(['good']);
    expect(result.text).not.toContain('EXTENSO');
    expect(result.text).toContain('Revisar plano');
    expect(options.progress.mock.calls.at(-1)![0]).toMatchObject({ completedMessages: 1, skippedMessages: 1, totalMessages: 2 });
  });

  it.each([429, 503])('no descarta mensajes por fallos del proveedor (%s)', async (status) => {
    const options = harness();
    options.generate.mockRejectedValue(Object.assign(new Error('Proveedor indisponible'), { status }));
    await expect(generateBatchedGlobalSummary([{ name: 'QA', items: [{ id: 'pending', line: 'Texto' }] }], options)).rejects.toThrow('Proveedor indisponible');
    expect(options.generate).toHaveBeenCalledTimes(3);
    expect(options.progress.mock.calls.every(([update]) => update.skippedMessages === 0)).toBe(true);
  });

  it('conserva incertidumbres y secuencia de estados sin mezclar grupos', () => {
    const newer = { ...source, ref: 'G1-M2', messageId: 'original-2', line: 'Marta: Ya se aprobó el pago de 1200 euros de OBRA-23.', order: 1 };
    const next: SummaryFinding = { ...finding, state: 'completed', text: 'Se aprobó el pago de OBRA-23.', evidence: [{ source: newer.ref, quote: newer.line }] };
    const text = renderGroundedSummary([{ name: 'Primero', sources: [source, newer], findings: [finding, next], messageCount: 2 }, { name: 'Segundo', sources: [source], findings: [{ ...finding, kind: 'uncertain' }], messageCount: 1 }]);
    expect(text).toContain('Estado no confirmado');
    expect(text).toContain('Por confirmar');
    expect(text).toContain('no está aprobado');
    expect(text.split('## Segundo')[1]).not.toContain('Completado');
  });

  it('reintenta errores temporales sin aceptar fallback como verificación', async () => {
    const options = harness();
    options.generate.mockResolvedValueOnce({ text: 'local', provider: 'local-fallback', model: 'stub', fallback: true, retryable: true }).mockRejectedValueOnce(Object.assign(new Error('Temporal'), { status: 503 }));
    await generateBatchedGlobalSummary([{ name: 'QA', items: [{ line: 'Texto' }] }], options);
    expect(options.wait).toHaveBeenCalledTimes(2);
    expect(options.write).toHaveBeenCalledTimes(6);
  });

  it('cerrar una tarea no cierra las demás con la misma referencia de obra', () => {
    const task = { ...source, line: 'OBRA-23: Falta pedir el permiso.', order: 0 };
    const closure = { ...source, ref: 'G1-M2', line: 'OBRA-23: Ya envié el plano.', order: 1 };
    const text = renderGroundedSummary([{ name: 'Obra', sources: [task, closure], messageCount: 2, findings: [
      { ...finding, kind: 'task', state: 'pending', text: task.line, evidence: [{ source: task.ref, quote: task.line }] },
      { ...finding, kind: 'task', state: 'completed', text: closure.line, evidence: [{ source: closure.ref, quote: closure.line }] },
    ] }]);
    expect(text).toContain('Tarea · Pendiente: OBRA-23: Falta pedir el permiso.');
    expect(text).not.toContain('OBRA-23: Completado.');
    expect(text).toContain('no cierra otras tareas pendientes');
  });
});
