import { createHash } from 'node:crypto';
import type { MatchingProject } from './meeting-project-matching.ts';

export type MeetingContextSource = { kind: string; text: string | null };
export type MeetingProjectContext = {
  project: MatchingProject | null;
  evidence: { source: string; excerpt: string; sha256: string }[];
  reason: string;
};

function words(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function genericContinuation(value: string): boolean {
  return /^(?:se|es|esta|estan|tiene|tienen|hay|que|para|con|por|fue|sera|son|debe|deben|requiere|requieren|necesita|necesitan)\b/.test(value) || /^(?:el|este|cada)\s+(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/.test(value);
}

function unidentifiedName(value: string): boolean {
  return ['sin obra','sin proyecto','sin identificar','por definir','no definido','pendiente de identificar','pendiente de vincular','reforma de la vivienda','reforma de vivienda'].includes(words(value));
}

function contextNameCandidates(name: string, projects: MatchingProject[]): MatchingProject[] {
  const normalized = words(name).replace(/^(?:(?:obra|proyecto|vivienda)\s+)+/, '');
  const qualifiers = (value: string) => (value.match(/\b(?:fase|etapa|bloque)\s+\w+|\b\d+\b/g) || []).join('|');
  const significant = (value: string) => value.split(' ').filter(token => !['de','del','la','el','los','las','obra','proyecto','vivienda'].includes(token));
  const tokens = significant(normalized);
  if (!tokens.length || tokens.every(token => ['reforma','general','cliente','nuevo','pendiente','identificar','sin'].includes(token))) return [];
  const exact = projects.filter(candidate=>[candidate.name,...candidate.aliases].some(alias=>words(alias)===normalized || words(alias)===words(name)));
  if (exact.length) return exact;
  return projects.filter(candidate => [candidate.name,...candidate.aliases].some(alias => {
    const key = words(alias);
    return key === words(name) || (qualifiers(normalized) === qualifiers(key) && tokens.every(token => significant(key).includes(token)));
  }));
}

export function contextProjectNameCompatible(name: string | null | undefined, project: MatchingProject, projects: MatchingProject[]): boolean {
  if (!name?.trim() || unidentifiedName(name)) return true;
  const candidates = contextNameCandidates(name,projects);
  return new Set(candidates.map(candidate => candidate.id)).size === 1 && candidates[0].id === project.id;
}

export function meetingContextCatalog(projects: MatchingProject[], declaredNames: string[], sources: MeetingContextSource[]): MatchingProject[] {
  const augmented = projects.map(project=>({...project,aliases:[...project.aliases]}));
  const supportedNames = new Set(declaredNames.filter(name=>name?.trim() && !unidentifiedName(name)).map(name=>words(name).replace(/^(?:(?:obra|proyecto|vivienda)\s+)+/,'')));
  const combined = sources.map(source=>` ${words(source.text||'')} `);
  for (const project of projects) {
    const full = words(project.name);
    const first = full.split(' ')[0];
    if (first.length>=5 && !['proyecto','prueba','cliente','calle','avenida','torre','plaza','reforma','vivienda'].includes(first) && combined.some(source=>source.includes(` ${full} `))) supportedNames.add(first);
  }
  for (const name of supportedNames) {
    if (name.length<4) continue;
    const matches = contextNameCandidates(name,projects);
    if (new Set(matches.map(project=>project.id)).size!==1) continue;
    const project = augmented.find(project=>project.id===matches[0].id)!;
    if (![project.name,...project.aliases].some(alias=>words(alias)===name)) project.aliases.push(name);
  }
  return augmented;
}

export function resolveMeetingProjectContext(sources: MeetingContextSource[], projects: MatchingProject[], declaredNames: string[] = [], truncated = false): MeetingProjectContext {
  const unresolved = (reason: string): MeetingProjectContext => ({ project: null, evidence: [], reason });
  if (truncated) return unresolved('transcription-truncated');
  const names = projects.flatMap(project => [project.name, ...project.aliases].map(name => ({ project, name: words(name) }))).filter(entry => entry.name.length >= 4);
  const mentions = new Set<string>();
  const declarations = new Set<string>();
  const evidence: MeetingProjectContext['evidence'] = [];
  for (const name of declaredNames.filter(name => name.trim() && !unidentifiedName(name))) {
    const matching = new Set(contextNameCandidates(name,projects).map(project=>project.id));
    if (matching.size !== 1) return unresolved('unresolved-declared-project');
    mentions.add([...matching][0]);
  }
  for (const source of sources) {
    const text = source.text || '';
    const normalized = ` ${words(text)} `;
    for (const entry of names) if (normalized.includes(` ${entry.name} `)) mentions.add(entry.project.id);
    const markers = /\b(?:obra|proyecto|vivienda)\b\s*(?::|[-–])?\s*(?:(?:de|del|en)\s+)?(?:la\s+)?[«“"']?/gi;
    for (const marker of text.matchAll(markers)) {
      const offset = marker.index! + marker[0].length;
      const rest = text.slice(offset);
      const lineStart = Math.max(text.lastIndexOf('\n', marker.index!), text.lastIndexOf('.', marker.index!)) + 1;
      const before = words(text.slice(lineStart, marker.index!));
      if (/\b(?:otra|otro|comparar|comparacion|ejemplo|referencia|anterior|descartado|descartada|ignora|ignorar|asigna|asignar|vincula|vincular)\b/.test(before) || /\bno\s+(?:es|era|sea|corresponde|pertenece)(?:\s+(?:a|en|de|la|el|esta|esa))*$/.test(before)) return unresolved('non-identifying-reference');
      const tail = words(rest.split(/[\n.!?;]/, 1)[0]);
      if (!tail) continue;
      const matching = names.filter(entry => tail === entry.name || tail.startsWith(`${entry.name} `));
      if (!matching.length && genericContinuation(tail)) continue;
      const identities = new Set(matching.map(entry => entry.project.id));
      if (identities.size !== 1) return unresolved('unknown-or-ambiguous-context-project');
      const candidate = matching.sort((first, second) => second.name.length - first.name.length)[0];
      const suffix = tail.slice(candidate.name.length).trim();
      if (/^(?:(?:fase|etapa|bloque|no)\b|\d+\b)/.test(suffix) || /^(?:y|e|o)\b/.test(suffix) && !/^(?:y|e|o)\s+(?:revisar|confirmar|enviar|preparar|comprobar|actualizar|solicitar|realizar|se|hay|queda|quedan)\b/.test(suffix)) return unresolved('different-project-qualifier');
      declarations.add(candidate.project.id);
      if (!evidence.some(item => item.source === source.kind)) evidence.push({ source: source.kind, excerpt: text.slice(marker.index!, Math.min(text.length, offset + candidate.name.length + 80)), sha256: createHash('sha256').update(text).digest('hex') });
    }
  }
  if (declarations.size !== 1 || mentions.size !== 1 || [...declarations][0] !== [...mentions][0]) return unresolved('context-not-single-project');
  return { project: projects.find(project => project.id === [...declarations][0])!, evidence, reason: 'explicit-single-project-in-meeting-content' };
}

type ActionContextInput = { title?: string | null; sourceRef?: string | null };

function namedActionTarget(sources: MeetingContextSource[], projects: MatchingProject[], action: ActionContextInput): MeetingProjectContext | null {
  const title = action.title || '';
  if (/\b(?:comparar|comparacion|ejemplo|referencia|copiar|trasladar|ignora|asigna|vincula)\b/.test(words(title))) return null;
  const location = title.match(/\b(?:para|en)\s+(?:(?:la\s+obra|el\s+proyecto|la\s+vivienda)\s+)?([^.;,\n()[\]]+)$/i);
  if (!location) return null;
  const identifier = words(location[1]);
  const significant = identifier.split(' ').filter(token=>!['de','del','la','el','obra','proyecto','vivienda'].includes(token));
  if (significant.length<2 || identifier.length<8) return null;
  const candidates = contextNameCandidates(identifier,projects);
  if (new Set(candidates.map(project=>project.id)).size!==1) return null;
  const project = candidates[0];
  const normalizedTitle = ` ${words(title)} `;
  if (projects.some(other=>other.id!==project.id && [other.name,...other.aliases].some(name=>words(name).length>=4 && normalizedTitle.includes(` ${words(name)} `)))) return null;
  const evidence: MeetingProjectContext['evidence'] = [];
  const identifierPattern = identifier.split(' ').join('[\\s-]+');
  for (const source of sources.filter(source=>source.kind!=='title')) {
    const text = source.text || '';
    const plain = text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
    const matcher = new RegExp(`\\b(?:obra|proyecto|vivienda|en|para)\\s+(?:(?:de|del|la|el)\\s+)*${identifierPattern}\\b`,'g');
    for (const match of plain.matchAll(matcher)) {
      const start = Math.max(plain.lastIndexOf('.',match.index!),plain.lastIndexOf('\n',match.index!))+1;
      const before = words(plain.slice(start,match.index!));
      if (/\b(?:comparar|comparacion|ejemplo|referencia|no|ignora|asigna|vincula)\b/.test(before)) continue;
      const suffix = words(plain.slice(match.index!+match[0].length).split(/[\n.!?;]/,1)[0]);
      if (/^(?:\d+|fase|etapa|bloque)\b/.test(suffix)) continue;
      evidence.push({source:source.kind,excerpt:text.slice(match.index!,Math.min(text.length,match.index!+match[0].length+200)),sha256:createHash('sha256').update(text).digest('hex')});
      break;
    }
  }
  if (!evidence.length) return null;
  evidence.push({source:'action:title',excerpt:title,sha256:createHash('sha256').update(title).digest('hex')});
  return {project,evidence,reason:'named-action-target-in-context'};
}

const contextStopWords = new Set('para como desde hasta sobre entre antes despues durante todos todas todo toda estos estas este esta esto esos esas ese esa sido sera ser estar tiene tienen hacer hacerse realizar realizada realizado revisar revision confirmar enviar preparar solicitar quedar queda pendiente pendientes proxima proximo nueva nuevo nuevos nuevas falta necesario necesarios debe deben puede pueden tambien porque cuando donde mediante cada segun acuerda acordar acordado definir completar gestionar elaborar entregar generar'.split(' '));

function contentTokens(value: string): Set<string> {
  return new Set(words(value).split(' ').filter(token => token.length >= 4 && !contextStopWords.has(token)).map(token => token.length > 5 ? token.replace(/(?:es|s)$/, '') : token));
}

function timestampSeconds(value: string): number {
  const parts = value.split(':').map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function contextPassages(text: string): {text:string; actionItem:boolean}[] {
  const passages: {text:string;actionItem:boolean}[] = [];
  let heading = '';
  let actionSection = false;
  for (const paragraph of text.split(/\r?\n\s*\r?\n/)) {
    const lines = paragraph.split(/\r?\n/);
    let pending: string[] = [];
    let actionItem = false;
    const flush = () => {
      if (pending.some(line => line.trim())) passages.push({text:[heading,...pending].filter(Boolean).join('\n'),actionItem});
      pending = [];
      actionItem = false;
    };
    for (const line of lines) {
      if (/^(?:proximos pasos|acciones|tareas|pendientes)$/.test(words(line))) {
        flush();
        actionSection = true;
        heading = '';
      } else if (/^(?:detalles|resumen|decisiones|notas|informacion relevante)$/.test(words(line))) {
        flush();
        actionSection = false;
        heading = '';
      } else if (/^\s*[-*•]\s+|^\s*\d+[.)]\s+/.test(line)) {
        flush();
        actionItem = actionSection;
        pending.push(line);
      } else if (/^\s*(?:#{1,6}\s*)?(?:obra|proyecto|vivienda)\b[^.!?;\n]{1,100}:?\s*$/i.test(line)) {
        flush();
        heading = line;
      } else pending.push(line);
    }
    flush();
  }
  return passages.flatMap(passage => {
    const boundaries = [...passage.text.matchAll(/(?<=[.!?])\s+(?=(?:Obra|Proyecto|Vivienda)\s)/gi)].map(match => match.index!);
    if (!boundaries.length) return [passage];
    if (passage.actionItem) return [passage];
    const starts = [0,...boundaries];
    return starts.map((start,index) => ({text:passage.text.slice(start,starts[index+1] ?? passage.text.length),actionItem:false}));
  });
}

function sourceTaskProject(text: string, kind: string, projects: MatchingProject[]): MeetingProjectContext | null {
  const task = text.replace(/^\s*[-*•]\s*/, '').replace(/^\[[^\]]+\]\s*/, '');
  const label = task.split(':', 1)[0];
  const match = words(label).match(/^(?:actualizar|montar|preparar|revisar|subir|enviar|corregir)\s+(?:el\s+|los\s+)?(?:presupuesto|planos|mediciones)\s+(?:de\s+)?(.+)$/);
  if (!match) return null;
  const selected = projects.filter(project => [project.name,...project.aliases].some(name => words(name) === match[1]));
  if (new Set(selected.map(project => project.id)).size !== 1) return null;
  const normalized = ` ${words(task)} `;
  if (projects.some(project => project.id !== selected[0].id && [project.name,...project.aliases].some(name => normalized.includes(` ${words(name)} `)))) return null;
  return {project:selected[0],reason:'explicit-project-in-task-heading',evidence:[{source:kind,excerpt:text.slice(0,600),sha256:createHash('sha256').update(text).digest('hex')}]};
}

export function createActionProjectContextResolver(sources: MeetingContextSource[], projects: MatchingProject[], truncated = false): (action: ActionContextInput) => MeetingProjectContext {
  const unresolved = (reason: string): MeetingProjectContext => ({ project: null, evidence: [], reason });
  if (truncated) return () => unresolved('transcription-truncated');
  const names = projects.flatMap(project => [project.name, ...project.aliases].map(name => ` ${words(name)} `));
  const singleMeeting = resolveMeetingProjectContext(sources,projects);
  const prepared = sources.map(source => {
    const text = source.text || '';
    const timestamps = source.kind === 'transcript' ? [...text.matchAll(/^\s*\[?(\d{1,3}:\d{2}(?::\d{2})?)\]?(?=\s|$)/gm)] : [];
    const timed = timestamps.map((match,index) => ({text:text.slice(match.index!,timestamps[index+1]?.index ?? text.length),actionItem:false,start:timestampSeconds(match[1]),end:timestamps[index+1] ? timestampSeconds(timestamps[index+1][1]) : timestampSeconds(match[1])+60}));
    const parts = [...contextPassages(text).map(paragraph => ({...paragraph,start:null as number|null,end:null as number|null})),...timed];
    return { kind: source.kind, sha256: createHash('sha256').update(text).digest('hex'), paragraphs: parts.map(paragraph => ({ ...paragraph, inlineTimes:[...paragraph.text.matchAll(/\b(\d{1,3}:\d{2}(?::\d{2})?)\b/g)].map(match=>timestampSeconds(match[1])), normalized: ` ${words(paragraph.text)} `, tokens:contentTokens(paragraph.text), result: undefined as MeetingProjectContext | undefined })) };
  });
  return action => {
    const named = namedActionTarget(sources,projects,action);
    if (named) return named;
    const quote = (action.sourceRef || '').replace(/^\s*\[?min\s+\d{1,3}:\d{2}(?::\d{2})?\]?\s*[—–:\-]?\s*/i, '');
    const anchors = [...new Set([quote, action.title || ''].map(words))].filter(anchor => anchor.length >= 35 && anchor.split(' ').length >= 6);
    const titleTokens = contentTokens(action.title || '');
    const times = [...(action.sourceRef || '').matchAll(/\b(\d{1,3}:\d{2}(?::\d{2})?)\b/g)].map(match => timestampSeconds(match[1]));
    const resolved: MeetingProjectContext[] = [];
    const approximate: { result:MeetingProjectContext; score:number; kind:string; timed:boolean; actionItem:boolean; withoutProjectReference:boolean }[] = [];
    const numbers = (action.title || '').match(/\b\d+(?:[.,]\d+)?\b/g) || [];
    const brief = (value: string) => words(value).replace(/\b(?:el|la|los|las|un|una|de|del)\b/g,'').replace(/\s+/g,' ').trim();
    const briefTitle = brief(action.title || '');
    for (const source of prepared) {
      const useTimestamp = times.length>0 && source.paragraphs.some(paragraph=>paragraph.start!==null);
      const timeMatches = source.paragraphs.filter(paragraph=>paragraph.start!==null && paragraph.end!==null && times.length===1 && times[0]>=paragraph.start && times[0]<paragraph.end);
      const inlineMatches = times.length===1 && source.kind==='transcript' ? source.paragraphs.filter(paragraph=>paragraph.start===null && paragraph.inlineTimes.includes(times[0]) && !/^\s*\[?\d{1,3}:\d{2}(?::\d{2})?\]?(?=\s|$)/m.test(paragraph.text)) : [];
      for (const paragraph of source.paragraphs) {
        const anchorLiteral = anchors.some(anchor => paragraph.normalized.includes(` ${anchor} `));
        const briefLiteral = Boolean(singleMeeting.project) && briefTitle.length>=12 && briefTitle.split(' ').length>=2 && titleTokens.size>=1 && paragraph.text.length<=250 && ` ${brief(paragraph.text)} `.includes(` ${briefTitle} `);
        const literal = anchorLiteral || briefLiteral;
        const overlap = [...titleTokens].filter(token => paragraph.tokens.has(token)).length;
        const score = titleTokens.size ? overlap / titleTokens.size : 0;
        const timed = paragraph.start !== null && paragraph.end !== null && paragraph.end > paragraph.start && paragraph.end-paragraph.start <= 120 && times.length === 1 && times[0] >= paragraph.start && times[0] < paragraph.end || inlineMatches.length===1 && inlineMatches[0]===paragraph;
        if (useTimestamp && paragraph.start!==null && (!timed || timeMatches.length!==1)) continue;
        if (useTimestamp && paragraph.start===null && /^\s*\[?\d{1,3}:\d{2}(?::\d{2})?\]?(?=\s|$)/m.test(paragraph.text)) continue;
        if (times.length && paragraph.start===null && paragraph.inlineTimes.length && !inlineMatches.includes(paragraph)) continue;
        if (!literal && numbers.some(number=>!new Set<string>(paragraph.text.match(/\b\d+(?:[.,]\d+)?\b/g)||[]).has(number))) continue;
        if (!literal && !(titleTokens.size>=4 && overlap>=4 && score>=0.6 && paragraph.text.length<=4000)) continue;
        const originalResult = paragraph.result ??= resolveMeetingProjectContext([{ kind: source.kind, text: paragraph.text }], projects);
        const result = paragraph.actionItem && originalResult.reason==='context-not-single-project' ? sourceTaskProject(paragraph.text,source.kind,projects) || originalResult : originalResult;
        const evidence = result.evidence.map(item => ({ ...item, sha256: source.sha256 }));
        evidence.push({source:`${source.kind}:action-context`,excerpt:paragraph.text.slice(0,600),sha256:source.sha256});
        const supported = {...result,evidence,reason:briefLiteral && !anchorLiteral ? 'brief-action-in-single-project-context' : result.reason};
        if (literal) {
          if (result.project) resolved.push(supported);
          else if (paragraph.start === null && !briefLiteral && (paragraph.actionItem || paragraph.text.length<=600)) {
            if (result.reason !== 'context-not-single-project') return unresolved('action-source-not-identifiable');
            if (names.some(name => paragraph.normalized.includes(name))) return unresolved('action-source-ambiguous');
          }
        } else {
          const taskText = paragraph.text.replace(/^\s*[-*•]\s*/, '').replace(/^\[[^\]]+\]\s*/, '');
          const taskTokens = contentTokens(taskText);
          const taskOverlap = [...taskTokens].filter(token=>titleTokens.has(token)).length;
          const sourceCoverage = taskTokens.size ? taskOverlap/taskTokens.size : 0;
          const exactMinute = inlineMatches.length===1 && inlineMatches[0]===paragraph && times.length===1;
          const specificTimedAction = exactMinute && result.project && score>=0.6 && overlap>=4;
          const taskScore = specificTimedAction || paragraph.actionItem && result.project && score>=0.65 && overlap>=4 && sourceCoverage>=0.8 ? Math.max(score,0.9) : score;
          const withoutProjectReference = paragraph.actionItem && result.reason==='context-not-single-project'
            && !names.some(name=>paragraph.normalized.includes(name))
            && !/\b(?:obra|proyecto|vivienda|fase|etapa|bloque)\b|\b\d+\b/i.test(taskText)
            && !/\b(?:para|en|de|del)\s+(?:(?:el|la)\s+)?[A-ZÁÉÍÓÚÜÑ][\p{L}\p{N}]+/u.test(taskText)
            && !/\bcliente\s+(?:de|del|en)\s+/i.test(taskText);
          approximate.push({result:supported,score:taskScore,kind:source.kind,timed,actionItem:paragraph.actionItem,withoutProjectReference});
        }
      }
    }
    if (resolved.length) {
      if (new Set(resolved.map(result => result.project!.id)).size !== 1 || approximate.some(candidate => candidate.score>=0.8 && candidate.result.project && candidate.result.project.id!==resolved[0].project!.id)) return unresolved('action-source-ambiguous');
      return { project: resolved[0].project, evidence: resolved.flatMap(result => result.evidence), reason: resolved.every(result=>result.reason==='brief-action-in-single-project-context') ? 'brief-action-in-single-project-context' : 'explicit-project-in-action-source' };
    }
    const ranked = approximate.filter(candidate=>!candidate.withoutProjectReference).sort((first,second)=>second.score-first.score);
    const best = ranked[0];
    if (!best || best.score<0.8 || !best.result.project) return unresolved('action-context-no-match');
    const supporting = ranked.filter(candidate=>candidate.score>=0.8 && candidate.result.project?.id===best.result.project!.id);
    if (ranked.some(candidate=>candidate.result.project?.id!==best.result.project!.id && best.score-candidate.score<0.2-Number.EPSILON)) return unresolved('action-context-ambiguous');
    const explicitTask = supporting.some(candidate=>candidate.kind==='transcript' && candidate.actionItem && candidate.score>=0.9);
    if (!explicitTask && !supporting.some(candidate=>candidate.timed) && !(supporting.some(candidate=>candidate.kind==='transcript') && supporting.some(candidate=>candidate.kind!=='transcript'))) return unresolved('action-context-needs-corroboration');
    return { project:best.result.project,evidence:supporting.flatMap(candidate=>candidate.result.evidence),reason:explicitTask?'explicit-project-in-source-task':'corroborated-action-context' };
  };
}

export function resolveActionProjectContext(sources: MeetingContextSource[], projects: MatchingProject[], action: ActionContextInput, truncated = false): MeetingProjectContext {
  return createActionProjectContextResolver(sources, projects, truncated)(action);
}
