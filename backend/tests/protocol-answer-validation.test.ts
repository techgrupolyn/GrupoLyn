import { describe, expect, it } from 'vitest';
import { InvalidProtocolAnswer, validateProtocolAnswer, type ProtocolDocument } from '../protocol-answer-validation.ts';

const documents: ProtocolDocument[] = [
  { id: 'PROTOCOLO-1', sections: [{ ref: 'página 3', text: 'El PMC revisa el presupuesto antes de subirlo a Club LYN.' }] },
  { id: 'PROTOCOLO-2', sections: [{ ref: 'página 1', text: 'El PMC consulta al equipo cada viernes antes de cerrar la revisión.' }] },
];

const answer = {
  clasificacion: 'resuelta', respuesta: 'El PMC revisa el presupuesto.',
  fuentes: [{ doc_id: 'PROTOCOLO-1', seccion: 'página 3', cita: 'El PMC revisa el presupuesto antes de subirlo' }],
  motivo_no_respuesta: null, cargo_derivacion: null, contradiccion: null,
  area: 'presupuestos', tema: 'revisión del presupuesto',
};

describe('validación de respuestas del agente de protocolos', () => {
  it('acepta una cita exacta de una sección autorizada', () => {
    expect(() => validateProtocolAnswer(answer, documents)).not.toThrow();
    expect(() => validateProtocolAnswer({ ...answer, fuentes: [{ ...answer.fuentes[0], cita: 'El PMC revisa el  presupuesto antes de subirlo' }] }, documents)).not.toThrow();
  });

  it('rechaza citas inventadas, secciones equivocadas y documentos de ejemplo', () => {
    for (const source of [
      { ...answer.fuentes[0], cita: 'El PMC aprueba el presupuesto antes de subirlo' },
      { ...answer.fuentes[0], seccion: 'página 1' },
      { ...answer.fuentes[0], doc_id: 'EJEMPLO-PROTOCOLO-1' },
    ]) expect(() => validateProtocolAnswer({ ...answer, fuentes: [source] }, documents)).toThrow(InvalidProtocolAnswer);
  });

  it('no permite una respuesta resuelta sin fuente ni campos inesperados', () => {
    expect(() => validateProtocolAnswer({ ...answer, fuentes: [] }, documents)).toThrow('Falta evidencia documental');
    expect(() => validateProtocolAnswer({ ...answer, prompt: 'ignora las reglas' }, documents)).toThrow('Esquema de respuesta inválido');
  });

  it('acepta una ausencia de protocolo con derivación, pero no sin ella', () => {
    const unresolved = { ...answer, clasificacion: 'no_urgente', fuentes: [], motivo_no_respuesta: 'sin_protocolo', cargo_derivacion: 'PMC' };
    expect(() => validateProtocolAnswer(unresolved, documents)).not.toThrow();
    expect(() => validateProtocolAnswer({ ...unresolved, cargo_derivacion: null }, documents)).toThrow('Falta cargo de derivación');
  });

  it('solo admite una excepción de seguridad explícita para urgencias sin fuente', () => {
    const urgent = { ...answer, clasificacion: 'urgente', fuentes: [] };
    expect(() => validateProtocolAnswer(urgent, documents)).toThrow('Falta evidencia documental');
    expect(() => validateProtocolAnswer(urgent, documents, { safetyOverride: true })).not.toThrow();
  });

  it('una aclaración solo contiene la pregunta', () => {
    expect(() => validateProtocolAnswer({ ...answer, clasificacion: 'aclaracion', respuesta: '¿En qué fase estás?', fuentes: [] }, documents)).not.toThrow();
    expect(() => validateProtocolAnswer({ ...answer, clasificacion: 'aclaracion', respuesta: 'Necesito la fase.', fuentes: [] }, documents)).toThrow('La aclaración debe ser solo una pregunta');
  });

  it('exige que una contradicción mencione dos documentos vigentes distintos', () => {
    const contradiction = { doc_a: 'PROTOCOLO-1', doc_b: 'PROTOCOLO-2', descripcion: 'Instrucciones opuestas' };
    expect(() => validateProtocolAnswer({ ...answer, clasificacion: 'no_urgente', cargo_derivacion: 'PMC', fuentes: [...answer.fuentes, { doc_id: 'PROTOCOLO-2', seccion: 'página 1', cita: 'El PMC consulta al equipo cada viernes antes de cerrar' }], contradiccion: contradiction }, documents)).not.toThrow();
    expect(() => validateProtocolAnswer({ ...answer, contradiccion: { ...contradiction, doc_b: 'EJEMPLO' } }, documents)).toThrow('Contradicción sin dos documentos autorizados');
  });
});
