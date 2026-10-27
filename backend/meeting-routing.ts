export const meetingReviewChain = [
  ['organizer', 'Encargado de la reunión'],
  ['delineante', 'Delineante'],
  ['pmc', 'PMC'],
] as const;

export function meetingEmployeeRoles(review: string, employee: string): string {
  return `SELECT cargo.nombre AS role
    FROM organigrama_cargo_asignaciones assignment
    JOIN organigrama_cargos cargo ON cargo.id = assignment.cargo_id AND cargo.activo = TRUE
    WHERE assignment.empleado_id = ${employee} AND assignment.activo = TRUE
      AND (assignment.proyecto_id = ${review}.project_id OR assignment.proyecto_id IS NULL)
    UNION
    SELECT assignment.rol_en_proyecto FROM proyecto_asignaciones assignment
    WHERE assignment.proyecto_id = ${review}.project_id AND assignment.empleado_id = ${employee}
    UNION
    SELECT role.nombre FROM usuario_rol membership JOIN roles role ON role.id = membership.rol_id
    WHERE membership.empleado_id = ${employee} AND (
      ${review}.pmc_employee_id = ${employee}
      OR EXISTS (SELECT 1 FROM proyecto_asignaciones assignment WHERE assignment.proyecto_id = ${review}.project_id AND assignment.empleado_id = ${employee})
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(${review}.pmc_assignments) person WHERE person->>'employee_id' = ${employee})
    )`;
}

export function meetingStageRecipientCondition(review: string, employee: string, stage = `${review}.workflow_stage`): string {
  return `EXISTS (SELECT 1 FROM empleados reviewer WHERE reviewer.id = ${employee} AND reviewer.activo = TRUE AND (
    (${stage} = 'organizer' AND EXISTS (SELECT 1 FROM meeting_artifact_organizers organizer WHERE organizer.artifact_id = ${review}.artifact_id AND organizer.employee_id = reviewer.id))
    OR (${stage} IN ('assigned', 'operations', 'director') AND ${review}.workflow_recipient_id = reviewer.id)
    OR ((${stage} IN ('delineante', 'pmc') OR (${review}.workflow_recipient_id IS NULL AND ${stage} IN ('operations', 'director'))) AND EXISTS (
      SELECT 1 FROM (${meetingEmployeeRoles(review, 'reviewer.id')}) roles
      WHERE (${stage} = 'delineante' AND (LOWER(roles.role) LIKE '%delineante%' OR LOWER(roles.role) LIKE '%planimetrista%'))
        OR (${stage} IN ('pmc', 'operations', 'director') AND (LOWER(roles.role) LIKE '%pmc%' OR LOWER(roles.role) LIKE '%jefe de proyectos%'))
    ))
  ))`;
}

export function canDeleteMeetingActionsForRole(role: unknown): boolean {
  const normalized = String(role || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/^employee:/, '').replace(/[_/-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (normalized.includes('practicas')) return false;
  return ['director', 'director general', 'pmc', 'jefe de proyectos'].includes(normalized) || /^pmc\s/.test(normalized);
}
