\set ON_ERROR_STOP on
BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';
WITH positions AS (
  SELECT cargo.id, cargo.nombre AS name, cargo.cargo_padre_id AS "parentId", cargo.es_direccion AS director,
    CASE WHEN to_jsonb(cargo)->>'tipo_equipo_proyecto' IS NOT NULL THEN to_jsonb(cargo)->>'tipo_equipo_proyecto'='pmc' ELSE
    EXISTS(SELECT 1 FROM organigrama_cargo_roles roles WHERE roles.cargo_id=cargo.id AND LOWER(roles.rol) IN ('pmc','jefe_de_proyectos'))
    OR LOWER(COALESCE(cargo.codigo,'')) IN ('pmc','jefe_de_proyectos')
    OR LOWER(BTRIM(cargo.nombre)) IN ('pmc','pmc / proyectos','jefe de proyectos') END AS final
  FROM organigrama_cargos cargo WHERE cargo.activo=TRUE
), pending AS (
  SELECT action.artifact_id, action.project_id
  FROM meeting_review_actions action JOIN meeting_reviews review ON review.artifact_id=action.artifact_id
  WHERE review.analysis_status='completed' AND review.status<>'approved'
), project_ids AS (
  SELECT DISTINCT project_id FROM pending WHERE project_id IS NOT NULL
  UNION
  SELECT review.project_id FROM meeting_reviews review
  WHERE review.analysis_status='completed' AND review.status<>'approved' AND review.project_id IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM meeting_review_actions action WHERE action.artifact_id=review.artifact_id)
), members AS (
  SELECT membership.proyecto_id AS project_id, membership.empleado_id AS employee_id
  FROM proyecto_asignaciones membership JOIN project_ids ON project_ids.project_id=membership.proyecto_id
  UNION
  SELECT membership.proyecto_id, membership.empleado_id
  FROM organigrama_cargo_asignaciones membership JOIN project_ids ON project_ids.project_id=membership.proyecto_id
  WHERE membership.activo=TRUE
), member_roles AS (
  SELECT assigned.proyecto_id AS project_id, assigned.empleado_id AS employee_id, assigned.cargo_id,
    (to_jsonb(assigned)->>'source_assigned_at')::timestamptz AS assigned_at
  FROM organigrama_cargo_asignaciones assigned JOIN project_ids ON project_ids.project_id=assigned.proyecto_id WHERE assigned.activo=TRUE
  UNION
  SELECT membership.proyecto_id, membership.empleado_id, cargo.id, membership.source_created_at
  FROM proyecto_asignaciones membership JOIN project_ids ON project_ids.project_id=membership.proyecto_id
  JOIN organigrama_cargos cargo ON cargo.activo=TRUE AND (
    CASE WHEN to_jsonb(cargo)->>'tipo_equipo_proyecto' IS NOT NULL THEN to_jsonb(cargo)->>'tipo_equipo_proyecto' =
      CASE LOWER(BTRIM(membership.rol_en_proyecto)) WHEN 'planimetrista' THEN 'delineante' ELSE LOWER(BTRIM(membership.rol_en_proyecto)) END
    ELSE LOWER(BTRIM(membership.rol_en_proyecto))=LOWER(BTRIM(cargo.codigo)) OR LOWER(BTRIM(membership.rol_en_proyecto))=LOWER(BTRIM(cargo.nombre)) END)
), dated_roles AS (
  SELECT project_id,employee_id,cargo_id,MAX(assigned_at) AS assigned_at FROM member_roles GROUP BY project_id,employee_id,cargo_id
), team_members AS (
  SELECT members.project_id, employee.id, CONCAT_WS(' ',employee.nombre,employee.apellido) AS name,
    COALESCE(ARRAY_AGG(DISTINCT member_roles.cargo_id ORDER BY member_roles.cargo_id) FILTER(WHERE member_roles.cargo_id IS NOT NULL),'{}') AS "cargoIds",
    COALESCE(jsonb_object_agg(member_roles.cargo_id,member_roles.assigned_at) FILTER(WHERE member_roles.cargo_id IS NOT NULL),'{}'::jsonb) AS "assignedAt"
  FROM members JOIN empleados employee ON employee.id=members.employee_id AND employee.activo=TRUE
  LEFT JOIN dated_roles member_roles ON member_roles.project_id=members.project_id AND member_roles.employee_id=members.employee_id
  GROUP BY members.project_id,employee.id
), teams AS (
  SELECT project_id, jsonb_agg(jsonb_build_object('id',id,'name',name,'cargoIds',"cargoIds",'assignedAt',"assignedAt") ORDER BY id) AS team
  FROM team_members GROUP BY project_id
), project_data AS (
  SELECT project_ids.project_id AS id, projects.nombre AS name,
    (SELECT COUNT(*) FROM pending WHERE pending.project_id=project_ids.project_id) AS actions,
    COALESCE(teams.team,'[]'::jsonb) AS team
  FROM project_ids LEFT JOIN proyectos projects ON projects.id=project_ids.project_id
  LEFT JOIN teams ON teams.project_id=project_ids.project_id
)
SELECT jsonb_build_object(
  'capturedAt', clock_timestamp(),
  'teamTypeImported', EXISTS(SELECT 1 FROM organigrama_cargos cargo WHERE to_jsonb(cargo)->>'tipo_equipo_proyecto' IS NOT NULL),
  'positions', COALESCE((SELECT jsonb_agg(positions ORDER BY id) FROM positions),'[]'::jsonb),
  'projects', COALESCE((SELECT jsonb_agg(project_data ORDER BY id) FROM project_data),'[]'::jsonb),
  'counts', jsonb_build_object(
    'meetings', (SELECT COUNT(*) FROM meeting_reviews),
    'pendingMeetings', (SELECT COUNT(*) FROM meeting_reviews WHERE analysis_status='completed' AND status<>'approved'),
    'pendingActions', (SELECT COUNT(*) FROM pending),
    'actionsWithoutProject', (SELECT COUNT(*) FROM pending WHERE project_id IS NULL),
    'meetingsWithUnlinkedActions', (SELECT COUNT(DISTINCT artifact_id) FROM pending WHERE project_id IS NULL)
  )
);
COMMIT;
