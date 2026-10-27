import { normalizedProjectName, type MatchingProject } from './meeting-project-matching.ts';

export type ProjectDirectoryIdentity = MatchingProject & { address?: string | null; city?: string | null };

function normalizedIdentity(value: string): string {
  return normalizedProjectName(value).replace(/[^a-z0-9]+/g,' ').trim();
}

function identityTokens(value: string): string[] {
  return normalizedIdentity(value).split(' ').filter(token=>!['obra','proyecto','vivienda','de','del','la','el','los','las'].includes(token));
}

function nameSimilarity(first: string, second: string): number {
  const longer = Math.max(first.length,second.length);
  if (!longer) return 0;
  let previous = Array.from({length:second.length+1},(_,index)=>index);
  for (let row=1;row<=first.length;row++) {
    const current = [row];
    for (let column=1;column<=second.length;column++) current[column] = Math.min(current[column-1]+1,previous[column]+1,previous[column-1]+Number(first[row-1]!==second[column-1]));
    previous=current;
  }
  return 1-previous[second.length]/longer;
}

export function reviewProjectEquivalence(name: string, projects: ProjectDirectoryIdentity[]) {
  const normalized = normalizedIdentity(name);
  const tokens = identityTokens(name);
  const unresolved = {project:null as ProjectDirectoryIdentity|null, status:'unresolved', candidates:[] as {projectId:string;name:string;reason:string;similarity:number;qualifierConflict:boolean}[]};
  if (!normalized || tokens.every(token=>['sin','identificar','pendiente','reforma','general','cliente','nuevo','nueva','definir'].includes(token))) return unresolved;
  const unique = [...new Map(projects.map(project=>[project.id,project])).values()];
  const exact = unique.filter(project=>[project.name,...project.aliases].some(alias=>normalizedIdentity(alias)===normalized));
  if (exact.length===1) return {project:exact[0],status:'catalog-name-or-confirmed-alias',candidates:[{projectId:exact[0].id,name:exact[0].name,reason:'exact',similarity:1,qualifierConflict:false}]};
  const qualifiers = (value:string) => (normalizedIdentity(value).match(/\b(?:fase|etapa|bloque)\s+\w+|\b\d+\b/g)||[]).join('|');
  const candidates = unique.map(project=>{
    const names = [project.name,...project.aliases];
    const clientExact = tokens.length>=2 && (project.clientNames||[]).some(client=>identityTokens(client).join(' ')===tokens.join(' '));
    const contained = tokens.length>0 && names.some(candidate=>tokens.every(token=>identityTokens(candidate).includes(token)));
    const similarity = Math.max(...names.map(candidate=>nameSimilarity(tokens.join(' '),identityTokens(candidate).join(' '))),...(project.clientNames||[]).map(client=>nameSimilarity(tokens.join(' '),identityTokens(client).join(' '))));
    const addressExact = Boolean(project.address && normalizedIdentity(project.address)===normalized);
    return {projectId:project.id,name:project.name,reason:exact.length>1&&exact.some(other=>other.id===project.id)?'shared-alias':clientExact?'client-name':addressExact?'address':contained?'partial-name':'similar-name',similarity,qualifierConflict:qualifiers(name)!==qualifiers(project.name),keep:clientExact||addressExact||contained||similarity>=0.6};
  }).filter(candidate=>candidate.keep).sort((first,second)=>Number(second.reason==='client-name')-Number(first.reason==='client-name') || second.similarity-first.similarity || first.projectId.localeCompare(second.projectId)).map(({keep,...candidate})=>candidate);
  return {project:null,status:candidates.length?'requires-identity-evidence':'unresolved',candidates:candidates.slice(0,3)};
}
