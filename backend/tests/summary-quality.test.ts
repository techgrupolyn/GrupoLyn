import { describe, expect, it } from 'vitest';
import { entityKey, reportText, requestsWorkGrouping, workName } from '../summary-quality.ts';
import { parseReportDraft, synthesizeGlobalReport } from '../summary-synthesis.ts';
import type { GroundedGroup } from '../summary-evidence.ts';
import { evidencePayload, evidenceResponse } from './summary-evidence-fixtures.ts';

const role = 'Agrupar siempre por obra. No mezclar obras, ni convertir proveedores en obras. Consolidar estados y contradicciones con fechas.';

function group(name: string, texts: string[]): GroundedGroup {
  return { name, messageCount: texts.length,
    sources: texts.map((line, index) => ({ ref: `M${index}`, messageId: `${name}-${index}`, order: index, line: `2026-09-29T10:00:00Z - Laura: ${line}` })),
    findings: texts.map((text, index) => ({ text, kind: 'information', state: 'unknown', topicRef: null, evidence: [{ source: `M${index}`, quote: text }] })),
  };
}

describe('calidad del informe sin alterar las fuentes', () => {
  it('normaliza variantes tipográficas, no fusiona apellidos ni direcciones por semejanza', () => {
    expect(entityKey(workName('Obra Proyecto Rómulo'))).toBe(entityKey(workName('Proyecto Romulo')));
    expect(entityKey(workName('Obra Mar Jónica'))).toBe(entityKey(workName('Mar Jonica')));
    expect(entityKey(workName('Obra Patricia'))).not.toBe(entityKey(workName('Obra Patricia García')));
    expect(entityKey('Obra Peña')).not.toBe(entityKey('Obra Pena'));
    expect(requestsWorkGrouping(role)).toBe(true);
    expect(requestsWorkGrouping('Resume avisos familiares, sin estructura empresarial ni obras.')).toBe(false);
  });

  it('el ejecutivo no puede invertir actores ni convertir reclamaciones separadas en un rango', () => {
    for (const [text, changed] of [
      ['Grupo LYN denegó a la cliente el acceso anticipado.', 'La cliente denegó el acceso anticipado.'],
      ['Laura García restringió el acceso hasta el 02/10.', 'La propiedad restringió el acceso hasta el 02/10.'],
      ['Reclamaciones separadas: 285 € por trampilla y 1500 € por refuerzo.', 'Reclamación de 1500-1785 €.'],
    ]) {
      const source = { id: 'R1', subject: 'Obra QA', text };
      const draft = { entries: [{ subject: source.subject, section: 'Problemas', text, sources: ['R1'] }], excluded: [] };
      expect(parseReportDraft(JSON.stringify(draft), [source], 'overview')).toEqual(draft);
      draft.entries[0].text = changed;
      expect(() => parseReportDraft(JSON.stringify(draft), [source], 'overview')).toThrow('literal');
    }
  });

  it('rechaza cambiar metros a centímetros incluso antes del auditor', () => {
    const source = { id: 'F1', subject: 'Obra Dana', text: 'Isla de 1,80 m y reclamación de 1500 €.' };
    const draft = { entries: [{ subject: source.subject, section: 'Cambios', text: 'Isla de 1.80 cm y reclamación de 1500 €.', sources: ['F1'] }], excluded: [] };
    expect(() => parseReportDraft(JSON.stringify(draft), [source], 'merge')).toThrow('unidad');
    draft.entries[0].text = 'Isla de 1.80 m y reclamación de 1500 euros.';
    expect(parseReportDraft(JSON.stringify(draft), [source], 'merge').entries).toHaveLength(1);
    const wrongPreviousFinding = { ...source, text: 'Isla de 1.80 cm.', evidence: [{ quote: 'La isla mide 1.80 m.' }] };
    draft.entries[0].text = 'Isla de 1.80 cm.';
    expect(() => parseReportDraft(JSON.stringify(draft), [wrongPreviousFinding], 'detail')).toThrow('unidad');
  });

  it('no identifica al autor por el nombre del chat', () => {
    const source = { id: 'F1', group: 'Carpintero Beniel', text: 'Obra Patricia: rodapiés instalados.', evidence: [{ contextPrefix: '2026-09-29 - Laura: Obra Patricia: rodapiés instalados.' }] };
    const draft = { entries: [{ subject: 'Obra Patricia', section: 'Decisiones', text: 'Carpintero Beniel confirmó que se instalaron los rodapiés.', sources: ['F1'] }], excluded: [] };
    expect(() => parseReportDraft(JSON.stringify(draft), [source], 'detail')).toThrow('autoría');
  });

  it('recupera citas originales si el hallazgo anterior ya contenía una unidad errónea', async () => {
    const input = group('Obra Dana', ['Obra Dana: la isla mide 1.80 m.']);
    input.findings[0].text = 'Obra Dana: la isla mide 1.80 cm.';
    const report = await synthesizeGlobalReport([input], role, undefined, async (prompt, _phase, validate) => {
      const response = evidenceResponse(prompt);
      validate(response.text);
      return response;
    }, async () => {});
    expect(report.text).not.toContain('1.80 cm');
    expect(report.text).toContain('1.80 m');
    expect(report.text).toContain('Citas originales por revisar');
    expect(report.synthesis.entries.flatMap((entry) => entry.sources)).toContain('G1-F1');
  });

  it('conserva la avería si se rechaza presentar el pago como reparación', async () => {
    const original = 'Obra Catral: Willian paga la caja rota. La reparación no se ha ejecutado.';
    const report = await synthesizeGlobalReport([group('Obra Catral', [original])], role, undefined, async (prompt, _phase, validate) => {
      const data = evidencePayload(prompt);
      const response = evidenceResponse(prompt);
      if (data.mode === 'detail') response.text = JSON.stringify(data.draft ? { approved: false, issues: ['Asignar el coste no demuestra reparación.'] } : { entries: [{ subject: 'Obra Catral', section: 'Soluciones', text: 'Caja reparada; el coste se asignó a Willian.', sources: data.sources.map((source: { id: string }) => source.id) }], excluded: [] });
      validate(response.text);
      return response;
    }, async () => {});
    expect(report.text).not.toContain('Caja reparada');
    expect(report.text).toContain(original);
  });

  it('reúne la obra entre chats y entrega citas originales con fecha y autor al auditor de consolidación', async () => {
    let merged = false;
    let audited = false;
    const report = await synthesizeGlobalReport([
      group('Mediciones', ['Obra Rómulo: medición pendiente.']),
      group('Carpintero', ['Proyecto Romulo: medición realizada y confirmada.']),
    ], role, undefined, async (prompt, _phase, validate) => {
      const data = evidencePayload(prompt);
      let response = evidenceResponse(prompt);
      if (data.mode === 'detail' && !data.draft) response.text = JSON.stringify({ entries: data.sources.map((source: { id: string; text: string }) => ({ subject: source.text.startsWith('Obra') ? 'Obra Rómulo' : 'Proyecto Romulo', topic: 'medición', section: 'Estado', text: source.text, sources: [source.id] })), excluded: [] });
      if (data.mode === 'merge') {
        expect(data.sources).toHaveLength(2);
        expect(JSON.stringify(data.sources)).toContain('2026-09-29T10:00:00Z - Laura:');
        expect(data.sources.flatMap((source: { evidence: unknown[] }) => source.evidence)).toHaveLength(2);
        if (data.draft) audited = true;
        else {
          merged = true;
          response.text = JSON.stringify({ entries: [{ subject: 'Obra Rómulo', section: 'Estado por confirmar', text: 'La medición consta pendiente y realizada en mensajes sin secuencia temporal suficiente; confirmar si se trata de la misma medición.', sources: data.sources.map((source: { id: string }) => source.id) }], excluded: [] });
        }
      }
      validate(response.text);
      return response;
    }, async () => {});
    expect(merged && audited).toBe(true);
    expect(report.text.match(/## Obra Rómulo/g)).toHaveLength(1);
    expect(report.synthesis.entries[0].sources).toEqual(['G1-F1', 'G2-F1']);
  });

  it('no inventa una obra con el nombre de un proveedor ni pierde sus asuntos al rechazarla', async () => {
    const report = await synthesizeGlobalReport([group('Carpintero Beniel', ['Obra Patricia: puerta pendiente.', 'Obra Catral: marco entregado.'])], role, undefined, async (prompt, _phase, validate) => {
      const data = evidencePayload(prompt);
      const response = evidenceResponse(prompt);
      if (data.mode === 'detail' && !data.draft) {
        const draft = JSON.parse(response.text);
        draft.entries.forEach((entry: { subject: string }) => { entry.subject = 'Obra Carpintero Beniel'; });
        response.text = JSON.stringify(draft);
      }
      validate(response.text);
      return response;
    }, async () => {});
    expect(report.text).not.toContain('## Obra Carpintero');
    expect(report.text).toContain('Obra Patricia: puerta pendiente.');
    expect(report.text).toContain('Obra Catral: marco entregado.');
    expect(report.synthesis.recoveries.length).toBeGreaterThan(0);
  });

  it('no acepta una aprobación genérica sin comprobaciones de autoría y cronología', async () => {
    const report = await synthesizeGlobalReport([group('Obra Dana', ['Obra Dana: reparación pendiente.'])], role, undefined, async (prompt, _phase, validate) => {
      const response = evidenceResponse(prompt);
      if (evidencePayload(prompt).draft) response.text = JSON.stringify({ approved: true, issues: [] });
      validate(response.text);
      return response;
    }, async () => {});
    expect(report.synthesis.recoveries.some((recovery) => recovery.reason.includes('cronología'))).toBe(true);
    expect(report.text).toContain('reparación pendiente');
  });

  it('elimina duplicados exactos entre apartados sin perder trazabilidad', async () => {
    const report = await synthesizeGlobalReport([group('Obra Dana', ['Obra Dana: permiso pendiente.', 'Obra Dana: permiso pendiente.'])], role, undefined, async (prompt, _phase, validate) => {
      const response = evidenceResponse(prompt);
      if (evidencePayload(prompt).mode === 'detail' && !evidencePayload(prompt).draft) {
        const draft = JSON.parse(response.text);
        draft.entries[1].section = 'Riesgos';
        response.text = JSON.stringify(draft);
      }
      validate(response.text);
      return response;
    }, async () => {});
    expect(report.synthesis.entries).toHaveLength(1);
    expect(report.synthesis.entries[0].sources).toEqual(['G1-F1', 'G1-F2']);
  });

  it('oculta códigos de acceso y referencias internas solo en la salida pública', () => {
    const original = 'Candado: 8765. Código de acceso 4567. PIN=4321. Puerta de 180 cm; coste 285 €. [G8-F3]';
    const publicText = reportText(original);
    expect(publicText).not.toMatch(/8765|4567|4321|G8-F3/);
    expect(publicText).toContain('180 cm');
    expect(publicText).toContain('285 €');
    expect(original).toContain('8765');
  });
});
