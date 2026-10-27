import { describe, expect, it } from 'vitest';
import { canDeleteMeetingActionsForRole, meetingReviewChain } from '../meeting-routing.ts';

describe('Permisos y orden de reuniones', () => {
  it.each(['PMC', 'PMC / Proyectos', 'Jefe de Proyectos', 'Director', 'Director General', 'employee:director_general'])('permite borrar al cargo %s', (role) => {
    expect(canDeleteMeetingActionsForRole(role)).toBe(true);
  });
  it.each(['superadmin', 'admin', 'ceo', 'Delineante', 'PMC en prácticas', 'Interiorista', 'Dirección de Operaciones', 'Director de proyecto', 'employee:member', ''])('no permite borrar al cargo %s', (role) => {
    expect(canDeleteMeetingActionsForRole(role)).toBe(false);
  });
  it('no incluye Dirección en la cadena automática', () => {
    expect(meetingReviewChain.map(([stage]) => stage)).toEqual(['organizer', 'delineante', 'pmc']);
  });
});
