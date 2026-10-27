import { describe, expect, it } from 'vitest';
import { matchActionResponsible, type ActionDirectoryPerson } from '../meeting-action-linking.ts';

describe('vinculación conservadora de responsables', () => {
  const employee: ActionDirectoryPerson = { id: 'employee', kind: 'employee', name: 'Ernesto Gras' };
  const customer: ActionDirectoryPerson = { id: 'customer', kind: 'client', name: 'SOLEDAD TAMARIZ-MARTEL MORENO' };
  it('admite apellidos adicionales y clientes con acentos, guiones o espacios', () => {
    expect(matchActionResponsible('Ernesto Gras Asensi', [employee, customer])).toEqual(employee);
    expect(matchActionResponsible('  Soledád Tamariz Martel ', [employee, customer])).toEqual(customer);
  });
  it('rechaza homónimos aunque uno sea una coincidencia exacta', () => {
    expect(matchActionResponsible('Ernesto Gras', [employee, { ...employee, id: 'other', name: 'Ernesto Gras García' }])).toBeNull();
    expect(matchActionResponsible('Ernesto Gras', [employee, { ...employee, kind: 'client' }])).toBeNull();
  });
  it.each(['', 'Ernesto', 'El grupo', 'Planimetristas Grupo LYN', 'Dalia Peran', 'Gras Ernesto', 'Ernesto Gras y Soledad', 'Ernesto Gras / Soledad'])('no inventa asignaciones para %s', (name) => {
    expect(matchActionResponsible(name, [employee, customer])).toBeNull();
  });
});
