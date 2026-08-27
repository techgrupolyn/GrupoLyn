import { describe, expect, it } from 'vitest';
import { meetingApprovalBlockers } from '../server.ts';

describe('Flujo de aprobación de reuniones', () => {
  it('bloquea solo acciones pendientes sin responsable o fecha', () => {
    expect(meetingApprovalBlockers([
      { status: 'pending', responsible: '', due_date: null },
      { status: 'pending', responsible: 'Marta', due_date: null },
      { status: 'done', responsible: '', due_date: null },
    ])).toEqual({ missingResponsible: 1, missingDueDate: 2 });
  });
});