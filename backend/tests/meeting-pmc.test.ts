import { describe, expect, it } from 'vitest';
import { resolveMeetingPmcReferences, resolveMeetingDirectoryReferences } from '../server.ts';
import type { MeetingDirectoryCandidate } from '../supabase-directory.ts';

const assignment: MeetingDirectoryCandidate = {
  project_id: 'obra-1', project_name: 'Obra Uno', client_id: null, client_name: null,
  employee_id: 'pmc-1', employee_name: 'Laura Ejemplo', employee_role: 'PMC',
  role_in_project: 'pmc', project_assignment: true,
};

describe('PMC de la reunión desde el proyecto de Club LYN', () => {
  it('resuelve el PMC vinculado sin necesitar su nombre en la transcripción', () => {
    expect(resolveMeetingPmcReferences({ projectName: 'Obra Uno' }, [assignment])).toMatchObject({ employeeId: 'pmc-1', employeeName: 'Laura Ejemplo', matchConfidence: 'high' });
    expect(resolveMeetingDirectoryReferences({ projectName: 'Obra Uno' }, [assignment]).employeeId).toBeNull();
  });

  it('prioriza el proyecto vinculado por ID frente a nombres coincidentes', () => {
    const other = { ...assignment, project_id: 'obra-2', employee_id: 'pmc-2' };
    expect(resolveMeetingPmcReferences({ projectId: 'obra-1', projectName: 'Obra Uno' }, [assignment, other]).employeeId).toBe('pmc-1');
    expect(resolveMeetingPmcReferences({ projectName: 'Obra Uno' }, [assignment, other]).employeeId).toBeNull();
  });

  it('no usa cargos globales, otros roles ni PMC de otro proyecto', () => {
    const candidates = [{ ...assignment, project_assignment: false },
      { ...assignment, employee_id: 'interiorista', role_in_project: 'interiorista' },
      { ...assignment, project_id: 'obra-2', project_name: 'Obra Dos' }];
    expect(resolveMeetingPmcReferences({ projectName: 'Obra Uno' }, candidates).employeeId).toBeNull();
  });

  it('no elige arbitrariamente entre dos PMC pero deduplica la misma persona', () => {
    expect(resolveMeetingPmcReferences({ projectName: 'Obra Uno' }, [assignment, { ...assignment, employee_id: 'otro' }]).employeeId).toBeNull();
    expect(resolveMeetingPmcReferences({ projectName: 'Obra Uno' }, [assignment, assignment]).employeeId).toBe('pmc-1');
  });

  it('conserva nombres explícitos aunque no se puedan resolver en el directorio', () => {
    expect(resolveMeetingPmcReferences({ projectName: 'Obra Uno', employeeName: 'Persona manual' }, [assignment]).employeeId).toBeNull();
  });

  it.each(['delineante', 'Delineante', 'planimetrista', 'Planimetrista'])('usa un único %s del proyecto como PMC en prácticas', (role) => {
    const trainee = { ...assignment, role_in_project: role };
    expect(resolveMeetingPmcReferences({ projectName: 'Obra Uno' }, [trainee, trainee])).toMatchObject({ employeeId: 'pmc-1', pmcInTraining: true });
    expect(resolveMeetingDirectoryReferences({ projectName: 'Obra Uno' }, [trainee]).employeeId).toBeNull();
  });

  it('prioriza al PMC explícito y no usa el respaldo si hay dos PMC', () => {
    const trainee = { ...assignment, employee_id: 'aprendiz', role_in_project: 'planimetrista' };
    expect(resolveMeetingPmcReferences({ projectName: 'Obra Uno' }, [trainee, assignment])).toMatchObject({ employeeId: 'pmc-1', pmcInTraining: false });
    expect(resolveMeetingPmcReferences({ projectName: 'Obra Uno' }, [trainee, assignment, { ...assignment, employee_id: 'otro-pmc' }]).employeeId).toBeNull();
  });

  it('rechaza múltiples delineantes, cargos globales y pertenencia a otra obra', () => {
    const trainee = { ...assignment, role_in_project: 'planimetrista' };
    for (const candidates of [
      [trainee, { ...trainee, employee_id: 'otro' }],
      [{ ...trainee, project_assignment: false }],
      [{ ...trainee, project_id: 'otra-obra', project_name: 'Obra Dos' }],
      [{ ...trainee, role_in_project: 'interiorista', employee_role: 'Delineante' }],
    ]) expect(resolveMeetingPmcReferences({ projectName: 'Obra Uno' }, candidates).employeeId).toBeNull();
    expect(resolveMeetingPmcReferences({ projectName: 'Obra Uno', employeeName: 'PMC manual' }, [trainee]).employeeId).toBeNull();
  });

  it('admite el cargo Jefe de Proyectos y no inventa asignaciones sin proyecto', () => {
    expect(resolveMeetingPmcReferences({ projectName: 'Obra Uno' }, [{ ...assignment, role_in_project: 'Jefe de Proyectos' }]).employeeId).toBe('pmc-1');
    expect(resolveMeetingPmcReferences({}, [assignment]).employeeId).toBeNull();
  });
});
