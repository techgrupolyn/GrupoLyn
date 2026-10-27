import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { projectDirectory } from '../meeting-project-workflow.ts';
import { buildProjectSnapshot } from '../meeting-project-policy.ts';

const databaseUrl = process.env.QA_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('Equipo explícito por obra con cargos UUID de Club LYN', () => {
  let client: Client;
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (url.hostname !== '127.0.0.1' || url.pathname !== '/lyn_qa_retest') throw new Error('Solo QA local');
    client = new Client({connectionString:databaseUrl});
    await client.connect();
    await client.query(`
      CREATE TEMP TABLE organigrama_cargos(id TEXT,nombre TEXT,codigo TEXT,cargo_padre_id TEXT,es_direccion BOOLEAN,activo BOOLEAN,tipo_equipo_proyecto TEXT);
      CREATE TEMP TABLE organigrama_cargo_roles(cargo_id TEXT,rol TEXT);
      CREATE TEMP TABLE empleados(id TEXT PRIMARY KEY,nombre TEXT,apellido TEXT,activo BOOLEAN);
      CREATE TEMP TABLE proyecto_asignaciones(proyecto_id TEXT,empleado_id TEXT,rol_en_proyecto TEXT,source_created_at TIMESTAMPTZ);
      CREATE TEMP TABLE organigrama_cargo_asignaciones(empleado_id TEXT,cargo_id TEXT,proyecto_id TEXT,activo BOOLEAN,source_assigned_at TIMESTAMPTZ);
      INSERT INTO organigrama_cargos VALUES('pmc','Nombre editable','uuid-pmc',NULL,FALSE,TRUE,'pmc'),('drafter','Dibujo','uuid-drafter','pmc',FALSE,TRUE,'delineante');
      INSERT INTO empleados VALUES('real','PMC real',NULL,TRUE),('global','Otro PMC',NULL,TRUE),('old','Delineante anterior',NULL,TRUE),('new','Último delineante',NULL,TRUE),('inactive','Inactivo',NULL,FALSE);
      INSERT INTO proyecto_asignaciones VALUES('first','real','pmc','2026-10-06'),('first','global','director','2026-10-06'),('first','old','planimetrista','2026-10-01'),('first','new','planimetrista','2026-10-14'),('first','inactive','pmc','2026-10-15'),('second','global','director','2026-10-14');
      INSERT INTO organigrama_cargo_asignaciones VALUES('global','pmc',NULL,TRUE,'2026-10-14'),('real','pmc','first',TRUE,'2026-10-06'),('old','pmc','other',TRUE,'2026-10-15');
    `);
  });
  afterAll(async () => { await client?.end(); });
  it('reproduce y corrige el falso PMC duplicado, conservando el equipo completo', async () => {
    const directory = await projectDirectory(client,'first');
    const snapshot = buildProjectSnapshot(directory.team,directory.positions);
    expect(snapshot.issue).toBeNull();
    expect(snapshot.pmcId).toBe('real');
    expect(snapshot.path.map(step=>step.employeeId)).toEqual(['new','real']);
    expect(snapshot.team.find(person=>person.id==='global')?.cargoIds).toEqual([]);
    expect(snapshot.team.find(person=>person.id==='old')?.cargoIds).toEqual(['drafter']);
    expect(snapshot.team.some(person=>person.id==='inactive')).toBe(false);
  });
  it('no convierte acceso al proyecto y cargo global en una asignación de revisión', async () => {
    const directory = await projectDirectory(client,'second');
    expect(buildProjectSnapshot(directory.team,directory.positions).issue).toContain('Sin revisores');
  });
  it('la misma persona es PMC en una obra y planimetrista en otra, sin trasladar cargos', async () => {
    const first = await projectDirectory(client,'first');
    const other = await projectDirectory(client,'other');
    expect(first.team.find(person=>person.id==='old')?.cargoIds).toEqual(['drafter']);
    expect(other.team.find(person=>person.id==='old')?.cargoIds).toEqual(['pmc']);
    expect(buildProjectSnapshot(first.team,first.positions).pmcId).toBe('real');
    expect(buildProjectSnapshot(other.team,other.positions).pmcId).toBe('old');
  });
  it('elige el último PMC de esa obra e ignora fechas posteriores de otras obras o cargos globales', async () => {
    await client.query(`INSERT INTO organigrama_cargo_asignaciones VALUES
      ('real','pmc','latest-scope',TRUE,'2026-10-06T14:36:07.592148Z'),
      ('global','pmc','latest-scope',TRUE,'2026-10-06T10:36:07.592149-04:00'),
      ('real','pmc','different-scope',TRUE,'2026-10-16T00:00:00Z'),
      ('real','pmc',NULL,TRUE,'2026-10-17T00:00:00Z')`);
    const directory = await projectDirectory(client,'latest-scope');
    expect(buildProjectSnapshot(directory.team,directory.positions).pmcId).toBe('global');
    expect(buildProjectSnapshot(directory.team,directory.positions).issue).toBeNull();
  });
  it('no desempata PMCs de una obra por su fecha global ni por el orden de filas', async () => {
    await client.query(`INSERT INTO organigrama_cargo_asignaciones VALUES
      ('real','pmc','tied-scope',TRUE,'2026-10-06T14:36:07.592148Z'),
      ('global','pmc','tied-scope',TRUE,'2026-10-06T10:36:07.592148-04:00')`);
    const directory = await projectDirectory(client,'tied-scope');
    expect(buildProjectSnapshot(directory.team,directory.positions).issue).toContain('Más de un PMC');
  });
  it('los cargos de demostración no se atribuyen a las membresías reales importadas', async () => {
    await client.query(`INSERT INTO organigrama_cargos VALUES
      ('local-branches-pmc','PMC · DEMO','demo-pmc',NULL,FALSE,TRUE,NULL),
      ('local-branches-low','Delineante · DEMO','demo-drafter','local-branches-pmc',FALSE,TRUE,NULL);
      INSERT INTO organigrama_cargo_roles VALUES('local-branches-pmc','pmc');
      INSERT INTO organigrama_cargo_asignaciones VALUES('global','local-branches-pmc','demo',TRUE,NULL)`);
    const directory = await projectDirectory(client,'first');
    const snapshot = buildProjectSnapshot(directory.team,directory.positions);
    expect(snapshot.issue).toBeNull();
    expect(snapshot.pmcId).toBe('real');
    expect(directory.team.flatMap(person => person.cargoIds)).not.toContain('local-branches-pmc');
    const demo = await projectDirectory(client,'demo');
    expect(buildProjectSnapshot(demo.team,demo.positions).pmcId).toBe('global');
  });
  it('retira el PMC pendiente si desaparecen ambas asignaciones explícitas', async () => {
    await client.query("DELETE FROM proyecto_asignaciones WHERE empleado_id='real'; DELETE FROM organigrama_cargo_asignaciones WHERE empleado_id='real'");
    const directory = await projectDirectory(client,'first');
    expect(buildProjectSnapshot(directory.team,directory.positions).pmcId).toBeNull();
  });
});
