import { describe, expect, it } from 'vitest';
import { claveEmail, claveTelefono, vincularLlamadaConLead, type LeadCandidato } from '../netelip/captacion/vinculacion.ts';

const lead = (id: string, extra: Partial<LeadCandidato> = {}): LeadCandidato => ({
  clickupTaskId: id, esTareaPadre: true, telefono: null, email: null, ...extra,
});

describe('claves de comparación', () => {
  it('el teléfono se compara solo por dígitos y sin el 00 internacional', () => {
    expect(claveTelefono('+34 600-111-222')).toBe('600111222');
    expect(claveTelefono('0034600111222')).toBe('600111222');
    expect(claveTelefono('(+34) 600 111 222')).toBe('600111222');
  });
  it('un número español con y sin prefijo 34 es el mismo teléfono', () => {
    expect(claveTelefono('600 111 222')).toBe('600111222');
    expect(claveTelefono('+34600111222')).toBe(claveTelefono('600111222'));
  });
  it('un número de otro país conserva todos sus dígitos y un nacional de 9 que empieza por 34 no se recorta', () => {
    expect(claveTelefono('+44 7700 900123')).toBe('447700900123');
    expect(claveTelefono('+1 415 555 0132')).toBe('14155550132');
    expect(claveTelefono('341234567')).toBe('341234567');
    expect(claveTelefono('+34 123 456 7890')).toBe('341234567890');
  });
  it('el mismo teléfono escrito con y sin prefijo en dos leads cuenta como repetido', () => {
    const r = vincularLlamadaConLead({ telefono: '+34611333444' }, [lead('t1', { telefono: '+34 611 333 444' }), lead('t2', { telefono: '611333444' })]);
    expect(r).toEqual({ estado: 'sin_lead', motivo: 'varias_coincidencias' });
  });
  it('un número oculto, vacío o demasiado corto no sirve', () => {
    expect(claveTelefono('anonymous')).toBeNull();
    expect(claveTelefono('')).toBeNull();
    expect(claveTelefono(null)).toBeNull();
    expect(claveTelefono('12345')).toBeNull();
  });
  it('el email se compara en minúsculas y sin espacios', () => {
    expect(claveEmail('  Ana.Lopez@Correo.ES ')).toBe('ana.lopez@correo.es');
    expect(claveEmail('sin-arroba')).toBeNull();
    expect(claveEmail(null)).toBeNull();
  });
});

describe('vincular una llamada con su lead', () => {
  it('por teléfono, con una coincidencia única', () => {
    const r = vincularLlamadaConLead({ telefono: '+34600111222' }, [lead('t1', { telefono: '+34 600 111 222' }), lead('t2', { telefono: '+34611000000' })]);
    expect(r).toEqual({ estado: 'vinculado', clickupTaskId: 't1', via: 'telefono' });
  });

  it('si ningún teléfono coincide, por email', () => {
    const r = vincularLlamadaConLead(
      { telefono: '+34699999999', email: 'ANA@correo.es' },
      [lead('t1', { telefono: '+34600111222', email: 'ana@correo.es' })],
    );
    expect(r).toEqual({ estado: 'vinculado', clickupTaskId: 't1', via: 'email' });
  });

  it('una llamada con número oculto se vincula por email', () => {
    const r = vincularLlamadaConLead({ telefono: 'anonymous', email: 'ana@correo.es' }, [lead('t1', { email: 'ana@correo.es' })]);
    expect(r).toMatchObject({ estado: 'vinculado', via: 'email' });
  });

  it('con varias tareas con el mismo teléfono queda «sin lead» y no recurre al email', () => {
    const r = vincularLlamadaConLead(
      { telefono: '+34600111222', email: 'ana@correo.es' },
      [lead('t1', { telefono: '+34600111222' }), lead('t2', { telefono: '+34600111222', email: 'ana@correo.es' })],
    );
    expect(r).toEqual({ estado: 'sin_lead', motivo: 'varias_coincidencias' });
  });

  it('con varias tareas con el mismo email queda «sin lead»', () => {
    const r = vincularLlamadaConLead({ email: 'ana@correo.es' }, [lead('t1', { email: 'ana@correo.es' }), lead('t2', { email: 'ana@correo.es' })]);
    expect(r).toEqual({ estado: 'sin_lead', motivo: 'varias_coincidencias' });
  });

  it('las subtareas se ignoran', () => {
    const r = vincularLlamadaConLead(
      { telefono: '+34600111222' },
      [lead('padre', { telefono: '+34600111222' }), lead('sub', { telefono: '+34600111222', esTareaPadre: false })],
    );
    expect(r).toEqual({ estado: 'vinculado', clickupTaskId: 'padre', via: 'telefono' });
  });

  it('si solo hay una subtarea con ese teléfono, no hay lead', () => {
    const r = vincularLlamadaConLead({ telefono: '+34600111222' }, [lead('sub', { telefono: '+34600111222', esTareaPadre: false })]);
    expect(r).toEqual({ estado: 'sin_lead', motivo: 'sin_coincidencia' });
  });

  it('la misma tarea repetida en la lista cuenta como una', () => {
    const r = vincularLlamadaConLead({ telefono: '+34600111222' }, [lead('t1', { telefono: '+34600111222' }), lead('t1', { telefono: '+34600111222' })]);
    expect(r).toMatchObject({ estado: 'vinculado', clickupTaskId: 't1' });
  });

  it('sin teléfono ni email válidos no hay datos para vincular', () => {
    expect(vincularLlamadaConLead({ telefono: 'anonymous' }, [lead('t1', { telefono: '+34600111222' })])).toEqual({ estado: 'sin_lead', motivo: 'sin_datos' });
    expect(vincularLlamadaConLead({}, [])).toEqual({ estado: 'sin_lead', motivo: 'sin_datos' });
  });

  it('sin ninguna coincidencia queda «sin lead»', () => {
    expect(vincularLlamadaConLead({ telefono: '+34600111222', email: 'x@y.es' }, [lead('t1', { telefono: '+34611000000', email: 'otro@y.es' })]))
      .toEqual({ estado: 'sin_lead', motivo: 'sin_coincidencia' });
  });

  it('un lead sin teléfono no coincide con una llamada sin teléfono', () => {
    expect(vincularLlamadaConLead({ email: 'a@b.es' }, [lead('t1')])).toEqual({ estado: 'sin_lead', motivo: 'sin_coincidencia' });
  });
});
