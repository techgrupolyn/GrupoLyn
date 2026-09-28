export type EvidenceSource = { ref: string; messageId: string; line: string; order: number };
export type SummaryFinding = {
  kind: 'task' | 'decision' | 'blocker' | 'information' | 'uncertain';
  state: 'pending' | 'completed' | 'cancelled' | 'unknown';
  text: string;
  topicRef: string | null;
  evidence: Array<{ source: string; quote: string }>;
};
export type EvidenceAnalysis = { findings: SummaryFinding[]; informational: string[][] };
export type GroundedGroup = { name: string; findings: SummaryFinding[]; sources: EvidenceSource[]; messageCount: number };
export class EvidenceValidationError extends Error {}

function invalid(message: string): never { throw new EvidenceValidationError(message); }

export function parseEvidenceAnalysis(text: string, primary: EvidenceSource[], context: EvidenceSource[] = []): EvidenceAnalysis {
  let value: EvidenceAnalysis;
  try { value = JSON.parse(text); } catch { return invalid('La extracción no es JSON completo.'); }
  if (!value || !Array.isArray(value.findings) || !Array.isArray(value.informational)) invalid('Falta la estructura de hallazgos y cobertura.');
  const sources = new Map([...context, ...primary].map((source) => [source.ref, source]));
  const primaryRefs = new Set(primary.map((source) => source.ref));
  const covered = new Set<string>();
  for (const fact of value.findings) {
    if (!fact || !['task', 'decision', 'blocker', 'information', 'uncertain'].includes(fact.kind) || !['pending', 'completed', 'cancelled', 'unknown'].includes(fact.state)) invalid('Tipo o estado no válido.');
    if (typeof fact.text !== 'string' || !fact.text.trim() || fact.text.length > 1000) invalid('Cada hallazgo debe ser concreto, con máximo 1000 caracteres. Divide asuntos diferentes.');
    if (!Array.isArray(fact.evidence) || !fact.evidence.length || fact.evidence.length > 6) invalid('Cada hallazgo necesita entre una y seis citas literales.');
    let hasPrimary = false;
    for (const citation of fact.evidence) {
      const source = sources.get(citation?.source);
      if (!source || typeof citation.quote !== 'string' || !citation.quote.trim() || citation.quote.length > 600 || !source.line.includes(citation.quote)) invalid('Una referencia no existe en este lote o su cita no es literal.');
      if (primaryRefs.has(source.ref)) { hasPrimary = true; covered.add(source.ref); }
    }
    if (!hasPrimary) invalid('No repitas hallazgos que solo pertenecen al contexto anterior.');
    if (fact.topicRef !== null) {
      if (typeof fact.topicRef !== 'string' || fact.topicRef.length > 100 || !/\p{L}/u.test(fact.topicRef) || !/\d/.test(fact.topicRef) || !fact.evidence.some((citation) => citation.quote.includes(fact.topicRef!))) invalid('topicRef debe ser un identificador literal con letras y números, o null.');
    }
  }
  const informational = new Set<string>();
  for (const range of value.informational) {
    if (!Array.isArray(range) || range.length !== 2) invalid('Cada intervalo informativo requiere inicio y final.');
    const first = primary.findIndex((source) => source.ref === range[0]);
    const last = primary.findIndex((source) => source.ref === range[1]);
    if (first < 0 || last < first) invalid('Intervalo informativo ajeno al lote o invertido.');
    for (const source of primary.slice(first, last + 1)) {
      if (covered.has(source.ref) || informational.has(source.ref)) invalid('La cobertura informativa se solapa con hallazgos u otro intervalo.');
      informational.add(source.ref);
    }
  }
  if (primary.some((source) => !covered.has(source.ref) && !informational.has(source.ref))) invalid('Hay mensajes del lote sin revisar.');
  return value;
}

export function validateEvidenceAudit(text: string, findings: SummaryFinding[]) {
  let audit: { approved: number[]; rejected: unknown[]; missing: unknown[] };
  try { audit = JSON.parse(text); } catch { return invalid('La verificación no es JSON completo.'); }
  if (!audit || !Array.isArray(audit.approved) || !Array.isArray(audit.rejected) || !Array.isArray(audit.missing)) invalid('Falta el resultado estructurado de la verificación.');
  if (audit.rejected.length || audit.missing.length) invalid(`El verificador detectó hallazgos no sustentados u omisiones: ${JSON.stringify({ rejected: audit.rejected, missing: audit.missing }).slice(0, 1500)}`);
  if (audit.approved.length !== findings.length || new Set(audit.approved).size !== findings.length || audit.approved.some((index) => !Number.isInteger(index) || index < 0 || index >= findings.length)) invalid('El verificador no comprobó todos los hallazgos.');
}

export function renderGroundedSummary(groups: GroundedGroup[]) {
  const totalMessages = groups.reduce((total, group) => total + group.messageCount, 0);
  const totalFindings = groups.reduce((total, group) => total + group.findings.length, 0);
  const blocks = [`INFORME GLOBAL\n${totalMessages} mensajes de texto revisados en ${groups.length} grupos. ${totalFindings} hallazgos con citas contrastadas.\nLas interpretaciones siguen siendo automáticas; consulta las citas y confirma las dudas antes de actuar.\nPOR GRUPO`];
  const labels = { task: 'Tarea', decision: 'Decisión', blocker: 'Bloqueo', information: 'Información', uncertain: 'Por confirmar' };
  const states = { pending: 'Pendiente', completed: 'Completado', cancelled: 'Cancelado', unknown: 'Estado no confirmado' };
  for (const group of groups) {
    const sourceMap = new Map(group.sources.map((source) => [source.ref, source]));
    const findings = [...group.findings].sort((left, right) => Math.max(...left.evidence.map((citation) => sourceMap.get(citation.source)!.order)) - Math.max(...right.evidence.map((citation) => sourceMap.get(citation.source)!.order)));
    const latest = new Map<string, SummaryFinding>();
    for (const fact of findings) if (fact.topicRef) latest.set(fact.topicRef, fact);
    blocks.push(`## ${group.name}\n${group.messageCount} mensajes revisados.`);
    if (!findings.length) blocks.push('No se detectaron hallazgos accionables ni información relevante que requiera destacar.');
    else {
      if (latest.size) {
        blocks.push('ÚLTIMA MENCIÓN POR REFERENCIA EXPLÍCITA');
        for (const [reference, fact] of latest) blocks.push(`- ${reference}: ${fact.text} ${fact.evidence.map((citation) => `[${citation.source}]`).join(' ')}`);
        blocks.push('Estas menciones no son el estado global del proyecto: compartir una referencia no cierra otras tareas pendientes. Se conserva todo el historial debajo.');
      }
      blocks.push('HALLAZGOS Y SECUENCIA DE CAMBIOS');
      for (const fact of findings) {
        blocks.push(`- ${labels[fact.kind]} · ${states[fact.state]}: ${fact.text}`);
        for (const citation of fact.evidence) blocks.push(`  [${citation.source}] «${citation.quote}»`);
      }
    }
    if (group.sources.some((source) => /-P\d+$/.test(source.ref))) blocks.push('Hay mensajes extensos divididos en fragmentos: revisa el original si una interpretación depende de contexto lejano.');
  }
  return blocks.join('\n\n');
}
