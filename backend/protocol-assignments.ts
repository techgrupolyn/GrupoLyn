import type { ProtocolFile } from './protocol-corpus.ts';

export const projectAssignmentsSheetId = '1H43otMwHAzD724u-e2s8czAoNLnxCW95kOUm3bNhG3w';

const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim().replace(/\s+/gu, ' ');

export function findProjectAssignment(question: string, file: ProtocolFile): { answer: string; sections: ProtocolFile['sections']; topic: string; complete: boolean } | null {
  const wantsOwner = /responsable|asignad|a cargo|lleva|\bpmc\b|\bpm\b|delineante|interiorista/iu.test(question);
  const wantsStatus = /estado|situaci[oó]n|avance|c[oó]mo va/iu.test(question);
  if (!wantsOwner && !wantsStatus) return null;
  const requestedRoles = [
    /\bpmc\b|\bpm\b/iu.test(question) ? 'PMC' : null,
    /delineante/iu.test(question) ? 'Delineante' : null,
    /interiorista/iu.test(question) ? 'Interiorista' : null,
  ].filter((role): role is string => Boolean(role));
  const normalizedQuestion = ` ${normalize(question)} `;
  const entries = file.sections.flatMap(section => {
    const parts = Object.fromEntries(section.text.split('; ').map(part => {
      const separator = part.indexOf(': ');
      return separator < 0 ? ['', ''] : [part.slice(0, separator), part.slice(separator + 2)];
    }));
    return parts.Obra ? [{ section, project: parts.Obra, parts }] : [];
  });
  const matches = entries.filter(entry => normalizedQuestion.includes(` ${normalize(entry.project)} `));
  if (!matches.length) return null;
  const projects = [...new Set(matches.map(entry => normalize(entry.project)))];
  const longest = projects.sort((left, right) => right.length - left.length)[0];
  if (projects.some(project => project !== longest && !` ${longest} `.includes(` ${project} `))) return null;
  const selected = matches.filter(entry => normalize(entry.project) === longest);
  const fields = ['PMC', 'Delineante', 'Interiorista', 'Estado', 'Situación'];
  const details = fields.flatMap(field => {
    if ((field === 'Situación' || field === 'Estado') && !wantsStatus) return [];
    if (field !== 'Situación' && field !== 'Estado' && !wantsOwner) return [];
    if (requestedRoles.length && field !== 'Situación' && field !== 'Estado' && !requestedRoles.includes(field)) return [];
    const values = [...new Set(selected.map(entry => entry.parts[field]).filter(Boolean))];
    return values.length === 1 ? [`${field}: ${values[0]}`] : values.length > 1 ? [`${field}: datos contradictorios; confirmar asignación`] : [];
  });
  const hasStatus = details.some(detail => detail.startsWith('Situación:') || detail.startsWith('Estado:'));
  const hasOwner = details.some(detail => /^(PMC|Delineante|Interiorista):/u.test(detail));
  const missingRoles = requestedRoles.filter(role => !details.some(detail => detail.startsWith(`${role}:`)));
  if (wantsStatus && !hasStatus) details.push('La situación no consta en la hoja');
  if (wantsOwner && !hasOwner && !requestedRoles.length) details.push('No consta un responsable para esta obra en la hoja');
  for (const role of missingRoles) details.push(`${role}: no consta en la hoja`);
  const complete = (!wantsStatus || hasStatus) && (!wantsOwner || hasOwner) && !missingRoles.length && !details.some(detail => detail.includes('datos contradictorios'));
  const sources = selected.filter(entry => (wantsStatus && (entry.parts.Estado || entry.parts.Situación)) || (wantsOwner && (requestedRoles.length ? requestedRoles.some(role => entry.parts[role]) : ['PMC', 'Delineante', 'Interiorista'].some(role => entry.parts[role]))));
  return { answer: `Según «Reparto de obras»: ${details.join('; ')}.`, sections: sources.map(entry => entry.section), topic: wantsStatus ? 'estado de obra' : 'responsables de obra', complete };
}
