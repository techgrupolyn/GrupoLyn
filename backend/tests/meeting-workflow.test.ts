import { describe, expect, it } from 'vitest';
import { deriveMeetingIdentity, formatMeetingName, meetingApprovalBlockers, normalizeMeetingAiAnalysis, parseMeetingAiAnalysis } from '../server.ts';

describe('Flujo de aprobación de reuniones', () => {
  it('bloquea solo acciones pendientes sin responsable o fecha', () => {
    expect(meetingApprovalBlockers([
      { status: 'pending', responsible: '', due_date: null },
      { status: 'pending', responsible: 'Marta', due_date: null },
      { status: 'done', responsible: '', due_date: null },
    ])).toEqual({ missingResponsible: 1, missingDueDate: 2 });
  });

  it('normaliza comité de obra e identifica PMC, obra y contacto desde la transcripción', () => {
    const identity = deriveMeetingIdentity({
      name: 'Comité de obra · Laura M.',
      content_text: 'PMC: Laura M.\nObra: Villajoyosa 12\nContacto: Marta S.',
    });

    expect(identity).toEqual({
      meetingKind: 'COMITE_OBRA',
      pmc: 'Laura M.',
      projectName: 'Villajoyosa 12',
      contactName: 'Marta S.',
    });
    expect(formatMeetingName(identity)).toBe('Comité de obra · Laura M.');
  });

  it('normaliza reunión cliente usando la obra como referencia', () => {
    const identity = deriveMeetingIdentity({
      name: 'Reunión cliente · Ático Albir',
      content_text: 'Cliente: Javier R.\nObra: Ático Albir',
    });

    expect(identity).toEqual({
      meetingKind: 'REUNION_CLIENTE',
      pmc: null,
      projectName: 'Ático Albir',
      contactName: 'Javier R.',
    });
    expect(formatMeetingName(identity)).toBe('Reunión cliente · Ático Albir');
  });


  it('detecta etiquetas de identidad con formato Markdown y variantes operativas', () => {
    const identity = deriveMeetingIdentity({
      name: 'Grabación semanal',
      content_text: '**PMC asignado:** Laura M.\n- Obra principal: Villajoyosa 12\nCliente entrevistado: Marta S.',
    });

    expect(identity).toEqual({
      meetingKind: 'REUNION_CLIENTE',
      pmc: 'Laura M.',
      projectName: 'Villajoyosa 12',
      contactName: 'Marta S.',
    });
  });

  it('normaliza la salida estructurada de IA sin aceptar fechas ambiguas ni acciones vacías', () => {
    const analysis = normalizeMeetingAiAnalysis({
      resumen: 'La obra avanza y queda pendiente confirmar la entrega de carpintería.',
      decisiones: ['Se mantiene el ajuste de planos.'],
      identity: { meeting_kind: 'COMITE_OBRA', pmc: 'Laura M.', project_name: 'Villajoyosa 12', contact_name: 'Marta S.' },
      actions: [
        { title: 'Reclamar fecha de entrega al proveedor', obra: 'Ático Albir', responsable: '', fecha_limite: '03/09/2026', evidence: 'Pendiente confirmar entrega.' },
        { title: '' },
      ],
      blockers: [{ title: 'Carpintería sin fecha confirmada', severidad: 'high', descripcion: 'Afecta el camino crítico.' }],
    });

    expect(analysis.meetingKind).toBe('COMITE_OBRA');
    expect(analysis.actions).toHaveLength(1);
    expect(analysis.actions[0]).toMatchObject({ projectName: 'Ático Albir', responsible: null, dueDate: null });
    expect(analysis.blockers[0]).toMatchObject({ severity: 'high', detail: 'Afecta el camino crítico.' });
  });

  it('acepta JSON cercado de Gemini y exige un resumen para persistirlo', () => {
    const fence = String.fromCharCode(96).repeat(3);
    const response = fence + 'json\n{"summary":"Resumen válido","decisions":[],"actions":[],"blockers":[]}\n' + fence;
    expect(parseMeetingAiAnalysis(response)).toMatchObject({ summary: 'Resumen válido' });
    expect(parseMeetingAiAnalysis('{"summary":"","actions":[]}')).toBeNull();
  });

});