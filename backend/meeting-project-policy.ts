export type ProjectPerson = { id: string; name: string; cargoIds: string[]; assignedAt?: Record<string, string | null> };
export type ProjectPosition = { id: string; name: string; parentId: string | null; final: boolean; director: boolean };
export type ReviewStep = { employeeId: string; name: string; cargoId: string; cargo: string; final: boolean };
export type ProjectSnapshot = { team: ProjectPerson[]; path: ReviewStep[]; pmcId: string | null; issue: string | null };
export type ProjectBranch = { id: string; project_id: string; snapshot: ProjectSnapshot; cursor: number; approved: boolean };
export type ProjectReviewerSelection = { startCargoId: string | null; reviewers: Record<string, string>; fallbackPmc?: { employeeId: string; cargoId: string } | null };

function assignmentInstant(value: string | null | undefined): bigint | null {
  const milliseconds = Date.parse(value || '');
  if (!Number.isFinite(milliseconds)) return null;
  const fraction = value?.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/i)?.[1] || '';
  return BigInt(milliseconds) * 1000n + BigInt(fraction.padEnd(6,'0').slice(3,6));
}

export function latestProjectReviewers(team: ProjectPerson[]): Record<string, string> {
  const choices: Record<string, string> = {};
  for (const cargoId of new Set(team.flatMap((person) => person.cargoIds))) {
    const members = team.filter((person) => person.cargoIds.includes(cargoId));
    if (members.length < 2) continue;
    const dated = members.map((person) => ({ person, time: assignmentInstant(person.assignedAt?.[cargoId]) }));
    if (dated.some((entry) => entry.time === null)) continue;
    dated.sort((first, second) => first.time! > second.time! ? -1 : first.time! < second.time! ? 1 : 0);
    if (dated[0].time !== dated[1].time) choices[cargoId] = dated[0].person.id;
  }
  return choices;
}

export function designatedProjectSnapshot(team: ProjectPerson[], positions: ProjectPosition[], selection?: ProjectReviewerSelection): ProjectSnapshot {
  if (!selection) return buildProjectSnapshot(team, positions);
  const validChoices = { ...Object.fromEntries(Object.entries(selection.reviewers).filter(([cargoId, employeeId]) => team.some((person) => person.id === employeeId && person.cargoIds.includes(cargoId)))), ...latestProjectReviewers(team) };
  let allowed: Set<string> | null = null;
  if (selection.startCargoId && team.some((person) => person.cargoIds.includes(selection.startCargoId!))) {
    for (const cargoId of new Set(team.flatMap((person) => person.cargoIds))) {
      let ancestor = positions.find((item) => item.id === cargoId);
      const visited = new Set<string>();
      while (ancestor && !ancestor.director && !ancestor.final && !visited.has(ancestor.id)) {
        visited.add(ancestor.id);
        ancestor = positions.find((item) => item.id === ancestor!.parentId);
        if (ancestor?.id === selection.startCargoId && cargoId !== selection.startCargoId) return { team, path: [], pmcId: null, issue: 'El primer cargo designado debe ser el peldaño inferior ocupado; no se pueden saltar revisores.' };
      }
    }
    allowed = new Set();
    let position = positions.find((item) => item.id === selection.startCargoId);
    while (position && !position.director && !allowed.has(position.id)) {
      allowed.add(position.id);
      if (position.final) break;
      position = positions.find((item) => item.id === position!.parentId);
    }
    if (position && !position.final && !position.director) return { team, path: [], pmcId: null, issue: 'Ciclo en el organigrama.' };
  }
  const routingTeam = team.map((person) => ({ ...person, cargoIds: person.cargoIds.filter((cargoId) => (!allowed || allowed.has(cargoId)) && (!validChoices[cargoId] || validChoices[cargoId] === person.id)) }));
  return { ...buildProjectSnapshot(routingTeam, positions), team };
}

export function exactPersonName(value: unknown): string {
  return String(value || '').normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('es');
}

export function resolveProjectResponsible(mentioned: string | null, snapshot: ProjectSnapshot) {
  const matches = snapshot.team.filter((person) => exactPersonName(person.name) === exactPersonName(mentioned) && Boolean(mentioned?.trim()));
  const person = matches.length === 1 ? matches[0] : snapshot.team.find((candidate) => candidate.id === snapshot.pmcId);
  return { person: person || null, origin: person ? matches.length === 1 ? 'mentioned' : 'pmc_default' : 'unassigned' };
}

export function buildProjectSnapshot(team: ProjectPerson[], positions: ProjectPosition[]): ProjectSnapshot {
  const choices = latestProjectReviewers(team);
  const routingTeam = team.map((person) => ({ ...person, cargoIds: person.cargoIds.filter((cargoId) => !choices[cargoId] || choices[cargoId] === person.id) }));
  return { ...buildReviewPath(routingTeam, positions), team };
}

function buildReviewPath(team: ProjectPerson[], positions: ProjectPosition[]): ProjectSnapshot {
  const byId = new Map(positions.map((position) => [position.id, position]));
  const finals = team.flatMap((person) => person.cargoIds.filter((id) => byId.get(id)?.final && !byId.get(id)?.director).map((cargoId) => ({ person, cargoId })));
  const pmcs = new Set(finals.map((entry) => entry.person.id));
  const empty = (issue: string): ProjectSnapshot => ({ team, path: [], pmcId: pmcs.size === 1 ? finals[0].person.id : null, issue });
  if (pmcs.size > 1) return empty('Más de un PMC: confirmar asignación en Club LYN.');
  if (new Set(finals.map((entry) => entry.cargoId)).size > 1) return empty('PMC con cargos finales ambiguos.');
  const final = finals[0];
  const paths: ReviewStep[][] = [];
  for (const person of team) for (const cargoId of person.cargoIds) {
    const path: ReviewStep[] = [];
    const visited = new Set<string>();
    const lineage: ProjectPosition[] = [];
    let position = byId.get(cargoId);
    while (position && !position.director) {
      if (visited.has(position.id)) return empty('Ciclo en el organigrama.');
      visited.add(position.id);
      lineage.push(position);
      if (position.final) break;
      if (position.parentId && !byId.has(position.parentId)) return empty('Cargo superior no disponible en el organigrama.');
      position = position.parentId ? byId.get(position.parentId) : undefined;
    }
    if (final && lineage.at(-1)?.id !== final.cargoId) continue;
    for (const position of lineage) {
      const occupants = team.filter((candidate) => candidate.cargoIds.includes(position.id));
      if (occupants.length > 1) return empty(`Más de un revisor para ${position.name}.`);
      if (occupants.length === 1) {
        const step = { employeeId: occupants[0].id, name: occupants[0].name, cargoId: position.id, cargo: position.name, final: false };
        if (path.at(-1)?.employeeId === step.employeeId) path[path.length - 1] = step;
        else path.push(step);
      }
    }
    if (path.length) {
      path[path.length - 1].final = true;
      paths.push(path);
    }
  }
  const maximal = paths.filter((path) => !paths.some((other) => other.length > path.length && path.every((step, index) => step.cargoId === other[other.length - path.length + index].cargoId)));
  const unique = [...new Map(maximal.map((path) => [JSON.stringify(path), path])).values()];
  if (!unique.length) return empty('Sin revisores asignados en esta obra.');
  if (unique.length !== 1) return empty('Varias cadenas inferiores: confirmar el recorrido del proyecto.');
  return { team, path: unique[0], pmcId: final?.person.id || null, issue: null };
}

export function branchesReadyForPmc(branches: ProjectBranch[]): boolean {
  return branches.length > 0 && branches.every((branch) => !branch.snapshot.issue && (branch.approved || branch.snapshot.path[branch.cursor]?.final));
}

export function canReviewBranch(branch: ProjectBranch, branches: ProjectBranch[], employeeId: string): boolean {
  const current = branch.snapshot.path[branch.cursor];
  return !branch.approved && !branch.snapshot.issue && current?.employeeId === employeeId && (!current.final || branchesReadyForPmc(branches));
}

export function canSeeProjectBranch(branch: ProjectBranch, branches: ProjectBranch[], employeeId: string): boolean {
  if (!branch.snapshot.team.some((person) => person.id === employeeId)) return false;
  return branch.snapshot.pmcId !== employeeId || branchesReadyForPmc(branches);
}
