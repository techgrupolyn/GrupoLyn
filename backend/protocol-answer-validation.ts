export type ProtocolSection = { ref: string; text: string };
export type ProtocolDocument = { id: string; sections: ProtocolSection[] };
export type ProtocolAnswer = {
  clasificacion: 'resuelta' | 'no_urgente' | 'urgente' | 'aclaracion';
  respuesta: string;
  fuentes: Array<{ doc_id: string; seccion: string; cita: string }>;
  motivo_no_respuesta: null | 'sin_protocolo' | 'fuera_de_alcance' | 'tema_sensible';
  cargo_derivacion: string | null;
  contradiccion: null | { doc_a: string; doc_b: string; descripcion: string };
  area: string;
  tema: string;
};

const classifications = new Set(['resuelta', 'no_urgente', 'urgente', 'aclaracion']);
const reasons = new Set(['sin_protocolo', 'fuera_de_alcance', 'tema_sensible']);
const areas = new Set(['diseno', 'presupuestos', 'materiales', 'obra', 'revisiones_y_reuniones', 'responsables_y_escalado', 'uso_de_club_lyn', 'otro']);
const fields = ['clasificacion', 'respuesta', 'fuentes', 'motivo_no_respuesta', 'cargo_derivacion', 'contradiccion', 'area', 'tema'];

export class InvalidProtocolAnswer extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidProtocolAnswer';
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function fail(message: string): never {
  throw new InvalidProtocolAnswer(message);
}

export function validateProtocolAnswer(answer: unknown, documents: ProtocolDocument[], options: { safetyOverride?: boolean; roles?: string[] } = {}): asserts answer is ProtocolAnswer {
  if (!record(answer) || Object.keys(answer).sort().join('|') !== [...fields].sort().join('|')) fail('Esquema de respuesta inválido');
  if (!classifications.has(answer.clasificacion as string) || !nonempty(answer.respuesta) || !areas.has(answer.area as string) || !nonempty(answer.tema)) fail('Campos de respuesta inválidos');
  if (answer.motivo_no_respuesta !== null && !reasons.has(answer.motivo_no_respuesta as string)) fail('Motivo inválido');
  if (answer.cargo_derivacion !== null && !nonempty(answer.cargo_derivacion)) fail('Cargo inválido');
  if (!Array.isArray(answer.fuentes)) fail('Fuentes inválidas');

  const documentById = new Map(documents.map(document => [document.id, document]));
  if (documentById.size !== documents.length) fail('Identificadores de documentos duplicados');
  for (const source of answer.fuentes) {
    if (!record(source) || Object.keys(source).sort().join('|') !== 'cita|doc_id|seccion' || !nonempty(source.doc_id) || !nonempty(source.seccion) || !nonempty(source.cita)) fail('Fuente inválida');
    const section = documentById.get(source.doc_id)?.sections.find(item => item.ref === source.seccion);
    const normalizeSpaces = (value: string) => value.replace(/\s+/gu, ' ').trim();
    if (!section || !normalizeSpaces(section.text).includes(normalizeSpaces(source.cita))) fail('Cita no literal o documento/sección no autorizados');
    const wordCount = source.cita.trim().split(/\s+/u).length;
    if (wordCount < 5 || wordCount > 25) fail('La cita debe tener entre 5 y 25 palabras');
  }

  if (answer.motivo_no_respuesta !== null && answer.cargo_derivacion === null) fail('Falta cargo de derivación');
  if (answer.motivo_no_respuesta !== null && answer.clasificacion !== 'no_urgente') fail('Una respuesta sin protocolo requiere derivación no urgente');
  if (answer.cargo_derivacion !== null && options.roles && !options.roles.includes(answer.cargo_derivacion as string)) fail('Cargo de derivación no autorizado');
  if (answer.motivo_no_respuesta === null && answer.clasificacion !== 'aclaracion' && answer.fuentes.length === 0 && !(options.safetyOverride && answer.clasificacion === 'urgente')) fail('Falta evidencia documental');
  if (answer.clasificacion === 'resuelta' && answer.motivo_no_respuesta !== null) fail('Una respuesta resuelta no admite motivo de falta de respuesta');
  if (answer.clasificacion === 'aclaracion' && (!answer.respuesta.trim().endsWith('?') || answer.fuentes.length || answer.motivo_no_respuesta !== null || answer.cargo_derivacion !== null || answer.contradiccion !== null)) fail('La aclaración debe ser solo una pregunta');
  if (answer.contradiccion !== null) {
    if (!record(answer.contradiccion) || Object.keys(answer.contradiccion).sort().join('|') !== 'descripcion|doc_a|doc_b' || !nonempty(answer.contradiccion.doc_a) || !nonempty(answer.contradiccion.doc_b) || !nonempty(answer.contradiccion.descripcion)) fail('Contradicción inválida');
    if (answer.contradiccion.doc_a === answer.contradiccion.doc_b || !documentById.has(answer.contradiccion.doc_a) || !documentById.has(answer.contradiccion.doc_b)) fail('Contradicción sin dos documentos autorizados');
    if (answer.clasificacion !== 'no_urgente' || answer.motivo_no_respuesta !== null || answer.cargo_derivacion === null || !answer.fuentes.some((source: Record<string, unknown>) => source.doc_id === (answer.contradiccion as Record<string, unknown>).doc_a) || !answer.fuentes.some((source: Record<string, unknown>) => source.doc_id === (answer.contradiccion as Record<string, unknown>).doc_b)) fail('Una contradicción requiere ambas fuentes y derivación');
  }
}
