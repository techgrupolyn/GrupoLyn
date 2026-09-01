import { describe, expect, it } from 'vitest';
import { deriveMeetingDate, deriveMeetingIdentity, formatMeetingName, meetingApprovalBlockers, meetingListFilters, meetingListPagination, normalizeMeetingAiAnalysis, parseMeetingAiAnalysis, resolveMeetingActionTags, resolveMeetingDirectoryReferences } from '../server.ts';

describe('Flujo de aprobación de reuniones', () => {
  it('normaliza límites de paginación para reuniones', () => {
    expect(meetingListPagination('0', '5')).toEqual({ page: 1, pageSize: 10, offset: 0 });
    expect(meetingListPagination('3', '500')).toEqual({ page: 3, pageSize: 100, offset: 200 });
  });

  it('normaliza filtros de fechas, períodos rápidos y orden', () => {
    expect(meetingListFilters('2026-07-01', '2026-07-31', '30', 'oldest')).toEqual({ dateFrom: '2026-07-01', dateTo: '2026-07-31', recentDays: 30, sort: 'oldest', error: null });
    expect(meetingListFilters('2026-07-31', '2026-07-01', '', 'recent').error).toContain('inicial');
    expect(meetingListFilters('2026-02-30', '', '', 'recent').error).toContain('calendario');
    expect(meetingListFilters('', '', '15', 'recent').error).toContain('7, 30 o 90');
  });
  it('bloquea solo acciones pendientes sin responsable y conserva la fecha como aviso opcional', () => {
    expect(meetingApprovalBlockers([
      { status: 'pending', responsible: '', due_date: null },
      { status: 'pending', responsible: 'Marta', due_date: null },
      { status: 'done', responsible: '', due_date: null },
    ])).toEqual({ missingResponsible: 1, missingDueDate: 2 });
  });
  it('acepta responsables vinculados múltiples aunque el texto principal esté vacío', () => {
    expect(meetingApprovalBlockers([
      { status: 'pending', responsible: '', due_date: null, responsibles: [{ employee_id: 'empleado-1' }] },
    ])).toEqual({ missingResponsible: 0, missingDueDate: 1 });
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
    expect(formatMeetingName(identity)).toBe('Comité de obra · Villajoyosa 12');
  });

  it('clasifica reunión de cliente y comité por su contexto operativo', () => {
    expect(deriveMeetingIdentity({ name: 'Seguimiento de obra', content_text: 'Obra: Ático Albir\nPMC: Laura M.' }).meetingKind).toBe('COMITE_OBRA');
    expect(deriveMeetingIdentity({ name: 'Entrevista con cliente', content_text: 'Obra: Ático Albir\nCliente: Javier R.' }).meetingKind).toBe('REUNION_CLIENTE');
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

  it('obtiene la fecha real de reunión desde el nombre y conserva referencias de minuto', () => {
    expect(deriveMeetingDate({ name: 'Comité de obra · 26/08/2026' })).toBe('2026-08-26');
    expect(deriveMeetingDate({ name: 'Reunión iniciada a las 2026/07/31 15:44 CEST - Notas de Gemini' })).toBe('2026-07-31');
    const analysis = normalizeMeetingAiAnalysis({ meeting_date: '2026-08-26', summary: 'Se confirma el ajuste [min 14:20]', decisions: ['Se actualiza el plano [min 14:20]'], actions: [] });
    expect(analysis).toMatchObject({ meetingDate: '2026-08-26', summary: 'Se confirma el ajuste [min 14:20]', decisions: ['Se actualiza el plano [min 14:20]'] });
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

  it('conserva IDs y confianza de etiquetas devueltas por la IA', () => {
    const analysis = normalizeMeetingAiAnalysis({
      summary: 'Resumen válido',
      actions: [{
        title: 'Actualizar el plano',
        project_id: 'f0a5c83a-b916-4b52-9724-66b0ed8e0af7',
        responsible_id: 'b30b7fc5-812a-4c5b-9d6d-d5cfe0bd1d4c',
        responsible_role: 'Planimetrista',
        match_confidence: 'high',
      }],
    });

    expect(analysis.actions[0]).toMatchObject({
      projectId: 'f0a5c83a-b916-4b52-9724-66b0ed8e0af7',
      responsibleId: 'b30b7fc5-812a-4c5b-9d6d-d5cfe0bd1d4c',
      responsibleRole: 'Planimetrista',
      matchConfidence: 'high',
    });
  });
  it('vincula solo referencias únicas y prioriza al responsable asignado al proyecto', () => {
    const candidates = [
      { project_id: 'project-a', project_name: 'Villa Norte', project_aliases: ['Obra histórica Norte'], client_id: 'client-a', client_name: 'Ana Cliente', employee_id: 'employee-a', employee_name: 'Laura PMC', employee_role: 'PMC', role_in_project: 'Directora de proyecto' },
      { project_id: 'project-b', project_name: 'Villa Sur', client_id: 'client-b', client_name: 'Berta Cliente', employee_id: 'employee-b', employee_name: 'Laura PMC', employee_role: 'PMC', role_in_project: 'PMC' },
      { project_id: 'project-a', project_name: 'Villa Norte', client_id: 'client-a', client_name: 'Ana Cliente', employee_id: 'employee-c', employee_name: 'Marta Planos', employee_role: 'Planimetrista', role_in_project: 'Planimetrista' },
    ];

    expect(resolveMeetingDirectoryReferences({ projectName: 'Villa Norte', clientName: 'Ana Cliente', employeeName: 'Laura PMC' }, candidates)).toMatchObject({
      projectId: 'project-a', clientId: 'client-a', employeeId: 'employee-a', employeeRole: 'Directora de proyecto', matchConfidence: 'high',
    });
    expect(resolveMeetingDirectoryReferences({ employeeName: 'Laura PMC' }, candidates)).toMatchObject({ employeeId: null, matchConfidence: null });    expect(resolveMeetingDirectoryReferences({ clientName: 'Ana Cliente' }, candidates)).toMatchObject({
      projectId: 'project-a', projectName: 'Villa Norte', clientId: 'client-a', matchConfidence: 'high',
    });
    expect(resolveMeetingDirectoryReferences({ source: 'Seguimiento de la obra Villa Norte con el equipo.' }, candidates)).toMatchObject({
      projectId: 'project-a', projectName: 'Villa Norte', matchConfidence: 'high',
    });
    expect(resolveMeetingDirectoryReferences({ projectName: 'Villa Norte', employeeName: 'Marta' }, candidates)).toMatchObject({
      employeeId: 'employee-c', employeeName: 'Marta Planos', matchConfidence: 'high',
    });
    expect(resolveMeetingDirectoryReferences({ projectName: 'Comité de obra · Villa Norte' }, candidates)).toMatchObject({
      projectId: 'project-a', projectName: 'Villa Norte', matchConfidence: 'high',
    });
    expect(resolveMeetingDirectoryReferences({ projectName: 'Obra histórica Norte' }, candidates)).toMatchObject({
      projectId: 'project-a', projectName: 'Villa Norte', matchConfidence: 'high',
    });
    expect(resolveMeetingDirectoryReferences({ projectName: 'Villa Norte', roleHint: 'Planimetristas Grupo LYN' }, candidates)).toMatchObject({
      employeeId: 'employee-c', employeeRole: 'Planimetrista', matchConfidence: 'high',
    });
    expect(resolveMeetingDirectoryReferences({ roleHint: 'Planimetristas Grupo LYN' }, candidates)).toMatchObject({
      employeeId: null, employeeRole: null, matchConfidence: null,
    });
  });
  it('hereda la obra y el PMC solo cuando la acción no propone una persona específica', () => {
    const candidates = [
      { project_id: 'project-a', project_name: 'Villa Norte', client_id: 'client-a', client_name: 'Ana Cliente', employee_id: 'employee-a', employee_name: 'Laura PMC', employee_role: 'PMC', role_in_project: 'PMC' },
      { project_id: 'project-a', project_name: 'Villa Norte', client_id: 'client-a', client_name: 'Ana Cliente', employee_id: 'employee-c', employee_name: 'Marta Planos', employee_role: 'Planimetrista', role_in_project: 'Planimetrista' },
    ];
    const baseAction = { title: 'Actualizar planos', projectName: null, projectId: null, responsible: null, responsibleId: null, responsibleRole: null, matchConfidence: null, dueDate: null, estimatedMinutes: null, sourceRef: null, status: 'pending' as const };
    const [fallback, roleScoped] = resolveMeetingActionTags([
      baseAction,
      { ...baseAction, title: 'Revisar mediciones', responsible: 'Planimetrista', responsibleRole: 'Planimetrista' },
    ], candidates, { projectName: 'Villa Norte', pmcEmployeeId: 'employee-a' });

    expect(fallback).toMatchObject({ projectId: 'project-a', responsibleId: 'employee-a', responsible: 'Laura PMC' });
    expect(roleScoped).toMatchObject({ projectId: 'project-a', responsibleId: 'employee-c', responsible: 'Marta Planos' });
  });
  it('rechaza fechas ISO inexistentes del análisis', () => {
    const analysis = normalizeMeetingAiAnalysis({ meeting_date: '2026-02-30', summary: 'Resumen válido', actions: [] });
    expect(analysis.meetingDate).toBeNull();
  });
  it('acepta JSON cercado de Gemini y exige un resumen para persistirlo', () => {
    const fence = String.fromCharCode(96).repeat(3);
    const response = fence + 'json\n{"summary":"Resumen válido","decisions":[],"actions":[],"blockers":[]}\n' + fence;
    expect(parseMeetingAiAnalysis(response)).toMatchObject({ summary: 'Resumen válido' });
    expect(parseMeetingAiAnalysis('{"summary":"","actions":[]}')).toBeNull();
  });

});
