import { describe, expect, it } from 'vitest';
import { deriveMeetingDate, deriveMeetingIdentity, formatMeetingName, manualActionResponsibleInput, meetingApprovalBlockers, meetingDirectoryFilterId, meetingEditorRoleRank, meetingListFilters, meetingListPagination, normalizeMeetingAiAnalysis, parseMeetingAiAnalysis, resolveMeetingActionTags, resolveMeetingDirectoryReferences, retainExplicitIncompleteActions } from '../server.ts';

describe('Flujo de aprobación de reuniones', () => {
  it('M-01: conserva compromisos distintos aunque compartan palabras y reconoce tenemos', () => {
    const analysis = normalizeMeetingAiAnalysis({ summary: 'QA', actions: [{ title: 'Mandar aviso a la comunidad de vecinos' }] });
    const retained = retainExplicitIncompleteActions('Tenemos que llamar a la comunidad de vecinos para avisar del ruido. No sé en cuál de las dos obras hace falta.', analysis.actions);
    expect(retained).toHaveLength(2);
    expect(retained[1]).toMatchObject({ projectUnresolved: true, projectName: null, responsible: null });
    expect(resolveMeetingActionTags([retained[1]], [], { projectName: 'FLORIDA 7' })[0].projectName).toBeNull();
  });

  it('A-03: no convierte una cuenta genérica ni un ID de IA sin nombre en responsable', () => {
    const candidates = [{ project_id: 'obra', project_name: 'Mirador 9', client_id: null, client_name: null, employee_id: 'visor', employee_name: 'Planos', employee_role: 'visor_planos', role_in_project: 'visor_planos' }];
    const analysis = normalizeMeetingAiAnalysis({ summary: 'QA', actions: [{ title: 'Mandar plano al cliente', responsible: 'Planos', responsible_id: 'visor' }, { title: 'Revisar plano', responsible_id: 'visor' }] });
    for (const action of resolveMeetingActionTags(analysis.actions, candidates)) {
      expect(action.responsibleId).toBeNull();
      expect(action.responsible).toBeNull();
    }
  });

  it('B-01: un ID primario vinculado cuenta igual que los adicionales', () => {
    expect(meetingApprovalBlockers([{ status: 'pending', responsible_id: 'persona-qa' }])).toEqual({ missingResponsible: 0, missingDueDate: 1 });
  });
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
  it('normaliza identificadores de filtros de directorio', () => {
    expect(meetingDirectoryFilterId([' proyecto-1 ', 'ignorar'])).toBe('proyecto-1');
    expect(meetingDirectoryFilterId('')).toBeNull();
    expect(meetingDirectoryFilterId('x'.repeat(300))).toHaveLength(255);
  });

  it('reconoce el orden de edición del organigrama', () => {
    expect(meetingEditorRoleRank('Delineante')).toBe(1);
    expect(meetingEditorRoleRank('PMC / Proyectos')).toBe(2);
    expect(meetingEditorRoleRank('Dirección de Operaciones')).toBe(3);
    expect(meetingEditorRoleRank('Director General')).toBe(4);
    expect(meetingEditorRoleRank('Director')).toBe(4);
    expect(meetingEditorRoleRank('Director de proyecto')).toBe(0);
    expect(meetingEditorRoleRank('Interiorista')).toBe(0);
  });

  it('acepta únicamente responsables manuales presentes en el directorio', () => {
    expect(manualActionResponsibleInput({ kind: 'employee', id: 'empleado-1' })).toEqual({ kind: 'employee', id: 'empleado-1' });
    expect(manualActionResponsibleInput({ kind: 'client', id: 'cliente-1' })).toEqual({ kind: 'client', id: 'cliente-1' });
    expect(manualActionResponsibleInput({ kind: 'subcontractor', id: 'sub-1' })).toBeNull();
    expect(manualActionResponsibleInput({ kind: 'employee', id: '' })).toBeNull();
  });
  it('bloquea solo acciones pendientes sin responsable y conserva la fecha como aviso opcional', () => {
    expect(meetingApprovalBlockers([
      { status: 'pending', responsible: '', due_date: null },
      { status: 'pending', responsible: 'Marta', due_date: null },
      { status: 'done', responsible: '', due_date: null },
    ])).toEqual({ missingResponsible: 2, missingDueDate: 2 });
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
    expect(deriveMeetingIdentity({ name: 'Comité de obra · Ático Albir', content_text: 'Obra: Ático Albir\nPMC: Laura M.' }).meetingKind).toBe('COMITE_OBRA');
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

  it('guarda información relevante separada de decisiones y acciones', () => {
    const analysis = normalizeMeetingAiAnalysis({
      summary: 'Resumen válido',
      relevant_information: ['El proveedor confirma la entrega el jueves [min 12:04]'],
      actions: [],
    });
    expect(analysis.relevantInformation).toEqual(['El proveedor confirma la entrega el jueves [min 12:04]']);
  });

  it('conserva compromisos explícitos aunque la IA no identifique obra ni responsable', () => {
    const actions = retainExplicitIncompleteActions('Alguien tiene que confirmar el presupuesto con el proveedor [min 08:15].', []);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ title: 'Confirmar el presupuesto con el proveedor', projectName: null, responsible: null, dueDate: null, sourceRef: 'min 08:15 — compromiso con obra, responsable o fecha pendientes de identificar' });
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
      employeeId: null, employeeRole: null, matchConfidence: 'high',
    });
    expect(resolveMeetingDirectoryReferences({ roleHint: 'Planimetristas Grupo LYN' }, candidates)).toMatchObject({
      employeeId: null, employeeRole: null, matchConfidence: null,
    });
  });
  it('hereda solo la obra de la reunión y no inventa responsables por PMC o rol', () => {
    const candidates = [
      { project_id: 'project-a', project_name: 'Villa Norte', client_id: 'client-a', client_name: 'Ana Cliente', employee_id: 'employee-a', employee_name: 'Laura PMC', employee_role: 'PMC', role_in_project: 'PMC' },
      { project_id: 'project-a', project_name: 'Villa Norte', client_id: 'client-a', client_name: 'Ana Cliente', employee_id: 'employee-c', employee_name: 'Marta Planos', employee_role: 'Planimetrista', role_in_project: 'Planimetrista' },
    ];
    const baseAction = { title: 'Actualizar planos', projectName: null, projectId: null, responsible: null, responsibleId: null, responsibleRole: null, matchConfidence: null, dueDate: null, estimatedMinutes: null, sourceRef: null, status: 'pending' as const };
    const [fallback, roleScoped] = resolveMeetingActionTags([
      baseAction,
      { ...baseAction, title: 'Revisar mediciones', responsible: 'Planimetrista', responsibleRole: 'Planimetrista' },
    ], candidates, { projectName: 'Villa Norte', pmcEmployeeId: 'employee-a' });

    expect(fallback).toMatchObject({ projectId: 'project-a', responsibleId: null, responsible: null });
    expect(roleScoped).toMatchObject({ projectId: 'project-a', responsibleId: null, responsible: null });
  });
  it('conserva las obras explícitas sin directorio y no atribuye una tarea multiobra ambigua', () => {
    const analysis = normalizeMeetingAiAnalysis({ summary: 'Comité multiobra', actions: [
      { title: 'Pedir carpintería', project_name: 'Torre del Cura' },
      { title: 'Enviar plano', project_name: 'Mirador 9' },
      { title: 'Llamar a la comunidad', source_ref: 'No sé en cuál de las dos obras hace falta' },
    ] });
    const resolved = resolveMeetingActionTags(analysis.actions, [], { projectName: 'Torre del Cura y Mirador 9' });
    expect(resolved.map((action) => action.projectName)).toEqual(['Torre del Cura', 'Mirador 9', null]);
    expect(resolved.every((action) => action.projectId === null)).toBe(true);
    expect(resolved[2].projectUnresolved).toBe(true);
  });
  it('no asigna obra a una tarea explícitamente ambigua aunque la IA proponga una', () => {
    const analysis = normalizeMeetingAiAnalysis({ summary: 'Resumen', actions: [{ title: 'Llamar a la comunidad', project_name: 'Villa Norte', project_id: 'project-a', source_ref: 'No sé en cuál de las dos obras hace falta' }] });
    const resolved = resolveMeetingActionTags(analysis.actions, [{ project_id: 'project-a', project_name: 'Villa Norte' }], { projectName: 'Villa Norte' });
    expect(resolved[0]).toMatchObject({ projectName: null, projectId: null, projectUnresolved: true });
  });
  it('rechaza fechas ISO inexistentes del análisis', () => {
    const analysis = normalizeMeetingAiAnalysis({ meeting_date: '2026-02-30', summary: 'Resumen válido', actions: [] });
    expect(analysis.meetingDate).toBeNull();
  });
  it('identifica el nombre corto de una obra con sufijo y rechaza abreviaturas ambiguas', () => {
    const projects = [{ project_id: 'torre-jose', project_name: 'TORRE DEL CURA - JOSE MOYA  ' }];
    expect(resolveMeetingDirectoryReferences({ projectName: 'Torre del Cura' }, projects).projectId).toBe('torre-jose');
    const ambiguous = [...projects, { project_id: 'torre-ana', project_name: 'TORRE DEL CURA - ANA' }];
    expect(resolveMeetingDirectoryReferences({ projectName: 'Torre del Cura' }, ambiguous).projectId).toBeNull();
    expect(resolveMeetingDirectoryReferences({ projectName: 'TORRE DEL CURA - JOSE MOYA' }, ambiguous).projectId).toBe('torre-jose');
    expect(resolveMeetingDirectoryReferences({ projectName: 'Torre' }, projects).projectId).toBeNull();
  });
  it('acepta JSON cercado de Gemini y exige un resumen para persistirlo', () => {
    const fence = String.fromCharCode(96).repeat(3);
    const response = fence + 'json\n{"summary":"Resumen válido","decisions":[],"actions":[],"blockers":[]}\n' + fence;
    expect(parseMeetingAiAnalysis(response)).toMatchObject({ summary: 'Resumen válido' });
    expect(parseMeetingAiAnalysis('{"summary":"","actions":[]}')).toBeNull();
  });

});
