// Lead de las reuniones de Meet (869fppbcj): solo con un único contacto coincidente. Sin base de datos ni ClickUp.
import { describe, expect, it } from 'vitest';
import { decidirLead, emailsExternos } from '../reuniones-meet/lead.ts';

const inv = (email: string, interno = false) => ({ email, nombre: null, respuesta: null, organizador: false, interno });

describe('emailsExternos', () => {
  it('descarta a los del equipo y los repetidos', () => {
    expect(emailsExternos([inv('ernesto@lyn.example', true), inv('Garcia@Example.com'), inv('garcia@example.com'), inv('ana@example.net')]))
      .toEqual(['garcia@example.com', 'ana@example.net']);
    expect(emailsExternos(null)).toEqual([]);
  });
});

describe('decidirLead', () => {
  it('un único contacto (aunque coincidan dos invitados con él) → vinculado', () => {
    expect(decidirLead(['garcia@example.com', 'pareja@example.com'], [{ id: '86abc' }, { id: '86abc' }]))
      .toEqual({ lead_estado: 'vinculado', lead_id: '86abc', lead_motivo: null, lead_etapa: null });
  });

  it('ninguno → sin_lead', () => {
    expect(decidirLead(['garcia@example.com'], [])).toMatchObject({ lead_estado: 'sin_lead', lead_id: null });
  });

  it('varios contactos distintos → sin_lead, sin elegir uno', () => {
    const d = decidirLead(['garcia@example.com'], [{ id: '86a' }, { id: '86b' }]);
    expect(d).toMatchObject({ lead_estado: 'sin_lead', lead_id: null });
    expect(d.lead_motivo).toContain('2 contactos');
  });

  it('sin invitados externos → sin_lead', () => {
    expect(decidirLead([], [{ id: '86a' }])).toMatchObject({ lead_estado: 'sin_lead', lead_motivo: 'La reunión no tiene invitados externos.' });
  });
});
