import { describe, expect, it } from 'vitest';
import { buildProjectSnapshot, designatedProjectSnapshot, resolveProjectResponsible, canReviewBranch, canSeeProjectBranch, type ProjectPosition, type ProjectPerson } from '../meeting-project-policy.ts';

const positions: ProjectPosition[] = [
  { id: 'low', name: 'Cargo inferior desde Club', parentId: 'empty', final: false, director: false },
  { id: 'empty', name: 'Cargo sin ocupar', parentId: 'pmc', final: false, director: false },
  { id: 'pmc', name: 'PMC', parentId: 'director', final: true, director: false },
  { id: 'director', name: 'Director', parentId: null, final: false, director: true },
];
const team: ProjectPerson[] = [{ id: 'drafter', name: 'Ana López', cargoIds: ['low'] }, { id: 'pmc', name: 'Pedro Pérez', cargoIds: ['pmc'] }];

describe('Política por obra, sin IA ni nombres de obras codificados', () => {
  it('ignora antiguos respaldos PMC y conserva exclusivamente los cargos de la obra', () => {
    const selection = { startCargoId: null, reviewers: {}, fallbackPmc: { employeeId: 'pmc', cargoId: 'pmc' } };
    const missing = designatedProjectSnapshot([team[0]], positions, selection);
    expect(missing.pmcId).toBeNull();
    expect(missing.issue).toBeNull();
    expect(missing.path).toMatchObject([{employeeId:'drafter',cargoId:'low',final:true}]);
    expect(missing.team).toEqual([team[0]]);
    const imported = [team[0], { id: 'new-pmc', name: 'Nuevo PMC', cargoIds: ['pmc'] }];
    expect(designatedProjectSnapshot(imported, positions, selection).pmcId).toBe('new-pmc');
    expect(designatedProjectSnapshot(team, positions, selection).team).toEqual(team);
  });
  it('consume la jerarquía, salta vacantes y termina en PMC', () => {
    const result = buildProjectSnapshot(team, positions);
    expect(result.issue).toBeNull();
    expect(result.path.map((step) => step.employeeId)).toEqual(['drafter','pmc']);
  });
  it('una obra sin cargo inferior llega directamente al PMC', () => {
    expect(buildProjectSnapshot([team[1]], positions).path.map((step) => step.employeeId)).toEqual(['pmc']);
  });
  it('sin PMC cierra el último cargo ocupado y mantiene la acción por asignar sin inventar responsable', () => {
    const snapshot = buildProjectSnapshot([team[0]], positions);
    expect(snapshot.issue).toBeNull();
    expect(snapshot.pmcId).toBeNull();
    expect(snapshot.path).toMatchObject([{employeeId:'drafter',cargoId:'low',cargo:'Cargo inferior desde Club',final:true}]);
    expect(resolveProjectResponsible(null, snapshot)).toEqual({ person: null, origin: 'unassigned' });
  });
  it('recorre los cargos ocupados sin PMC y solo el último aprueba definitivamente', () => {
    const snapshot = buildProjectSnapshot([team[0],{id:'middle',name:'Interiorista',cargoIds:['empty']}],positions);
    expect(snapshot.path.map(step=>[step.employeeId,step.final])).toEqual([['drafter',false],['middle',true]]);
    expect(snapshot.pmcId).toBeNull();
    expect(snapshot.team[1].cargoIds).toEqual(['empty']);
    expect(designatedProjectSnapshot(snapshot.team,positions,{startCargoId:'empty',reviewers:{}}).issue).toContain('no se pueden saltar');
  });
  it('admite un organigrama sin cargo PMC pero no cierra con Dirección ni con equipo vacío', () => {
    const standalone = [{id:'low',name:'Delineante',parentId:'director',director:false,final:false},positions[3]];
    expect(buildProjectSnapshot([team[0]],standalone)).toMatchObject({pmcId:null,issue:null,path:[{cargo:'Delineante',final:true}]});
    expect(designatedProjectSnapshot([team[0]],standalone,{startCargoId:'low',reviewers:{}}).issue).toBeNull();
    expect(buildProjectSnapshot([],positions).issue).toContain('Sin revisores');
    expect(buildProjectSnapshot([{id:'director',name:'Dirección',cargoIds:['director']}],positions).issue).toContain('Sin revisores');
  });
  it('mantiene empates y ciclos bloqueados cuando no hay PMC', () => {
    expect(buildProjectSnapshot([team[0],{...team[0],id:'other'}],positions).issue).toContain('Más de un revisor');
    expect(buildProjectSnapshot([team[0]],[{...positions[0],parentId:'low'}]).issue).toContain('Ciclo');
  });
  it('espera convergencia antes del cierre no PMC sin bloquear las revisiones inferiores', () => {
    const first = {id:'first',project_id:'first',cursor:0,approved:false,snapshot:buildProjectSnapshot([team[0]],positions)};
    const second = {id:'second',project_id:'second',cursor:0,approved:false,snapshot:buildProjectSnapshot([{...team[0],id:'other'},team[1]],positions)};
    expect(canReviewBranch(first,[first,second],'drafter')).toBe(false);
    expect(canReviewBranch(second,[first,second],'other')).toBe(true);
    second.cursor=1;
    expect(canReviewBranch(first,[first,second],'drafter')).toBe(true);
    expect(first.snapshot.pmcId).toBeNull();
  });
  it('solo reconoce nombres completos exactos y únicos dentro del proyecto', () => {
    const snapshot = buildProjectSnapshot(team, positions);
    expect(resolveProjectResponsible(' Ana López ', snapshot).origin).toBe('mentioned');
    for (const mention of ['Ana', 'Ana Lopez', 'Ana Lópe', 'Persona externa', null]) {
      expect(resolveProjectResponsible(mention, snapshot)).toMatchObject({ person: { id: 'pmc' }, origin: 'pmc_default' });
    }
    snapshot.team.push({ id: 'duplicate', name: 'Ana López', cargoIds: [] });
    expect(resolveProjectResponsible('Ana López', snapshot).origin).toBe('pmc_default');
  });
  it('no duplica la misma persona en cargos consecutivos', () => {
    const snapshot = buildProjectSnapshot([{ ...team[1], cargoIds: ['low','pmc'] }], positions);
    expect(snapshot.path).toHaveLength(1);
    expect(snapshot.path[0].final).toBe(true);
  });
  it('mantiene las ramas separadas y bloquea al PMC hasta que ambas lleguen', () => {
    const first = { id: 'a', project_id: 'obra-a', cursor: 0, approved: false, snapshot: buildProjectSnapshot(team, positions) };
    const second = { id: 'b', project_id: 'obra-b', cursor: 0, approved: false, snapshot: buildProjectSnapshot([{ ...team[0], id: 'other' }, team[1]], positions) };
    expect(canReviewBranch(first, [first,second], 'drafter')).toBe(true);
    expect(canSeeProjectBranch(second, [first,second], 'drafter')).toBe(false);
    expect(canSeeProjectBranch(first, [first,second], 'outsider')).toBe(false);
    first.cursor = 1;
    expect(canReviewBranch(first, [first,second], 'pmc')).toBe(false);
    expect(canSeeProjectBranch(first, [first,second], 'pmc')).toBe(false);
    second.cursor = 1;
    expect(canReviewBranch(first, [first,second], 'pmc')).toBe(true);
    expect(canSeeProjectBranch(first, [first,second], 'pmc')).toBe(true);
  });
  it('no elige arbitrariamente entre dos revisores del mismo cargo', () => {
    expect(buildProjectSnapshot([...team, { ...team[0], id: 'ambiguous' }], positions).issue).toContain('Más de un revisor');
  });
  it('elige al último asignado por cargo y obra, incluyendo PMC, aunque hubiera una designación anterior', () => {
    const members = [
      { ...team[0], assignedAt:{low:'2026-10-01T00:00:00Z'} },
      { ...team[1], assignedAt:{pmc:'2026-10-01T00:00:00Z'} },
      { ...team[0], id:'latest', assignedAt:{low:'2026-10-05T00:00:00Z'} },
      { ...team[1], id:'latest-pmc', assignedAt:{pmc:'2026-10-06T00:00:00Z'} },
    ];
    for (const ordered of [members,[...members].reverse()]) {
      const snapshot = designatedProjectSnapshot(ordered,positions,{startCargoId:'low',reviewers:{low:'drafter',pmc:'pmc'}});
      expect(snapshot.issue).toBeNull();
      expect(snapshot.path.map((step) => step.employeeId)).toEqual(['latest','latest-pmc']);
      expect(snapshot.team).toEqual(ordered);
      expect(buildProjectSnapshot(ordered,positions).pmcId).toBe('latest-pmc');
    }
  });
  it('no inventa orden con fechas ausentes, inválidas o empatadas; permite designación explícita', () => {
    for (const assigned of [null,'invalid','2026-10-01T00:00:00Z','2026-09-30T20:00:00-04:00']) {
      const members = [{ ...team[0], assignedAt:{low:'2026-10-01T00:00:00Z'} }, team[1], { ...team[0], id:'other', assignedAt:{low:assigned} }];
      expect(buildProjectSnapshot(members,positions).issue).toContain('Más de un revisor');
      expect(designatedProjectSnapshot(members,positions,{startCargoId:null,reviewers:{low:'other'}}).path[0].employeeId).toBe('other');
    }
  });
  it('respeta microsegundos de PostgreSQL y no crea empates al truncarlos a milisegundos', () => {
    const members = [team[1],{...team[0],assignedAt:{low:'2026-10-06T14:36:07.592148+00:00'}},{...team[0],id:'latest',assignedAt:{low:'2026-10-06T10:36:07.592149-04:00'}}];
    expect(buildProjectSnapshot(members,positions).path[0].employeeId).toBe('latest');
  });
  it('ignora ocupantes de cargos superiores al PMC y de otras ramas', () => {
    const extendedPositions = [...positions, { id: 'operations', name: 'Operaciones', parentId: 'director', final: false, director: false }];
    const extendedTeam = [...team, { id: 'ops-1', name: 'Operaciones uno', cargoIds: ['operations'] }, { id: 'ops-2', name: 'Operaciones dos', cargoIds: ['operations'] }];
    expect(buildProjectSnapshot(extendedTeam, extendedPositions).path.map((step) => step.employeeId)).toEqual(['drafter','pmc']);
    expect(buildProjectSnapshot(extendedTeam, extendedPositions).issue).toBeNull();
  });
  it('designa un revisor por cargo sin retirar la visibilidad al resto del equipo', () => {
    const members = [...team, { ...team[0], id: 'other' }, { ...team[1], id: 'other-pmc' }];
    const snapshot = designatedProjectSnapshot(members, positions, { startCargoId:'low',reviewers:{low:'drafter',pmc:'pmc'} });
    expect(snapshot.issue).toBeNull();
    expect(snapshot.path.map((step) => step.employeeId)).toEqual(['drafter','pmc']);
    expect(snapshot.team).toEqual(members);
    expect(designatedProjectSnapshot(members, positions, { startCargoId:'pmc',reviewers:{pmc:'pmc'} }).issue).toContain('no se pueden saltar');
  });
  it('reasigna lo pendiente si el designado ya no ocupa el cargo y hay sustituto inequívoco', () => {
    const members = [team[0], { ...team[1], id: 'replacement' }];
    const snapshot = designatedProjectSnapshot(members, positions, { startCargoId:'low',reviewers:{low:'drafter',pmc:'pmc'} });
    expect(snapshot.pmcId).toBe('replacement');
    expect(snapshot.issue).toBeNull();
    expect(designatedProjectSnapshot([...members,{...team[1],id:'second'}], positions, {startCargoId:'low',reviewers:{pmc:'pmc'}}).issue).toContain('Más de un PMC');
  });
});
