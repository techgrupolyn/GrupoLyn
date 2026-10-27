import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/ceo-dashboard/views/MeetingReviewDrawer', () => ({ default: vi.fn(({ projectReview }) => <div>{projectReview.chain}</div>) }));
import MeetingReviewDrawer from '../src/ceo-dashboard/views/MeetingReviewDrawer';
import ProjectMeetingReviewDrawer from '../src/ceo-dashboard/views/ProjectMeetingManagement';

describe('Cargos del lateral según la obra seleccionada', () => {
  it('la misma persona cambia de PMC a Delineante sin heredar etiquetas del otro proyecto', () => {
    const meeting = {
      id: 'meeting', enabled: true, status: 'pending', history: [], pmc_in_training: true,
      directory: [{ id: 'same-person', name: 'Persona compartida' }, { id: 'other-pmc', name: 'PMC de segunda obra' }],
      add_projects: [{ id: 'first', name: 'Primera obra' }, { id: 'second', name: 'Segunda obra' }],
      branches: [
        { id: 'first-branch', project_id: 'first', project_name: 'Primera obra', cursor: 0, snapshot: { pmcId:'same-person',path: [{ employeeId: 'same-person', name: 'Persona compartida', cargo: 'PMC', final: true }] } },
        { id: 'second-branch', project_id: 'second', project_name: 'Segunda obra', cursor: 0, snapshot: { pmcId:'other-pmc',path: [{ employeeId: 'same-person', name: 'Persona compartida', cargo: 'Delineante', final: false }, { employeeId: 'other-pmc', name: 'PMC de segunda obra', cargo: 'PMC', final: true }] } },
      ],
      actions: [{ id: 'first-action', project_id: 'first' }, { id: 'second-action', project_id: 'second' }],
    };
    render(<ProjectMeetingReviewDrawer meeting={meeting} onClose={vi.fn()} onChanged={vi.fn()} />);
    const first = MeetingReviewDrawer.mock.calls.at(-1)[0].meeting;
    expect(first.pmc_employee_id).toBe('same-person');
    expect(first.pmc_in_training).toBe(false);
    expect(first.actions[0].assignment_directory.employees[0].roles).toEqual(['PMC']);
    fireEvent.change(screen.getByLabelText('Rama de revisión'), { target: { value: 'second-branch' } });
    const second = MeetingReviewDrawer.mock.calls.at(-1)[0].meeting;
    expect(second.pmc_employee_id).toBe('other-pmc');
    expect(second.assignment_directory.employees[0].roles).toEqual(['Delineante']);
    expect(second.actions[0].id).toBe('second-action');
    expect(second.actions[0].assignment_directory.employees[0].roles).toEqual(['Delineante']);
    expect(second.pmc_in_training).toBe(false);
  });
});
