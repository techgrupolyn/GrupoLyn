import { randomUUID } from 'node:crypto';
import { validateProtocolAnswer, type ProtocolAnswer } from './protocol-answer-validation.ts';
import { protocolCorpusPrompt, type ProtocolCorpus } from './protocol-corpus.ts';
import { containsUnmaskedPersonalData, maskProtocolQuestion } from './protocol-privacy.ts';
import { PROTOCOL_SYSTEM_PROMPT_V2 } from './protocol-prompt.ts';

export type ProtocolQuery = {
  userId: number;
  role: string;
  question: string;
  channel: 'superagente';
};

export type ProtocolLog = {
  id: string;
  userId: number;
  role: string;
  question: string;
  answer: string;
  classification: ProtocolAnswer['clasificacion'] | 'no_urgente';
  reason: ProtocolAnswer['motivo_no_respuesta'];
  area: string;
  topic: string;
  sources: Array<{ doc_id: string; name: string; modifiedTime: string; revision: string; seccion: string; cita: string }>;
  derivationRole: string | null;
  contradiction: ProtocolAnswer['contradiccion'];
  validation: 'ok' | 'reintento' | 'rechazada';
  corpusVersionId: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  error: string | null;
};

export type ProtocolAgentDependencies = {
  loadCorpus: () => Promise<ProtocolCorpus | null>;
  clientNames: () => Promise<string[]>;
  roles: () => Promise<Array<{ name: string; person?: string }>>;
  topics?: () => Promise<string[]>;
  generate: (system: string, user: string) => Promise<{ text: string; model: string; inputTokens?: number | null; outputTokens?: number | null }>;
  save: (log: ProtocolLog) => Promise<void>;
  now?: () => number;
};

export type ProtocolAgentResult = { id: string; answer: string; classification: string; sources: ProtocolLog['sources']; derivationRole: string | null; derivationPerson: string | null; contradiction: ProtocolLog['contradiction']; validation: ProtocolLog['validation']; corpusVersionId: string };

function normalizeTopic(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').toLowerCase().replace(/\s+/gu, ' ').trim().split(' ').slice(0, 5).join(' ').slice(0, 120);
}

function fallbackRole(roles: Array<{ name: string; person?: string }>): string | null {
  return roles.find(role => role.name.toLowerCase() === 'pmc')?.name || roles.find(role => /direcci[oó]n/iu.test(role.name))?.name || roles[0]?.name || null;
}

function safetyRisk(question: string): boolean {
  return /olor a gas|fuga de gas|hay fuego|se incendia|incendio en|electrocuci[oó]n|descarga el[eé]ctrica|cable con corriente|persona herida|persona lesionada|alguien se ha ca[ií]do|persona se cay[oó]|ca[ií]da de una persona|riesgo de derrumbe|estructura se cae|fuga de agua|inundaci[oó]n activa/iu.test(question);
}

function unansweredText(reason: Exclude<ProtocolAnswer['motivo_no_respuesta'], null>, role: string): string {
  if (reason === 'tema_sensible') return `No puedo responder esta cuestión aquí. Consulta con ${role}.`;
  if (reason === 'fuera_de_alcance') return `La ejecución técnica de una obra queda fuera de este agente. Consulta con ${role}.`;
  return `No encuentro una respuesta en los protocolos disponibles. Consulta con ${role}; si no sabes qué solución proponer, anota qué has intentado y qué te falta para llevarlo al Meet diario «Dudas». Si requiere seguimiento, usa Alertas de Club LYN.`;
}

export async function askProtocolAgent(query: ProtocolQuery, dependencies: ProtocolAgentDependencies): Promise<ProtocolAgentResult> {
  const start = (dependencies.now || Date.now)();
  const id = randomUUID();
  if (!Number.isSafeInteger(query.userId) || query.userId < 1 || !query.role.trim() || !query.question.trim() || query.question.length > 2000 || query.channel !== 'superagente') throw new Error('Consulta inválida');
  const [corpus, names, roles, topics] = await Promise.all([dependencies.loadCorpus(), dependencies.clientNames(), dependencies.roles(), dependencies.topics?.() || Promise.resolve([])]);
  if (!corpus) throw new Error('El corpus de protocolos aún no está disponible');
  const masked = maskProtocolQuestion(query.question.trim(), { clientNames: names });
  if (containsUnmaskedPersonalData(masked)) throw new Error('No se puede enviar la consulta porque contiene datos personales sin enmascarar');
  const roleName = fallbackRole(roles);
  const rolePerson = (name: string | null) => roles.find(role => role.name === name)?.person || null;
  const buildResult = (log: ProtocolLog): ProtocolAgentResult => ({ id, answer: log.answer, classification: log.classification, sources: log.sources, derivationRole: log.derivationRole, derivationPerson: rolePerson(log.derivationRole), contradiction: log.contradiction, validation: log.validation, corpusVersionId: corpus.id });
  const common = { id, userId: query.userId, role: query.role, question: masked, corpusVersionId: corpus.id };

  if (safetyRisk(masked)) {
    const answer = `No esperes a este chat: avisa ahora a ${roleName || 'tu responsable'}. Si hay peligro para alguien, llama al 112.`;
    const log: ProtocolLog = { ...common, answer, classification: 'urgente', reason: null, area: 'obra', topic: 'seguridad en obra', sources: [], derivationRole: roleName, contradiction: null, validation: 'ok', model: null, inputTokens: null, outputTokens: null, latencyMs: (dependencies.now || Date.now)() - start, error: null };
    await dependencies.save(log);
    return buildResult(log);
  }

  const controlQuote = 'puede mover los niveles 2 y 3 si mantiene las fechas del nivel 1, las dependencias, los materiales y los compromisos con otros responsables';
  const manualQuote = 'Solo Alex puede moverlos PMC solo notifica desviación';
  const control = corpus.files.flatMap(file => file.sections.map(section => ({ file, section }))).find(item => item.section.text.includes(controlQuote));
  const manual = corpus.files.flatMap(file => file.sections.map(section => ({ file, section }))).find(item => item.section.text.replace(/\s+/gu, ' ').includes(manualQuote));
  const conflictingDates = Boolean(control && manual && control.file.id !== manual.file.id);
  if (control && manual && conflictingDates && /\b(?:nivel(?:es)?\s*[23]|n[23])\b/iu.test(masked) && /mover|cambiar|reprogramar|fecha|plazo/iu.test(masked)) {
      const derivationRole = roles.find(role => /operaciones/iu.test(role.name))?.name || fallbackRole(roles);
      const sources = [
        { doc_id: control.file.id, name: control.file.name, modifiedTime: control.file.modifiedTime, revision: control.file.revision, seccion: control.section.ref, cita: controlQuote },
        { doc_id: manual.file.id, name: manual.file.name, modifiedTime: manual.file.modifiedTime, revision: manual.file.revision, seccion: manual.section.ref, cita: manualQuote },
      ];
      const answer = `Los protocolos no coinciden sobre quién puede cambiar los plazos de los niveles 2 y 3: «${control.file.name}» permite al PMC moverlos bajo condiciones; «${manual.file.name}» indica que solo Alex puede moverlos. Confírmalo con ${derivationRole || 'el responsable'} antes de cambiar la fecha.`;
      const contradiction = { doc_a: control.file.id, doc_b: manual.file.id, descripcion: 'Quién puede mover los plazos de los niveles 2 y 3 de obra' };
      if (containsUnmaskedPersonalData(answer) || maskProtocolQuestion(answer, { clientNames: names }) !== answer) throw new Error('La respuesta contiene datos personales');
      validateProtocolAnswer({ clasificacion: 'no_urgente', respuesta: answer, fuentes: sources.map(({ doc_id, seccion, cita }) => ({ doc_id, seccion, cita })), motivo_no_respuesta: null, cargo_derivacion: derivationRole, contradiccion: contradiction, area: 'responsables_y_escalado', tema: 'cambio de plazos en obra' }, corpus.documents, { roles: roles.map(role => role.name) });
      const log: ProtocolLog = { ...common, answer, classification: 'no_urgente', reason: null, area: 'responsables_y_escalado', topic: 'cambio de plazos en obra', sources, derivationRole, contradiction, validation: 'ok', model: null, inputTokens: null, outputTokens: null, latencyMs: (dependencies.now || Date.now)() - start, error: null };
      await dependencies.save(log);
      return buildResult(log);
  }

  const xml = (value: string) => value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');
  const system = PROTOCOL_SYSTEM_PROMPT_V2
    .replace('{{SINONIMOS}}', 'Incidencia = Alerta (Club LYN); PM = PMC; ClickUp en documentos antiguos = Club LYN para la gestión de tareas.')
    .replace('{{ORGANIGRAMA}}', roles.map(role => `${xml(role.name)}: ${xml(role.person || 'sin asignar')}`).join('\n'))
    .replace('<corpus version="{{CORPUS_VERSION_ID}}" fecha="{{CORPUS_FECHA}}">\n{{CORPUS}}\n</corpus>', protocolCorpusPrompt(corpus));
  const user = `<usuario cargo="${xml(query.role)}" />\n<fecha_hora zona="Europe/Madrid">${new Intl.DateTimeFormat('es-ES', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Madrid' }).format(new Date())}</fecha_hora>\n<temas_existentes>${topics.map(xml).join('\n')}</temas_existentes>\n<pregunta>${xml(masked)}</pregunta>`;
  if (containsUnmaskedPersonalData(user) || maskProtocolQuestion(user, { clientNames: names }) !== user || corpus.files.some(file => containsUnmaskedPersonalData(file.name) || maskProtocolQuestion(file.name, { clientNames: names }) !== file.name || file.sections.some(section => containsUnmaskedPersonalData(section.text) || maskProtocolQuestion(section.text, { clientNames: names }) !== section.text))) throw new Error('El contexto contiene datos personales sin enmascarar');
  let lastError = 'Respuesta no verificable';
  let modelUnavailable = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let generation: { text: string; model: string; inputTokens?: number | null; outputTokens?: number | null };
    let parsed: ProtocolAnswer;
    try {
      generation = await dependencies.generate(system, attempt ? `${user}\nLa respuesta anterior no pasó la validación (${lastError}). Corrige el JSON: cada cita debe ser literal, tener entre 5 y 25 palabras y corresponder al documento y sección indicados. El cargo_derivacion debe ser uno de: ${roles.map(role => xml(role.name)).join(', ')}.` : user);
      const candidate: unknown = JSON.parse(generation.text);
      validateProtocolAnswer(candidate, corpus.documents, { roles: roles.map(role => role.name) });
      parsed = candidate;
      if (conflictingDates && parsed.contradiccion === null && /(?:mover|mueve|cambiar|cambia|reprogramar).{0,100}(?:nivel(?:es)?\s*[23]|tarea(?:s)?\s+de\s+nivel\s*[23])/iu.test(parsed.respuesta)) throw new Error('Hay protocolos contradictorios sobre mover tareas de nivel 2 o 3; no presentes una sola versión como definitiva');
      const topic = normalizeTopic(parsed.tema);
      if (topic.split(' ').length < 2 || /\d/gu.test(topic) || maskProtocolQuestion(topic, { clientNames: names }) !== topic) throw new Error('Tema no normalizado');
      if (containsUnmaskedPersonalData(parsed.respuesta) || maskProtocolQuestion(parsed.respuesta, { clientNames: names }) !== parsed.respuesta || parsed.fuentes.some(source => maskProtocolQuestion(source.cita, { clientNames: names }) !== source.cita)) throw new Error('La respuesta contiene datos personales');
    } catch (error) {
      lastError = error instanceof SyntaxError ? 'JSON inválido' : error instanceof Error ? error.message : 'Error del modelo';
      if (lastError === 'Modelo no disponible') modelUnavailable = true;
      if (modelUnavailable) break;
      continue;
    }
    const sources = parsed.fuentes.map(source => {
      const file = corpus.files.find(item => item.id === source.doc_id)!;
      return { ...source, name: file.name, modifiedTime: file.modifiedTime, revision: file.revision };
    });
    const answer = parsed.motivo_no_respuesta === null ? parsed.respuesta : unansweredText(parsed.motivo_no_respuesta, parsed.cargo_derivacion!);
    const log: ProtocolLog = { ...common, answer, classification: parsed.clasificacion, reason: parsed.motivo_no_respuesta, area: parsed.area, topic: normalizeTopic(parsed.tema), sources, derivationRole: parsed.cargo_derivacion, contradiction: parsed.contradiccion, validation: attempt ? 'reintento' : 'ok', model: generation.model, inputTokens: generation.inputTokens ?? null, outputTokens: generation.outputTokens ?? null, latencyMs: (dependencies.now || Date.now)() - start, error: null };
    await dependencies.save(log);
    return buildResult(log);
  }
  const answer = modelUnavailable ? `El agente de protocolos no está disponible. Consulta con ${roleName || 'tu responsable'}.` : `No tengo una respuesta fiable para esto. Consulta con ${roleName || 'tu responsable'}.`;
  const log: ProtocolLog = { ...common, answer, classification: 'no_urgente', reason: modelUnavailable ? null : 'sin_protocolo', area: 'otro', topic: 'consulta sin respuesta', sources: [], derivationRole: roleName, contradiction: null, validation: 'rechazada', model: null, inputTokens: null, outputTokens: null, latencyMs: (dependencies.now || Date.now)() - start, error: lastError.slice(0, 200) };
  await dependencies.save(log);
  return buildResult(log);
}
