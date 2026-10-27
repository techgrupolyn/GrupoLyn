import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { exactActionProject, reconcileMeetingActionProjects } from '../meeting-project-linking.ts';

const projects = [{id:'first',name:'CALLE CATRAL 1',aliases:['Catral']},{id:'second',name:'Otra obra',aliases:[]}];

it.skipIf(!process.env.QA_TEST_DATABASE_URL)('vincula desde contenido completo con auditoría, sin modificar reuniones ambiguas ni decisiones manuales', async () => {
  const url = new URL(process.env.QA_TEST_DATABASE_URL!);
  if (url.hostname !== '127.0.0.1' || url.pathname !== '/lyn_qa_retest') throw new Error('Solo QA local');
  const pool = new Pool({ connectionString: url.toString(), max: 1 });
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TEMP TABLE proyectos(id TEXT,nombre TEXT,activo BOOLEAN,cliente_id TEXT);
      CREATE TEMP TABLE proyecto_aliases(proyecto_id TEXT,alias TEXT);
      CREATE TEMP TABLE empleados(id TEXT,activo BOOLEAN);
      CREATE TEMP TABLE clientes(id TEXT,nombre TEXT,apellido TEXT);
      CREATE TEMP TABLE proyecto_asignaciones(proyecto_id TEXT,empleado_id TEXT);
      CREATE TEMP TABLE organigrama_cargo_asignaciones(proyecto_id TEXT,empleado_id TEXT,activo BOOLEAN);
      CREATE TEMP TABLE google_drive_artifacts(id UUID,name TEXT,content_text TEXT,content_truncated BOOLEAN);
      CREATE TEMP TABLE meeting_review_actions(id UUID,artifact_id UUID,project_id TEXT,project_name TEXT,origin TEXT,status TEXT,project_unresolved BOOLEAN,updated_at TIMESTAMPTZ,responsible_id TEXT,responsible_kind TEXT,title TEXT,source_ref TEXT);
      CREATE TEMP TABLE meeting_reviews(artifact_id UUID,status TEXT,analysis_status TEXT,manual_revision BOOLEAN,contact_name TEXT,summary TEXT,decisions TEXT,relevant_information TEXT,project_name TEXT);
      CREATE TEMP TABLE meeting_project_drafts(artifact_id UUID);
      CREATE TEMP TABLE meeting_review_versions(id UUID,artifact_id UUID,actor TEXT,stage TEXT,detail TEXT);
      INSERT INTO proyectos VALUES('dana','DANA',TRUE,NULL),('eva','EVA SOLER',TRUE,NULL),('torre','TORRE DEL CURA - JOSE MOYA',TRUE,NULL);
    `);
    const expected: {actionId:string;projectId:string}[] = [];
    for (const kind of ['summary','decisions','relevant_information','transcript','scoped','named-context','named-conflict','named-target','paraphrase','multi','truncated','manual','approved','draft','sibling','action-contradiction','declared-unknown']) {
      const meeting = randomUUID();
      const action = randomUUID();
      const text = 'Reunión de seguimiento de la obra DANA. Revisar los planos.';
      await client.query('INSERT INTO google_drive_artifacts VALUES($1,$2,$3,$4)', [meeting,'Reunión sin identificar',kind==='transcript' ? text : kind==='multi' ? 'También se revisa EVA SOLER.' : '',kind==='truncated']);
      await client.query('INSERT INTO meeting_reviews VALUES($1,$2,$3,$4,NULL,$5,$6,$7,NULL)', [meeting,kind==='approved'?'approved':'pending','completed',kind==='manual',kind==='decisions'||kind==='relevant_information'||kind==='transcript'?'':text,kind==='decisions'?text:'',kind==='relevant_information'?text:'']);
      await client.query('INSERT INTO meeting_review_actions VALUES($1,$2,NULL,NULL,$3,$4,FALSE,NOW(),$5,$6,$7,NULL)', [action,meeting,'ai','pending','keep-person','employee',kind==='action-contradiction'?'Cambios de DANA y EVA SOLER':'Revisar planos']);
      if (kind==='draft') await client.query('INSERT INTO meeting_project_drafts VALUES($1)',[meeting]);
      if (kind==='sibling') await client.query('INSERT INTO meeting_review_actions(id,artifact_id,project_name) VALUES($1,$2,$3)',[randomUUID(),meeting,'Proyecto desconocido']);
      if (kind==='truncated') await client.query("UPDATE meeting_review_actions SET project_name='DANA' WHERE id=$1",[action]);
      if (kind==='declared-unknown') {
        const quote='Revisaremos todos los planos eléctricos antes de la próxima visita';
        await client.query('UPDATE google_drive_artifacts SET content_text=$2 WHERE id=$1',[meeting,`Obra Pepe. ${quote}.`]);
        await client.query("UPDATE meeting_review_actions SET project_name='DANA',source_ref=$2 WHERE id=$1",[action,quote]);
      }
      if (kind==='scoped') {
        const quote = 'Revisaremos todos los planos eléctricos antes de la próxima visita';
        await client.query('UPDATE google_drive_artifacts SET content_text=$2 WHERE id=$1',[meeting,`Obra DANA. ${quote}.\n\nObra EVA SOLER. Revisar el presupuesto.`]);
        await client.query('UPDATE meeting_review_actions SET source_ref=$2 WHERE id=$1',[action,`min 12:34 — ${quote}`]);
      }
      if (kind==='named-context' || kind==='named-conflict') {
        const quote = 'Revisaremos todos los planos eléctricos antes de la próxima visita';
        await client.query('UPDATE google_drive_artifacts SET content_text=$2 WHERE id=$1',[meeting,`Obra DANA. ${quote}.\n\nObra EVA SOLER. Revisar presupuesto.`]);
        await client.query('UPDATE meeting_review_actions SET project_name=$2,source_ref=$3 WHERE id=$1',[action,kind==='named-context'?'Obra Dana':'Pepe',quote]);
      }
      if (kind==='paraphrase') {
        await client.query('UPDATE google_drive_artifacts SET content_text=$2 WHERE id=$1',[meeting,'Obra DANA. Los enchufes y la iluminación de la cocina necesitan los planos eléctricos.\n\nObra EVA SOLER. Revisar tejado.']);
        await client.query('UPDATE meeting_reviews SET summary=$2 WHERE artifact_id=$1',[meeting,'Obra DANA. Preparar documentación: iluminación, enchufes y planos eléctricos de cocina.\n\nObra EVA SOLER. Confirmar tejado.']);
        await client.query('UPDATE meeting_review_actions SET title=$2 WHERE id=$1',[action,'Enviar planos eléctricos cocina enchufes iluminación']);
      }
      if (kind==='named-target') {
        await client.query('UPDATE meeting_reviews SET summary=$2 WHERE artifact_id=$1',[meeting,'Obra DANA. Revisar puertas. En Torre del Cura se revisaron los planos de climatización y techos.']);
        await client.query('UPDATE meeting_review_actions SET title=$2 WHERE id=$1',[action,'Preparar planos técnicos comparativos de la climatización y techos para Torre del Cura']);
        expected.push({actionId:action,projectId:'torre'});
      }
      if (['summary','decisions','relevant_information','transcript','scoped'].includes(kind)) expected.push({actionId:action,projectId:'dana'});
      if (['named-context','paraphrase'].includes(kind)) expected.push({actionId:action,projectId:'dana'});
    }
    await client.query('BEGIN READ ONLY');
    const preview = await reconcileMeetingActionProjects(client, {dryRun:true,contextual:true});
    expect(preview.linked).toHaveLength(8);
    expect(preview.linked).toEqual(expect.arrayContaining(expected));
    expect((await client.query('SELECT * FROM meeting_review_versions')).rowCount).toBe(0);
    await client.query('COMMIT');
    await client.query('BEGIN');
    expect((await reconcileMeetingActionProjects(client, {contextual:true})).linked).toEqual(preview.linked);
    await client.query('COMMIT');
    expect((await reconcileMeetingActionProjects(client, {contextual:true})).linked).toHaveLength(0);
    const audit = (await client.query('SELECT detail FROM meeting_review_versions')).rows.map(row => JSON.parse(row.detail));
    expect(audit).toHaveLength(8);
    expect(audit.filter(entry => entry.rule==='named-action-target-in-context')).toHaveLength(1);
    expect(audit.filter(entry => entry.rule==='explicit-project-in-action-source')).toHaveLength(2);
    expect(audit.filter(entry => entry.rule==='corroborated-action-context')).toHaveLength(1);
    expect(audit.filter(entry => entry.rule==='brief-action-in-single-project-context')).toHaveLength(4);
    for (const entry of audit) expect(entry).toMatchObject({before:{project_id:null},after:{project_id:expected.find(link=>link.actionId===entry.actionId)!.projectId},evidence:{meetingContext:expect.arrayContaining([expect.objectContaining({sha256:expect.stringMatching(/^[a-f0-9]{64}$/)})])}});
    expect((await client.query("SELECT * FROM meeting_review_actions WHERE project_id='torre' AND responsible_id='keep-person'")).rowCount).toBe(1);
    expect((await client.query("SELECT * FROM meeting_review_actions WHERE project_id='dana' AND responsible_id='keep-person'")).rowCount).toBe(7);
    const selected = expected[0].actionId;
    await client.query('UPDATE meeting_review_actions SET project_id=NULL,project_name=NULL WHERE id=$1',[selected]);
    expect((await reconcileMeetingActionProjects(client,{dryRun:true,contextual:true})).linked).toContainEqual({actionId:selected,projectId:'dana'});
    await client.query('UPDATE meeting_reviews SET summary=$2 WHERE artifact_id=(SELECT artifact_id FROM meeting_review_actions WHERE id=$1)',[selected,'Obra EVA SOLER. Revisar los planos.']);
    expect((await reconcileMeetingActionProjects(client,{dryRun:true,contextual:true})).linked).toContainEqual({actionId:selected,projectId:'eva'});
    await client.query("UPDATE proyectos SET nombre='OTRA OBRA' WHERE id='eva'");
    expect((await reconcileMeetingActionProjects(client,{dryRun:true,contextual:true})).linked).not.toContainEqual({actionId:selected,projectId:'eva'});
    await client.query('ALTER TABLE meeting_review_actions ADD COLUMN project_link_policy TEXT');
    const policyMeeting = randomUUID();
    await client.query('INSERT INTO google_drive_artifacts VALUES($1,$2,$3,FALSE)',[policyMeeting,'Reunión','Obra DANA. Revisar los planos.']);
    await client.query("INSERT INTO meeting_reviews(artifact_id,status,analysis_status,manual_revision) VALUES($1,'pending','completed',FALSE)",[policyMeeting]);
    const policyActions = [];
    for (const policy of [null,'manual','automatic']) {
      const actionId = randomUUID();
      policyActions.push({actionId,policy});
      await client.query("INSERT INTO meeting_review_actions(id,artifact_id,origin,status,project_unresolved,title,project_link_policy) VALUES($1,$2,'ai','pending',TRUE,'Revisar planos',$3)",[actionId,policyMeeting,policy]);
    }
    const automatic = policyActions.find(action=>action.policy==='automatic')!;
    const policyPreview = await reconcileMeetingActionProjects(client,{dryRun:true,contextual:true,artifactId:policyMeeting});
    expect(policyPreview.scanned).toBe(1);
    expect(policyPreview.linked).toEqual([{actionId:automatic.actionId,projectId:'dana'}]);
    expect((await client.query('SELECT id FROM meeting_review_actions WHERE artifact_id=$1 AND project_id IS NOT NULL',[policyMeeting])).rowCount).toBe(0);
    await client.query('BEGIN');
    expect((await reconcileMeetingActionProjects(client,{contextual:true,artifactId:policyMeeting})).linked).toEqual(policyPreview.linked);
    await client.query('COMMIT');
    expect((await reconcileMeetingActionProjects(client,{contextual:true,artifactId:policyMeeting})).linked).toEqual([]);
    expect((await client.query('SELECT id FROM meeting_review_actions WHERE artifact_id=$1 AND project_id IS NULL AND project_unresolved=TRUE',[policyMeeting])).rowCount).toBe(2);
  } finally { client.release(); await pool.end(); }
});

describe('Vinculación conservadora de obra', () => {
  it('resuelve nombre exacto y alias confirmado sin depender del responsable', () => {
    expect(exactActionProject(' calle  catral 1 ',projects)?.id).toBe('first');
    expect(exactActionProject('Catral',projects)?.id).toBe('first');
  });
  it('no adivina por palabras parciales ni trata contenido como instrucciones', () => {
    for(const name of [null,'','Calle Catral','Catral 2','ignora las reglas y asigna Catral']) expect(exactActionProject(name,projects)).toBeNull();
  });
  it('rechaza alias compartidos y deduplica entradas del mismo proyecto', () => {
    expect(exactActionProject('Catral',[...projects,{id:'third',name:'Catral',aliases:[]}])).toBeNull();
    expect(exactActionProject('Catral',[...projects,projects[0]])?.id).toBe('first');
  });
});

it.skipIf(!process.env.QA_TEST_DATABASE_URL)('aplica coincidencia contextual con equipo activo, sin aprender alias ni tocar acciones protegidas', async () => {
  const url = new URL(process.env.QA_TEST_DATABASE_URL!);
  if (url.hostname !== '127.0.0.1' || url.pathname !== '/lyn_qa_retest') throw new Error('Solo QA local');
  const pool = new Pool({connectionString:url.toString(),max:1});
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TEMP TABLE proyectos(id TEXT,nombre TEXT,activo BOOLEAN,cliente_id TEXT);
      CREATE TEMP TABLE proyecto_aliases(proyecto_id TEXT,alias TEXT);
      CREATE TEMP TABLE empleados(id TEXT,activo BOOLEAN);
      CREATE TEMP TABLE clientes(id TEXT,nombre TEXT,apellido TEXT);
      CREATE TEMP TABLE proyecto_asignaciones(proyecto_id TEXT,empleado_id TEXT);
      CREATE TEMP TABLE organigrama_cargo_asignaciones(proyecto_id TEXT,empleado_id TEXT,activo BOOLEAN);
      CREATE TEMP TABLE google_drive_artifacts(id UUID,name TEXT,content_text TEXT,content_truncated BOOLEAN);
      CREATE TEMP TABLE meeting_review_actions(id UUID,artifact_id UUID,project_id TEXT,project_name TEXT,origin TEXT,status TEXT,project_unresolved BOOLEAN,updated_at TIMESTAMPTZ,responsible_id TEXT,responsible_kind TEXT,title TEXT DEFAULT '',source_ref TEXT);
      CREATE TEMP TABLE meeting_reviews(artifact_id UUID,status TEXT,analysis_status TEXT,manual_revision BOOLEAN,contact_name TEXT,summary TEXT,decisions TEXT,relevant_information TEXT,project_name TEXT);
      CREATE TEMP TABLE meeting_project_drafts(artifact_id UUID);
      CREATE TEMP TABLE meeting_review_versions(id UUID,artifact_id UUID,actor TEXT,stage TEXT,detail TEXT);
      INSERT INTO proyectos VALUES('mayte','MAYTE BENAVENT',TRUE,NULL);
      INSERT INTO empleados VALUES('person',TRUE),('inactive',FALSE);
      INSERT INTO proyecto_asignaciones VALUES('mayte','person'),('mayte','inactive');
      INSERT INTO organigrama_cargo_asignaciones VALUES(NULL,'outsider',TRUE);
    `);
    const identities = new Map<string,string>();
    for (const kind of ['eligible','phase','no-member','inactive','ambiguous','approved','manual-review','manual-action','draft','already-linked']) {
      const meeting = randomUUID(), action = randomUUID();
      identities.set(kind,action);
      await client.query('INSERT INTO google_drive_artifacts(id,name) VALUES($1,\'Reunión\')',[meeting]);
      await client.query('INSERT INTO meeting_reviews(artifact_id,status,analysis_status,manual_revision,contact_name) VALUES($1,$2,\'completed\',$3,NULL)',[meeting,kind==='approved'?'approved':'pending',kind==='manual-review']);
      await client.query('INSERT INTO meeting_review_actions VALUES($1,$2,$3,$4,$5,\'pending\',$6,NOW(),$7,\'employee\',\'\',NULL)',[action,meeting,kind==='already-linked'?'existing':null,kind==='phase'?'MAITE BENAVENT FASE 3':'MAITE BENAVENT',kind==='manual-action'?'manual':'ai',kind==='ambiguous',kind==='no-member'?'outsider':kind==='inactive'?'inactive':'person']);
      if (kind==='draft') await client.query('INSERT INTO meeting_project_drafts VALUES($1)',[meeting]);
    }
    await client.query('BEGIN READ ONLY');
    const preview = await reconcileMeetingActionProjects(client,{dryRun:true,contextual:true});
    expect(preview.linked).toEqual([{actionId:identities.get('eligible'),projectId:'mayte'}]);
    expect((await client.query('SELECT * FROM meeting_review_versions')).rowCount).toBe(0);
    await client.query('COMMIT');
    await client.query('BEGIN');
    expect((await reconcileMeetingActionProjects(client,{contextual:true})).linked).toEqual(preview.linked);
    await client.query('ROLLBACK');
    expect((await client.query("SELECT * FROM meeting_review_actions WHERE project_id='mayte'")).rowCount).toBe(0);
    await client.query('BEGIN');
    await reconcileMeetingActionProjects(client,{contextual:true});
    await client.query('COMMIT');
    expect((await reconcileMeetingActionProjects(client,{contextual:true})).linked).toHaveLength(0);
    expect((await client.query('SELECT * FROM proyecto_aliases')).rowCount).toBe(0);
    expect((await client.query('SELECT responsible_id FROM meeting_review_actions WHERE id=$1',[identities.get('eligible')])).rows[0].responsible_id).toBe('person');
    expect(JSON.parse((await client.query('SELECT detail FROM meeting_review_versions')).rows[0].detail)).toMatchObject({rule:'high-name-similarity-and-project-team',evidence:{teamMatch:true},before:{project_id:null},after:{project_id:'mayte'}});
  } finally { client.release(); await pool.end(); }
});

it.skipIf(!process.env.QA_TEST_DATABASE_URL)('reconcilia con auditoría, vista previa, idempotencia y protección de reuniones', async () => {
  const url = new URL(process.env.QA_TEST_DATABASE_URL!);
  if (url.hostname !== '127.0.0.1' || url.pathname !== '/lyn_qa_retest') throw new Error('Solo QA local');
  const pool = new Pool({connectionString:url.toString(),max:1});
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TEMP TABLE proyectos(id TEXT,nombre TEXT,activo BOOLEAN);
      CREATE TEMP TABLE proyecto_aliases(proyecto_id TEXT,alias TEXT);
      CREATE TEMP TABLE meeting_review_actions(id UUID,artifact_id UUID,project_id TEXT,project_name TEXT,origin TEXT,status TEXT,project_unresolved BOOLEAN,updated_at TIMESTAMPTZ,responsible_id TEXT);
      CREATE TEMP TABLE meeting_reviews(artifact_id UUID,status TEXT,analysis_status TEXT,manual_revision BOOLEAN);
      CREATE TEMP TABLE meeting_project_drafts(artifact_id UUID);
      CREATE TEMP TABLE meeting_review_versions(id UUID,artifact_id UUID,actor TEXT,stage TEXT,detail TEXT);
      INSERT INTO proyectos VALUES('first','CALLE CATRAL 1',TRUE);
      INSERT INTO proyecto_aliases VALUES('first','Catral');
    `);
    for (const kind of ['eligible','blank','unknown','approved','processing','manual-review','manual-action','unresolved','draft','linked']) {
      const meeting = randomUUID();
      await client.query('INSERT INTO meeting_reviews VALUES($1,$2,$3,$4)',[meeting,kind==='approved'?'approved':'pending',kind==='processing'?'processing':'completed',kind==='manual-review']);
      await client.query('INSERT INTO meeting_review_actions VALUES($1,$2,$3,$4,$5,\'pending\',$6,NOW(),\'preserve-person\')',
        [randomUUID(),meeting,kind==='linked'?'existing':null,kind==='blank'?null:kind==='unknown'?'Catral 2':'Catral',kind==='manual-action'?'manual':'ai',kind==='unresolved']);
      if(kind==='draft') await client.query('INSERT INTO meeting_project_drafts VALUES($1)',[meeting]);
    }
    const preview = await reconcileMeetingActionProjects(client,{dryRun:true});
    expect(preview.linked).toHaveLength(1);
    expect((await client.query('SELECT * FROM meeting_review_versions')).rowCount).toBe(0);
    await client.query('BEGIN');
    expect((await reconcileMeetingActionProjects(client)).linked).toEqual(preview.linked);
    await client.query('COMMIT');
    expect((await reconcileMeetingActionProjects(client)).linked).toHaveLength(0);
    expect((await client.query("SELECT COUNT(*)::int AS count FROM meeting_review_actions WHERE project_id IS NULL")).rows[0].count).toBe(8);
    expect((await client.query("SELECT COUNT(*)::int AS count FROM meeting_review_actions WHERE responsible_id='preserve-person'")).rows[0].count).toBe(10);
    expect(JSON.parse((await client.query('SELECT detail FROM meeting_review_versions')).rows[0].detail)).toMatchObject({before:{project_id:null},after:{project_id:'first'},evidence:'Catral'});
  } finally {client.release();await pool.end();}
});
