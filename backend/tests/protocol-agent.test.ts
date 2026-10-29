import { describe, expect, it, vi } from 'vitest';
import { askProtocolAgent, type ProtocolLog } from '../protocol-agent.ts';
import { createProtocolCorpus, protocolFileAllowed } from '../protocol-corpus.ts';
import { canReadProtocolLog, containsUnmaskedPersonalData, maskProtocolQuestion } from '../protocol-privacy.ts';
import { callProtocolGemini } from '../protocol-gemini.ts';
import { syntheticCorpus } from './protocol-qa-cases.ts';

const corpus = createProtocolCorpus([{
  id: 'documento-1', name: 'Control de presupuestos', mimeType: 'application/pdf',
  modifiedTime: '2026-10-25T00:00:00Z', revision: 'rev-1', warnings: [],
  sections: [{ ref: 'página 3', text: 'El PMC revisa el presupuesto antes de subirlo a Club LYN.' }],
}], 1000);

const modelAnswer = JSON.stringify({
  clasificacion: 'resuelta', respuesta: 'El PMC revisa el presupuesto antes de subirlo a Club LYN.',
  fuentes: [{ doc_id: 'documento-1', seccion: 'página 3', cita: 'El PMC revisa el presupuesto antes de subirlo' }],
  motivo_no_respuesta: null, cargo_derivacion: null, contradiccion: null,
  area: 'presupuestos', tema: 'Revisión  del presupuesto',
});

function dependencies(responses: string[]) {
  const logs: ProtocolLog[] = [];
  const generate = vi.fn().mockImplementation(async () => ({ text: responses.shift() || '', model: 'flash' }));
  return { logs, generate, loadCorpus: async () => corpus, clientNames: async () => ['María López'], roles: async () => [{ name: 'PMC', person: 'Persona asignada' }], save: async (log: ProtocolLog) => { logs.push(log); } };
}

describe('agente de protocolos', () => {
  it('enmascara datos antes del modelo y del registro, valida y guarda versión y revisión', async () => {
    const services = dependencies([modelAnswer]);
    const result = await askProtocolAgent({ userId: 1, role: 'Interiorista', question: 'María López, maria@example.com, +34600123456: ¿quién revisa el presupuesto?', channel: 'superagente' }, services);
    expect(result.validation).toBe('ok');
    expect(result.sources[0].revision).toBe('rev-1');
    expect(services.generate.mock.calls[0].join(' ')).not.toMatch(/maria@example\.com|\+34600123456|María López/iu);
    expect(services.generate.mock.calls[0].join(' ')).toContain('PMC: Persona asignada');
    expect(services.logs[0].question).toContain('[EMAIL]');
    expect(services.logs[0].question).toContain('[TELÉFONO]');
    expect(services.logs[0].question).toContain('[NOMBRE]');
  });

  it('reintenta una cita inventada y nunca la muestra', async () => {
    const invalidAnswer = JSON.parse(modelAnswer);
    invalidAnswer.fuentes[0].cita = 'El PMC aprueba el presupuesto antes de subirlo';
    const invalid = JSON.stringify(invalidAnswer);
    const services = dependencies([invalid, modelAnswer]);
    const result = await askProtocolAgent({ userId: 1, role: 'PMC', question: '¿Quién revisa el presupuesto?', channel: 'superagente' }, services);
    expect(result.validation).toBe('reintento');
    expect(services.generate).toHaveBeenCalledTimes(2);
    expect(services.generate.mock.calls[1][1]).toContain('Cita no literal');
    expect(services.logs).toHaveLength(1);
  });

  it('registra los tokens de una respuesta válida', async () => {
    const services = dependencies([modelAnswer]);
    services.generate.mockResolvedValue({ text: modelAnswer, model: 'flash', inputTokens: 120, outputTokens: 34 });
    await askProtocolAgent({ userId: 1, role: 'PMC', question: '¿Quién revisa el presupuesto?', channel: 'superagente' }, services);
    expect(services.logs[0].inputTokens).toBe(120);
    expect(services.logs[0].outputTokens).toBe(34);
  });

  it('acorta un tema largo sin rechazar una respuesta validada', async () => {
    const services = dependencies([JSON.stringify({ ...JSON.parse(modelAnswer), tema: 'revisión semanal completa del presupuesto del cliente' })]);
    const result = await askProtocolAgent({ userId: 1, role: 'PMC', question: '¿Quién revisa el presupuesto?', channel: 'superagente' }, services);
    expect(result.validation).toBe('ok');
    expect(services.logs[0].topic).toBe('revision semanal completa del presupuesto');
  });

  it('envía el corpus íntegro al modelo con un prefijo estable', async () => {
    const services = dependencies([modelAnswer]);
    const fullCorpus = createProtocolCorpus([...corpus.files, {
      id: 'documento-2', name: 'Control de materiales', mimeType: 'application/pdf', modifiedTime: '2026-10-25T00:00:00Z',
      revision: 'rev-1', warnings: [], sections: [{ ref: 'página 4', text: 'Cada pedido tiene un responsable.' }],
    }], 1000);
    services.loadCorpus = async () => fullCorpus;
    await askProtocolAgent({ userId: 1, role: 'PMC', question: '¿Quién revisa el presupuesto?', channel: 'superagente' }, services);
    const system = services.generate.mock.calls[0][0];
    expect(system).toContain('El PMC revisa el presupuesto');
    expect(system).toContain('Cada pedido tiene un responsable');
    expect(system.indexOf('Cada pedido tiene un responsable')).toBeLessThan(system.lastIndexOf('<organigrama>'));
    const otherServices = dependencies([modelAnswer]);
    otherServices.loadCorpus = services.loadCorpus;
    otherServices.roles = async () => [{ name: 'PMC', person: 'Otra persona' }];
    await askProtocolAgent({ userId: 2, role: 'PMC', question: '¿Quién revisa el presupuesto?', channel: 'superagente' }, otherServices);
    const otherSystem = otherServices.generate.mock.calls[0][0];
    const corpusEnd = system.indexOf('</corpus>') + '</corpus>'.length;
    expect(otherSystem.slice(0, corpusEnd)).toBe(system.slice(0, corpusEnd));
  });

  it('interpreta una descripción indirecta sin exigir palabras exactas del protocolo', async () => {
    const services = dependencies([modelAnswer]);
    const question = 'Ya tengo listo el Excel, pero no sé quién debe darle el visto bueno antes de compartirlo.';
    const result = await askProtocolAgent({ userId: 1, role: 'PMC', question, channel: 'superagente' }, services);
    expect(result.classification).toBe('resuelta');
    expect(result.sources).toHaveLength(1);
    expect(services.generate.mock.calls[0][0]).toContain('Relaciona la situación con el procedimiento');
    expect(services.generate.mock.calls[0][1]).toContain(question);
  });

  it('permite aclarar el impacto de un retraso genérico sin clasificarlo como emergencia', async () => {
    const services = dependencies([JSON.stringify({
      clasificacion: 'aclaracion', respuesta: '¿Qué entrega se retrasa y afecta a una fecha Máxima o Crítica?', fuentes: [],
      motivo_no_respuesta: null, cargo_derivacion: null, contradiccion: null, area: 'obra', tema: 'retraso de entrega',
    })]);
    const result = await askProtocolAgent({ userId: 1, role: 'PMC', question: 'Tengo una entrega encima y vamos tarde.', channel: 'superagente' }, services);
    expect(result.classification).toBe('aclaracion');
    expect(result.answer).toContain('¿Qué entrega');
    expect(services.generate).toHaveBeenCalledTimes(1);
  });

  it('no acepta una sola versión de una regla contradictoria aunque el usuario no mencione los niveles', async () => {
    const oneSided = JSON.stringify({ ...JSON.parse(modelAnswer), respuesta: 'El PMC puede mover los niveles 2 y 3 si mantiene las fechas del nivel 1.', fuentes: [{ doc_id: 'OBRA', seccion: 'diapositiva 5', cita: 'puede mover los niveles 2 y 3 si mantiene las fechas del nivel 1' }], area: 'obra', tema: 'retraso de entrega' });
    const clarification = JSON.stringify({ clasificacion: 'aclaracion', respuesta: '¿El retraso afecta una tarea de nivel 2 o 3 o una fecha protegida?', fuentes: [], motivo_no_respuesta: null, cargo_derivacion: null, contradiccion: null, area: 'obra', tema: 'retraso de entrega' });
    const services = dependencies([oneSided, clarification]);
    services.loadCorpus = async () => syntheticCorpus;
    const result = await askProtocolAgent({ userId: 1, role: 'PMC', question: 'Vamos tarde con una entrega y no sé cómo proceder.', channel: 'superagente' }, services);
    expect(result.classification).toBe('aclaracion');
    expect(services.generate.mock.calls[1][1]).toContain('protocolos contradictorios');
    expect(services.logs[0].answer).not.toContain('puede mover');
  });

  it('tras dos fallos devuelve y registra una respuesta segura', async () => {
    const services = dependencies(['no es JSON', 'tampoco']);
    const result = await askProtocolAgent({ userId: 1, role: 'PMC', question: '¿Cuándo revisamos?', channel: 'superagente' }, services);
    expect(result.validation).toBe('rechazada');
    expect(result.answer).toContain('No tengo una respuesta fiable');
    expect(services.logs[0].sources).toEqual([]);
  });

  it('no reintenta una indisponibilidad del proveedor', async () => {
    const services = dependencies([]);
    services.generate.mockRejectedValue(new Error('Modelo no disponible'));
    const result = await askProtocolAgent({ userId: 1, role: 'PMC', question: '¿Cuándo revisamos?', channel: 'superagente' }, services);
    expect(result.validation).toBe('rechazada');
    expect(result.answer).toContain('no está disponible');
    expect(services.generate).toHaveBeenCalledTimes(1);
  });

  it('no muestra pasos inventados aunque el modelo los incluya en una respuesta sin protocolo', async () => {
    const unsafe = JSON.stringify({ clasificacion: 'no_urgente', respuesta: 'Hay que pagar 500 euros en tres días.', fuentes: [], motivo_no_respuesta: 'sin_protocolo', cargo_derivacion: 'PMC', contradiccion: null, area: 'otro', tema: 'consulta sin protocolo' });
    const services = dependencies([unsafe]);
    const result = await askProtocolAgent({ userId: 1, role: 'PMC', question: '¿Qué hago sin protocolo?', channel: 'superagente' }, services);
    expect(result.answer).toContain('No encuentro una respuesta');
    expect(result.answer).not.toContain('500');
    expect(services.logs[0].answer).toBe(result.answer);
  });

  it('atiende el riesgo de seguridad sin esperar al modelo', async () => {
    const services = dependencies([]);
    const result = await askProtocolAgent({ userId: 1, role: 'PMC', question: 'Hay olor a gas en la obra', channel: 'superagente' }, services);
    expect(result.classification).toBe('urgente');
    expect(result.answer).toContain('112');
    expect(services.generate).not.toHaveBeenCalled();
  });

  it('no incluye subcarpetas y mantiene un id inmutable por revisión', () => {
    expect(protocolFileAllowed('Control', 'protocolos', 'protocolos')).toBe(true);
    expect(protocolFileAllowed('Plantillas Quantifier', 'quantifier', 'protocolos')).toBe(false);
    expect(createProtocolCorpus(corpus.files, 1000).id).toBe(corpus.id);
    expect(createProtocolCorpus([{ ...corpus.files[0], revision: 'rev-2' }], 1000).id).not.toBe(corpus.id);
    expect(() => createProtocolCorpus(corpus.files, 1)).toThrow('supera el límite');
  });

  it('enmascara teléfonos nacionales y bloquea datos personales residuales', () => {
    expect(maskProtocolQuestion('Llama al 600 123 456; DNI 12345678Z')).toBe('Llama al [TELÉFONO]; DNI [DNI]');
    expect(containsUnmaskedPersonalData('maria@example.com')).toBe(true);
    expect(containsUnmaskedPersonalData('[EMAIL]')).toBe(false);
  });

  it('deniega el registro por defecto y solo admite nombres configurados exactamente', () => {
    expect(canReadProtocolLog('employee:director')).toBe(true);
    expect(canReadProtocolLog('employee:director_general')).toBe(true);
    expect(canReadProtocolLog('employee:direccion_de_operaciones')).toBe(true);
    expect(canReadProtocolLog('superadmin')).toBe(true);
    expect(canReadProtocolLog('admin')).toBe(false);
    expect(canReadProtocolLog('employee:pmc_proyectos')).toBe(false);
  });

  it('no envía al modelo un documento con datos personales de clientes', async () => {
    const services = dependencies([modelAnswer]);
    services.loadCorpus = async () => createProtocolCorpus([{ ...corpus.files[0], name: 'Caso María López' }], 1000);
    await expect(askProtocolAgent({ userId: 1, role: 'PMC', question: '¿Quién revisa?', channel: 'superagente' }, services)).rejects.toThrow('datos personales');
    expect(services.generate).not.toHaveBeenCalled();
  });

  it('envía JSON estructurado con temperatura cero sin guardar la interacción en Google', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ output_text: modelAnswer }));
    const result = await callProtocolGemini('reglas', 'pregunta enmascarada', { apiKey: 'test-key', model: 'test-model', fetcher });
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(result.text).toBe(modelAnswer);
    expect(body.store).toBe(false);
    expect(body.generation_config.temperature).toBe(0);
    expect(body.response_format.mime_type).toBe('application/json');
    expect(body.system_instruction).toBe('reglas');
  });
});
