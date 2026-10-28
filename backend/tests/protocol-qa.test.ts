import { describe, expect, it } from 'vitest';
import { askProtocolAgent, type ProtocolLog } from '../protocol-agent.ts';
import { protocolQaCases, syntheticCorpus } from './protocol-qa-cases.ts';

describe('25 preguntas de aceptación provisionales', () => {
  it('cubre 15 con respuesta, 5 sin protocolo, 3 urgentes y 2 contradicciones', () => {
    expect(protocolQaCases).toHaveLength(25);
    expect(protocolQaCases.filter(item => item.category === 'con_respuesta')).toHaveLength(15);
    expect(protocolQaCases.filter(item => item.category === 'sin_protocolo')).toHaveLength(5);
    expect(protocolQaCases.filter(item => item.category === 'urgente')).toHaveLength(3);
    expect(protocolQaCases.filter(item => item.category === 'contradiccion')).toHaveLength(2);
  });

  for (const testCase of protocolQaCases) {
    it(`${testCase.category}: ${testCase.question}`, async () => {
      const logs: ProtocolLog[] = [];
      let modelCalls = 0;
      const result = await askProtocolAgent({ userId: 1, role: 'PMC', question: testCase.question, channel: 'superagente' }, {
        loadCorpus: async () => syntheticCorpus,
        clientNames: async () => [],
        roles: async () => [{ name: 'PMC' }, { name: 'Operaciones' }],
        generate: async () => { modelCalls += 1; return { text: JSON.stringify(testCase.answer), model: 'fixture' }; },
        save: async log => { logs.push(log); },
      });
      expect(result.classification).toBe(testCase.expected);
      expect(result.validation).toBe('ok');
      expect(logs).toHaveLength(1);
      expect(modelCalls).toBe(['urgente', 'contradiccion'].includes(testCase.category) ? 0 : 1);
    });
  }
});
