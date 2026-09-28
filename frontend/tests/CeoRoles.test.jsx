import { describe, expect, it } from 'vitest';
import { isMeetingEditorCeoUser, isMeetingLimitedCeoUser } from '../src/ceo-dashboard/CeoLogin';

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
