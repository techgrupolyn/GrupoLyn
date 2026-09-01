import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/ceo-dashboard/api', () => ({
  default: {
    directory: {
      overview: vi.fn().mockResolvedValue({ employees: [], clients: [], projects: [] }),
    },
    meetings: {
      list: vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 25, total: 0, totalPages: 0, metrics: {} }),
      filterOptions: vi.fn().mockResolvedValue({ pmcs: [] }),
      reanalyzeMissingPmc: vi.fn().mockResolvedValue({ queued: 0 }),
      retag: vi.fn().mockResolvedValue({}),
      get: vi.fn(),
    },
  },
}));

import MeetingManagementView from '../src/ceo-dashboard/views/MeetingManagementView';

describe('MeetingManagementView', () => {
  it('renders the pending PMC reanalysis control without runtime state errors', async () => {
    render(<MeetingManagementView />);

    expect(screen.getByRole('button', { name: 'Reanalizar PMC pendientes' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});