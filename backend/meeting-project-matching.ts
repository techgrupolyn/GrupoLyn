export type MatchingProject = { id: string; name: string; aliases: string[]; employeeIds?: string[]; clientNames?: string[] };
export type ProjectEvidence = { projectName?: string | null; title?: string | null; actionText?: string | null; clientName?: string | null; employeeId?: string | null };

export function normalizedProjectName(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es').trim().replace(/\s+/g, ' ');
}

function meaningfulName(value: string): string {
  return normalizedProjectName(value).replace(/^(?:(?:obra|proyecto|vivienda)\s+)+/, '');
}

function similarity(left: string, right: string): number {
  if (!left || !right) return 0;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    const current = [row];
    for (let column = 1; column <= right.length; column++) current[column] = Math.min(current[column - 1] + 1, previous[column] + 1, previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1));
    previous = current;
  }
  return 1 - previous[right.length] / Math.max(left.length, right.length);
}

function qualifiers(value: string): string {
  return (value.match(/\b(?:fase|etapa|bloque)\s+[\w-]+|\b\d+\b/g) || []).join('|');
}

export function matchMeetingProject(input: ProjectEvidence, projects: MatchingProject[]) {
  const projectName = meaningfulName(input.projectName || '');
  const clientName = normalizedProjectName(input.clientName || '');
  const contexts = [input.title, input.actionText].filter(Boolean).map((value) => normalizedProjectName(value!).replace(/[^a-z0-9]+/g, ' '));
  const unique = [...new Map(projects.map((project) => [project.id, project])).values()];
  const ranked = unique.map((project) => {
    const names = [project.name, ...project.aliases];
    const exact = Boolean(projectName && names.some((name) => normalizedProjectName(name) === normalizedProjectName(input.projectName || '')));
    const titleMatch = contexts.some((title) => names.some((name) => {
      const key = normalizedProjectName(name).replace(/[^a-z0-9]+/g, ' ');
      const padded = ` ${title} `;
      const offset = padded.indexOf(` ${key} `);
      const suffix = offset < 0 ? '' : padded.slice(offset + key.length + 1).trim();
      const titlePhases = (title.match(/\b(?:fase|etapa|bloque)\s+[\w-]+/g) || []).join('|');
      const namePhases = (key.match(/\b(?:fase|etapa|bloque)\s+[\w-]+/g) || []).join('|');
      return key.length >= 4 && offset >= 0 && !/^\d+\b/.test(suffix) && titlePhases === namePhases;
    }));
    const teamMatch = Boolean(input.employeeId && project.employeeIds?.includes(input.employeeId));
    const nameScores = names.map((name) => {
      const key = meaningfulName(name);
      return { score: similarity(projectName, key), compatible: qualifiers(projectName) === qualifiers(key) };
    });
    const nameScore = Math.max(0, ...nameScores.map((entry) => entry.score));
    const clients = project.clientNames || [];
    const clientScore = Math.max(0, ...clients.map((name) => similarity(clientName, normalizedProjectName(name))));
    const clientExact = Boolean(clientName && clients.some((name) => normalizedProjectName(name) === clientName));
    const eligibleName = projectName.length >= 8 && projectName.split(/\s+/).length >= 2 && nameScores.some((entry) => entry.score >= 0.9 && entry.compatible);
    const eligibleClient = clientName.length >= 8 && clientName.split(/\s+/).length >= 2 && clientScore >= 0.9;
    return { project, exact, titleMatch, teamMatch, clientExact, score: Math.max(nameScore, clientScore), eligibleName, eligibleClient };
  }).sort((first, second) => second.score - first.score || first.project.id.localeCompare(second.project.id));
  const exacts = ranked.filter((candidate) => candidate.exact);
  const titled = ranked.filter((candidate) => candidate.titleMatch);
  const clients = ranked.filter((candidate) => candidate.clientExact);
  let selected: typeof ranked[number] | undefined;
  let rule = '';
  if (exacts.length === 1) { selected = exacts[0]; rule = 'normalized-name-or-confirmed-alias'; }
  else if (!projectName && titled.length === 1) { selected = titled[0]; rule = 'unique-project-in-title'; }
  else if (!projectName && !titled.length && clients.length === 1 && clients[0].teamMatch) { selected = clients[0]; rule = 'unique-client-and-project-team'; }
  else if (!exacts.length && titled.length <= 1 && clients.length <= 1) {
    const best = ranked[0];
    if (best && best.teamMatch && (projectName ? best.eligibleName : best.eligibleClient) && (!ranked[1] || best.score - ranked[1].score >= 0.1)) {
      selected = best; rule = 'high-name-similarity-and-project-team';
    }
  }
  if (selected && (titled.some((candidate) => candidate.project.id !== selected!.project.id) || clients.some((candidate) => candidate.project.id !== selected!.project.id))) selected = undefined;
  return {
    project: selected?.project || null,
    rule: selected ? rule : null,
    evidence: { ...input, teamMatch: selected?.teamMatch || false, similarity: selected ? Math.round(selected.score * 100) : null },
    candidates: ranked.filter((candidate) => candidate.score >= 0.6 || candidate.titleMatch).slice(0, 3).map((candidate) => ({ projectId: candidate.project.id, projectName: candidate.project.name, similarity: Math.round(candidate.score * 100), teamMatch: candidate.teamMatch })),
  };
}
