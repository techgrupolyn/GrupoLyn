import { describe, expect, it } from 'vitest';
import { canAccessMarketing, canAccessNetelipCalls, isMeetingEditorCeoUser, isMeetingLimitedCeoUser, isConsultorCeoUser } from '../src/ceo-dashboard/CeoLogin';

describe('Acceso de dirección', () => {
  it.each(['director', 'director_general', 'direccion_de_operaciones', 'director_de_operaciones'])('permite navegación y edición a %s', (role) => {
    const user = { rol: `employee:${role}` };
    expect(isMeetingLimitedCeoUser(user)).toBe(false);
    expect(isMeetingEditorCeoUser(user)).toBe(true);
  });

  it.each(['interiorista', 'planimetrista', 'director_de_proyecto', 'member'])('no amplía acceso por similitud del rol %s', (role) => {
    const user = { rol: `employee:${role}` };
    expect(isMeetingLimitedCeoUser(user)).toBe(true);
    expect(isMeetingEditorCeoUser(user)).toBe(false);
  });
});

describe('Netelip · Historial de llamadas', () => {
  it.each(['superadmin', 'admin', 'employee:superadmin', 'employee:admin', 'employee:director', 'employee:director_general'])('lo ve %s', (rol) => {
    expect(canAccessNetelipCalls({ rol })).toBe(true);
  });

  it.each(['employee:superadmin', 'employee:admin'])('CAL-09: %s del directorio tiene el menú completo, no el limitado', (rol) => {
    expect(isMeetingLimitedCeoUser({ rol })).toBe(false);
    expect(isMeetingEditorCeoUser({ rol })).toBe(true);
  });
  it.each(['ceo', 'employee:direccion_de_operaciones', 'employee:director_de_operaciones', 'employee:pmc_proyectos', 'consulta_publica', ''])('no lo ve %s', (rol) => {
    expect(canAccessNetelipCalls({ rol })).toBe(false);
  });
});

describe('Consultor de solo lectura (consultor_lectura)', () => {
  it('ve las llamadas, no edita reuniones y no tiene el menú limitado de empleado', () => {
    const rol = 'consultor_lectura';
    expect(isConsultorCeoUser({ rol })).toBe(true);
    expect(canAccessNetelipCalls({ rol })).toBe(true);
    expect(canAccessMarketing({ rol })).toBe(false);
    expect(isMeetingEditorCeoUser({ rol })).toBe(false);
    expect(isMeetingLimitedCeoUser({ rol })).toBe(false);
  });

  it.each(['superadmin', 'employee:director', 'employee:pmc_proyectos', ''])('%s no es consultor', (rol) => {
    expect(isConsultorCeoUser({ rol })).toBe(false);
  });
});
