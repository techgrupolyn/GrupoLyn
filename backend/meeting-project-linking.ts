import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { PoolClient } from 'pg';
import { matchMeetingProject, normalizedProjectName, type MatchingProject } from './meeting-project-matching.ts';
import { contextProjectNameCompatible, createActionProjectContextResolver, meetingContextCatalog, resolveMeetingProjectContext, type MeetingProjectContext } from './meeting-project-context.ts';

export type LinkableProject = { id: string; name: string; aliases: string[] };

const contextCache = new Map<string, { signature: string; meeting: MeetingProjectContext; actions: Map<string, MeetingProjectContext> }>();

function projectKey(value: string): string {
  return normalizedProjectName(value);
}

export function exactActionProject(name: string | null, projects: LinkableProject[]): LinkableProject | null {
  const key = projectKey(name || '');
  if (!key) return null;
  const candidates = new Map(projects.filter((project) => [project.name, ...project.aliases].some((name) => projectKey(name) === key)).map((project) => [project.id, project]));
  return candidates.size === 1 ? [...candidates.values()][0] : null;
}

export async function reconcileMeetingActionProjects(client: PoolClient, options: { dryRun?: boolean; artifactId?: string; contextual?: boolean } = {}) {
  const contextual = options.contextual ?? process.env.MEETING_PROJECT_MATCHING_ENABLED === 'true';
  const projects = (await client.query<LinkableProject>(`SELECT project.id,project.nombre AS name,
    COALESCE((SELECT array_agg(alias) FROM proyecto_aliases WHERE proyecto_id=project.id),'{}') AS aliases
    FROM proyectos project WHERE project.activo=TRUE`)).rows;
  let matchingProjects: MatchingProject[] = projects;
  if (contextual) {
    const context = (await client.query<{id:string;employeeIds:string[];clientNames:string[]}>(`SELECT project.id,
      ARRAY(SELECT DISTINCT employee.id FROM empleados employee JOIN (
        SELECT empleado_id,proyecto_id FROM proyecto_asignaciones
        UNION SELECT empleado_id,proyecto_id FROM organigrama_cargo_asignaciones WHERE activo=TRUE
      ) membership ON membership.empleado_id=employee.id WHERE employee.activo=TRUE AND membership.proyecto_id=project.id) AS "employeeIds",
      ARRAY(SELECT CONCAT_WS(' ',customer.nombre,customer.apellido) FROM clientes customer WHERE customer.id=project.cliente_id) AS "clientNames"
      FROM proyectos project WHERE project.activo=TRUE`)).rows;
    const directory = new Map(context.map((entry) => [entry.id,entry]));
    matchingProjects = projects.map((project) => ({...project,...directory.get(project.id)}));
  }
  const actions = (await client.query<{id:string;artifact_id:string;project_name:string|null;project_unresolved:boolean;source_title?:string;action_text?:string;action_title?:string;source_ref?:string;contact_name?:string;employee_id?:string}>(`
    SELECT action.id,action.artifact_id,action.project_name,action.project_unresolved
    ${contextual ? ",artifact.name AS source_title,action.title AS action_title,action.source_ref,CONCAT_WS(' ',action.title,action.source_ref) AS action_text,review.contact_name,CASE WHEN action.responsible_kind='employee' THEN action.responsible_id END AS employee_id" : ''}
    FROM meeting_review_actions action JOIN meeting_reviews review ON review.artifact_id=action.artifact_id
    ${contextual ? 'JOIN google_drive_artifacts artifact ON artifact.id=action.artifact_id' : ''}
    WHERE action.project_id IS NULL AND action.origin='ai' AND action.status='pending'
      AND COALESCE(to_jsonb(action)->>'project_link_policy','') <> 'manual'
      AND (action.project_unresolved=FALSE ${contextual ? "OR to_jsonb(action)->>'project_link_policy'='automatic'" : ''})
      AND review.status<>'approved' AND review.analysis_status='completed' AND review.manual_revision=FALSE
      AND NOT EXISTS(SELECT 1 FROM meeting_project_drafts draft WHERE draft.artifact_id=action.artifact_id)
      AND ($1::uuid IS NULL OR action.artifact_id=$1)
    ORDER BY action.artifact_id,action.id ${options.dryRun ? '' : 'FOR UPDATE OF review,action'}
  `,[options.artifactId || null])).rows;
  const meetingContexts = new Map<string, MeetingProjectContext>();
  const actionContexts = new Map<string, MeetingProjectContext>();
  if (contextual) {
    const catalogSignature = JSON.stringify(projects.map(project => ({ id: project.id, name: project.name, aliases: [...project.aliases].sort() })).sort((first, second) => first.id.localeCompare(second.id)));
    const meetingIds = [...new Set(actions.map(action => action.artifact_id))];
    for (let offset = 0; offset < meetingIds.length; offset += 32) {
      const contexts = await client.query<{
        artifact_id: string; name: string; summary: string; decisions: string; relevant_information: string;
        content_text: string; content_truncated: boolean; declared_names: string[];
      }>(`SELECT review.artifact_id,artifact.name,review.summary,review.decisions,review.relevant_information,
        artifact.content_text,artifact.content_truncated,
        ARRAY(SELECT DISTINCT sibling.project_name FROM meeting_review_actions sibling WHERE sibling.artifact_id=review.artifact_id AND NULLIF(BTRIM(sibling.project_name),'') IS NOT NULL)
          || ARRAY_REMOVE(ARRAY[review.project_name],NULL) AS declared_names
        FROM meeting_reviews review JOIN google_drive_artifacts artifact ON artifact.id=review.artifact_id
        WHERE review.artifact_id=ANY($1::uuid[]) ${options.dryRun ? '' : 'FOR SHARE OF artifact'}`, [meetingIds.slice(offset, offset + 32)]);
      for (const context of contexts.rows) {
        const meetingActions = actions.filter(action => action.artifact_id === context.artifact_id);
        const signature = createHash('sha256').update(catalogSignature).update(JSON.stringify({ ...context, declared_names: [...context.declared_names].sort(), actions: meetingActions.map(action => ({ id:action.id, title:action.action_title, sourceRef:action.source_ref })) })).digest('hex');
        const cached = contextCache.get(context.artifact_id);
        if (cached?.signature === signature) {
          meetingContexts.set(context.artifact_id, cached.meeting);
          for (const [actionId, result] of cached.actions) actionContexts.set(actionId, result);
          await yieldToEventLoop();
          continue;
        }
        const sources = [
          { kind: 'title', text: context.name }, { kind: 'summary', text: context.summary },
          { kind: 'decisions', text: context.decisions }, { kind: 'relevant_information', text: context.relevant_information },
          { kind: 'transcript', text: context.content_text },
        ];
        const scopedCatalog = meetingContextCatalog(matchingProjects,context.declared_names,sources);
        meetingContexts.set(context.artifact_id, resolveMeetingProjectContext(sources, scopedCatalog, context.declared_names, context.content_truncated));
        const resolveAction = createActionProjectContextResolver(sources, scopedCatalog, context.content_truncated);
        const cachedActions = new Map<string, MeetingProjectContext>();
        for (const action of meetingActions) {
          const result = resolveAction({ title: action.action_title, sourceRef: action.source_ref });
          actionContexts.set(action.id, result);
          cachedActions.set(action.id, result);
        }
        contextCache.delete(context.artifact_id);
        contextCache.set(context.artifact_id, { signature, meeting: meetingContexts.get(context.artifact_id)!, actions: cachedActions });
        while (contextCache.size > 512) contextCache.delete(contextCache.keys().next().value!);
        await yieldToEventLoop();
      }
    }
  }
  const linked: {actionId:string;projectId:string}[] = [];
  const decisions: {actionId:string;projectId:string|null;rule:string|null;candidates:unknown[];evidence:unknown}[] = [];
  for (const action of actions) {
    const match = contextual ? matchMeetingProject({projectName:action.project_name,actionText:action.action_text,clientName:action.contact_name,employeeId:action.employee_id},matchingProjects) : null;
    const actionContext = actionContexts.get(action.id);
    const context = contextual ? actionContext : undefined;
    const compatible = (!context?.project || contextProjectNameCompatible(action.project_name,context.project,matchingProjects)) && (context?.reason!=='brief-action-in-single-project-context' || meetingContexts.get(action.artifact_id)?.project?.id===context.project?.id);
    const contextProject = compatible && context?.project && matchMeetingProject({ projectName:context.project.name,title:action.source_title,actionText:action.action_text,clientName:action.contact_name },matchingProjects).project?.id === context.project.id ? context.project : null;
    const declaredMatch = action.project_name?.trim() && !action.project_unresolved && !['action-source-ambiguous','action-source-not-identifiable','action-context-ambiguous','transcription-truncated'].includes(actionContext?.reason || '') && (!actionContext?.project || actionContext.project.id===match?.project?.id) ? match?.project : null;
    const project = contextual ? declaredMatch || contextProject : exactActionProject(action.project_name,projects);
    const rule = declaredMatch ? match!.rule : contextProject ? context!.reason : 'exact-project-name-or-confirmed-alias';
    const diagnostic = { actionContextReason:actionContext?.reason, meetingContextReason:meetingContexts.get(action.artifact_id)?.reason, contextRejected:context?.project && !contextProject ? compatible ? 'conflicting-action-or-client' : 'incompatible-declared-project' : undefined };
    const evidence = contextProject ? { ...match?.evidence, ...diagnostic, meetingContext:context!.evidence } : context ? { ...match?.evidence, ...diagnostic, contextReason:context.reason } : match?.evidence || action.project_name;
    decisions.push({actionId:action.id,projectId:project?.id || null,rule:project ? rule : null,candidates:match?.candidates || [],evidence});
    if (!project) continue;
    if (!options.dryRun) {
      await client.query('UPDATE meeting_review_actions SET project_id=$2,project_name=$3,project_unresolved=FALSE,updated_at=NOW() WHERE id=$1 AND project_id IS NULL',[action.id,project.id,project.name]);
      await client.query(`INSERT INTO meeting_review_versions(id,artifact_id,actor,stage,detail) VALUES($1,$2,'directory-sync','project-linked',$3)`,
        [randomUUID(),action.artifact_id,JSON.stringify({actionId:action.id,evidence,rule,before:{project_id:null,project_name:action.project_name,project_unresolved:action.project_unresolved},after:{project_id:project.id,project_name:project.name,project_unresolved:false}})]);
    }
    linked.push({actionId:action.id,projectId:project.id});
  }
  return {scanned:actions.length,linked,unresolved:actions.length-linked.length,decisions};
}
