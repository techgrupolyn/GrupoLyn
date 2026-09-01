import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/ceo-dashboard/api', () => ({
  default: {
    directory: {
      overview: vi.fn(),
    },
    meetings: {
      list: vi.fn(),
      filterOptions: vi.fn(),
      reanalyzeMissingPmc: vi.fn(),
      retag: vi.fn(),
      get: vi.fn(),
    },
  },
}));

import api from '../src/ceo-dashboard/api';
import MeetingManagementView from '../src/ceo-dashboard/views/MeetingManagementView';

const emptyList = { items: [], page: 1, pageSize: 25, total: 0, totalPages: 0, metrics: {} };
const meeting = {
  id: 'meeting-1',
  name: 'Comité de obra · Prueba',
  meeting_date: '2026-09-01',
  meeting_kind: 'COMITE_OBRA',
  analysis_status: 'completed',
  workflow_stage: 'agent',
  status: 'draft',
  actions: [],
  blockers: { missingResponsible: 0, missingDueDate: 0 },
  detected_blockers: [],
  versions: [],
  summary: '',
  decisions: '',
};

beforeEach(() => {
  vi.mocked(api.directory.overview).mockResolvedValue({ employees: [], clients: [], projects: [] });
  vi.mocked(api.meetings.list).mockResolvedValue(emptyList);
  vi.mocked(api.meetings.filterOptions).mockResolvedValue({ pmcs: [] });
  vi.mocked(api.meetings.reanalyzeMissingPmc).mockResolvedValue({ queued: 0 });
  vi.mocked(api.meetings.retag).mockResolvedValue({});
  vi.mocked(api.meetings.get).mockResolvedValue(meeting);
});

describe('MeetingManagementView', () => {
  it('opens a meeting detail without referencing parent-only state', async () => {
    vi.mocked(api.meetings.list).mockResolvedValue({ ...emptyList, items: [meeting], total: 1, totalPages: 1 });
    render(<MeetingManagementView />);

    fireEvent.click(await screen.findByText(meeting.name));

    expect(await screen.findByRole('dialog', { name: 'Detalle de reunión' })).toHaveTextContent('PMC a cargo: Pendiente');
  });
});