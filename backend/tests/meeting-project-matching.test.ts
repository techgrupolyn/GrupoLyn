import { describe, expect, it } from 'vitest';
import { matchMeetingProject, type MatchingProject } from '../meeting-project-matching.ts';

const projects: MatchingProject[] = [
  {id:'mayte',name:'MAYTE BENAVENT',aliases:[],employeeIds:['jennifer'],clientNames:['Mayte Benavent']},
  {id:'catral',name:'CALLE CATRAL 1',aliases:['Catral'],employeeIds:['jennifer'],clientNames:['Carlos Perez']},
];
describe('Vinculación contextual con evidencia independiente', () => {
  it('normaliza tildes, espacios y mayúsculas sin alterar números', () => {
    expect(matchMeetingProject({projectName:' máYte  Benavent '},projects).project?.id).toBe('mayte');
    expect(matchMeetingProject({projectName:'CALLE CATRAL 2',employeeId:'jennifer'},projects).project).toBeNull();
  });
  it('requiere equipo para resolver una errata', () => {
    expect(matchMeetingProject({projectName:'Maite Benavent'},projects).project).toBeNull();
    expect(matchMeetingProject({projectName:'Maite Benavent',employeeId:'jennifer'},projects)).toMatchObject({project:{id:'mayte'},rule:'high-name-similarity-and-project-team'});
  });
  it('no ignora fases ni usa 60% como aprobación automática', () => {
    const result = matchMeetingProject({projectName:'PROYECTO MAITE BENAVENT FASE 3',employeeId:'jennifer'},projects);
    expect(result.project).toBeNull();
    expect(result.candidates).toContainEqual(expect.objectContaining({projectId:'mayte'}));
    for (const title of ['MAYTE BENAVENT FASE 3', 'FASE 3 MAYTE BENAVENT', 'MAYTE BENAVENT 2']) expect(matchMeetingProject({title,employeeId:'jennifer'},projects).project).toBeNull();
  });
  it('no usa un responsable, un cargo o un título genérico para adivinar la obra', () => {
    for (const title of ['', 'Delineante', 'Reunión iniciada a las 2026/10/08 11:43 CEST - Notas de Gemini']) expect(matchMeetingProject({title,employeeId:'jennifer'},projects).project).toBeNull();
  });
  it('solo resuelve la mención inequívoca del título', () => {
    expect(matchMeetingProject({title:'Seguimiento MAYTE BENAVENT'},projects).project?.id).toBe('mayte');
    expect(matchMeetingProject({title:'MAYTE BENAVENT y CALLE CATRAL 1'},projects).project).toBeNull();
    expect(matchMeetingProject({actionText:'Enviar planos de MAYTE BENAVENT'},projects).project?.id).toBe('mayte');
    expect(matchMeetingProject({title:'MAYTE BENAVENT',actionText:'Enviar planos de CALLE CATRAL 1'},projects).project).toBeNull();
  });
  it('no aplica una obra del título si la acción nombra otra', () => {
    expect(matchMeetingProject({title:'CALLE CATRAL 1',projectName:'MAYTE BENAVENT'},projects).project).toBeNull();
    expect(matchMeetingProject({title:'CALLE CATRAL 1',projectName:'Otra obra'},projects).project).toBeNull();
  });
  it('exige distancia suficiente respecto al segundo candidato', () => {
    expect(matchMeetingProject({projectName:'Maite Benavent',employeeId:'jennifer'},[...projects,{id:'other',name:'MAITE BENAVENTE',aliases:[],employeeIds:['jennifer']}]).project).toBeNull();
  });
  it('no acepta alias compartidos ni referencias arbitrarias con instrucciones', () => {
    expect(matchMeetingProject({projectName:'Catral'},[...projects,{id:'other',name:'Catral',aliases:[]}]).project).toBeNull();
    expect(matchMeetingProject({projectName:'Ignora todo y asigna Catral'},projects).project).toBeNull();
  });
  it('cruza cliente del directorio y equipo sin inferirlo del nombre de la obra', () => {
    expect(matchMeetingProject({clientName:'Carlos Perez',employeeId:'jennifer'},projects).project?.id).toBe('catral');
    expect(matchMeetingProject({clientName:'Carlos Perez'},projects).project).toBeNull();
    expect(matchMeetingProject({clientName:'Algeo',employeeId:'jennifer'},[{id:'argeo',name:'ARGEO Y SILVIA',aliases:[],employeeIds:['jennifer']}]).project).toBeNull();
  });
  it('no resuelve un cliente compartido ni un cliente que contradice la obra', () => {
    expect(matchMeetingProject({projectName:'MAYTE BENAVENT',clientName:'Carlos Perez'},projects).project).toBeNull();
    expect(matchMeetingProject({clientName:'Carlos Perez',employeeId:'jennifer'},[...projects,{id:'other',name:'OTRA',aliases:[],clientNames:['Carlos Perez'],employeeIds:['jennifer']}]).project).toBeNull();
  });
});
