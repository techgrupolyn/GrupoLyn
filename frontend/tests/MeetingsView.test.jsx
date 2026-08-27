import { describe, expect, it } from 'vitest';
import { filterDriveArtifacts, summarizeDriveData } from '../src/ceo-dashboard/views/MeetingsView';

const artifacts = [
  { id: '1', name: 'Comité de obra', folder_label: 'Obras', google_email: 'lyn@example.com', artifact_type: 'transcript', content_preview: 'Acuerdos de la reunión', source_modified_at: '2026-08-25T10:00:00.000Z' },
  { id: '2', name: 'Grabación cliente', folder_label: 'Ventas', google_email: 'lyn@example.com', artifact_type: 'recording', content_preview: '', source_modified_at: '2026-08-20T10:00:00.000Z' },
  { id: '3', name: 'Notas Murcia', folder_label: 'Obras', google_email: 'ops@example.com', artifact_type: 'notes', content_preview: 'Tareas pendientes', source_modified_at: '2026-07-01T10:00:00.000Z' },
];

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
});