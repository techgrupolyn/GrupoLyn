import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/ceo-dashboard/api', () => ({
  default: {
    googleDrive: {
      status: vi.fn(),
      artifacts: vi.fn(),
      connect: vi.fn(),
      addFolder: vi.fn(),
      removeFolder: vi.fn(),
      syncFolder: vi.fn(),
      artifact: vi.fn(),
    },
  },
}));

import api from '../src/ceo-dashboard/api';
import MeetingsView, { filterDriveArtifacts, getArtifactOperationalData, summarizeDriveData } from '../src/ceo-dashboard/views/MeetingsView';

const artifacts = [
  { id: '1', name: 'Comité de obra', folder_label: 'Obras', google_email: 'lyn@example.com', artifact_type: 'transcript', content_preview: 'Acuerdos de la reunión', source_modified_at: '2026-08-25T10:00:00.000Z' },
  { id: '2', name: 'Grabación cliente', folder_label: 'Ventas', google_email: 'lyn@example.com', artifact_type: 'recording', content_preview: '', source_modified_at: '2026-08-20T10:00:00.000Z' },
  { id: '3', name: 'Notas Murcia', folder_label: 'Obras', google_email: 'ops@example.com', artifact_type: 'notes', content_preview: 'Tareas pendientes', source_modified_at: '2026-07-01T10:00:00.000Z' },
];

beforeEach(() => {
  vi.mocked(api.googleDrive.status).mockResolvedValue({ configured: true, connections: [], folders: [] });
  vi.mocked(api.googleDrive.artifacts).mockResolvedValue(artifacts);
});

describe('Gestión de reuniones', () => {
  it('calcula métricas solo con información realmente importada', () => {
    expect(summarizeDriveData(artifacts, [{ enabled: true }, { enabled: false }, { enabled: true }])).toEqual({
      total: 3,
      activeFolders: 2,
      textReady: 2,
      mediaItems: 1,
    });
  });

  it('filtra por texto, tipo y período sin perder registros correctos', () => {
    const now = new Date('2026-08-26T12:00:00.000Z');
    expect(filterDriveArtifacts(artifacts, { query: 'obra' }, now).map((artifact) => artifact.id)).toEqual(['1', '3']);
    expect(filterDriveArtifacts(artifacts, { type: 'recording' }, now).map((artifact) => artifact.id)).toEqual(['2']);
    expect(filterDriveArtifacts(artifacts, { period: 'week' }, now).map((artifact) => artifact.id)).toEqual(['1', '2']);
  });

  it('muestra campos operativos como pendientes hasta que exista evidencia', () => {
    expect(getArtifactOperationalData({})).toMatchObject({
      project: 'Pendiente de identificar',
      contact: 'Sin contacto identificado',
      actionsLabel: 'Sin acciones extraídas',
    });
    expect(getArtifactOperationalData({ metadata: { obra: 'Villajoyosa 12', contacto: 'Marta S.', actions: ['Confirmar plano', 'Enviar presupuesto'] } })).toMatchObject({
      project: 'Villajoyosa 12',
      contact: 'Marta S.',
      actionsLabel: '2 acciones',
    });
  });

  it('mantiene Drive y carpetas, pero no muestra el historial duplicado en Configuración', async () => {
    render(<MeetingsView mode="configuration" />);

    expect(await screen.findByText('Fuentes sincronizadas')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Reunión / archivo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Todo el historial' })).not.toBeInTheDocument();
  });
});