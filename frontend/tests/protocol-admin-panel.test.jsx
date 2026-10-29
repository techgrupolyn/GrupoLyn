import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ProtocolosAdminPanel from '../src/ceo-dashboard/views/ProtocolosAdminPanel';
import api from '../src/ceo-dashboard/api';

vi.mock('../src/ceo-dashboard/api', () => ({ default: { protocols: {
  report: vi.fn(), queries: vi.fn(),
} } }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('panel de consultas de protocolos', () => {
  it('muestra historial y ambos apartados del reporte y aplica filtros', async () => {
    api.protocols.report.mockResolvedValue({
      popular: [{ tema: 'revisión semanal', consultas: 4, usuarios: 2, porcentaje_resueltas: 75, documento_mas_citado: 'Método LYN', ultima_consulta: '2026-10-28T12:00:00Z', ejemplos: ['¿Cómo reviso?'] }],
      unanswered: [{ tema: 'plazo no documentado', consultas: 1, sin_protocolo: 1, fuera_de_alcance: 0, tema_sensible: 0, rechazadas: 0, usuario_dijo_no: 0, cargos: ['PMC'], ejemplos: ['¿Cuál es el plazo?'] }], total: 5,
    });
    api.protocols.queries.mockResolvedValue({ items: [{ id: '1', creado_en: '2026-10-28T12:00:00Z', cargo: 'PMC', clasificacion: 'resuelta', pregunta: '¿Cómo hago la revisión?', respuesta: 'Consulta el protocolo.', fuentes: [], corpus_version_id: 'versión', validacion: 'ok' }], total: 1, limit: 10 });

    render(<ProtocolosAdminPanel refreshToken="initial" />);
    expect((await screen.findAllByText(/¿Cómo hago la revisión\?/u)).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('tab', { name: 'Informe de 7 días' }));
    expect(await screen.findByText('revisión semanal')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'revisión semanal' }));
    expect(screen.getByRole('complementary', { name: 'Preguntas de revisión semanal' })).toBeTruthy();
    expect(screen.getByText('¿Cómo reviso?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    fireEvent.click(screen.getByRole('button', { name: 'plazo no documentado' }));
    expect(screen.getByRole('complementary', { name: 'Preguntas de plazo no documentado' })).toBeTruthy();
    expect(screen.getByText('¿Cuál es el plazo?')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Área'), { target: { value: 'obra' } });
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar filtros' }));
    await waitFor(() => expect(api.protocols.report).toHaveBeenLastCalledWith(expect.objectContaining({ area: 'obra' })));
  });

  it('muestra solo el reporte al Gerente técnico y no consulta el historial', async () => {
    api.protocols.report.mockResolvedValue({ popular: [], unanswered: [], total: 0 });
    render(<ProtocolosAdminPanel refreshToken="initial" canReadHistory={false} />);
    expect(await screen.findByText('No hay consultas en este periodo con los filtros seleccionados.')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Historial' })).toBeNull();
    expect(api.protocols.queries).not.toHaveBeenCalled();
  });

  it('despliega cada respuesta, permite scroll y pagina diez consultas', async () => {
    api.protocols.report.mockResolvedValue({ popular: [], unanswered: [] });
    const items = Array.from({ length: 23 }, (_, index) => ({
      id: String(index + 1), creado_en: '2026-10-28T12:00:00Z', cargo: 'PMC', clasificacion: 'resuelta',
      pregunta: `Pregunta ${index + 1}`, respuesta: `Respuesta ${index + 1}`, fuentes: [], corpus_version_id: 'versión', validacion: 'ok',
    }));
    api.protocols.queries.mockImplementation(async offset => ({ items: items.slice(offset, offset + 10), offset, limit: 10, total: items.length }));

    const { container } = render(<ProtocolosAdminPanel refreshToken="initial" />);
    expect((await screen.findAllByText('Pregunta 1')).length).toBeGreaterThan(0);
    expect(screen.getByText('Página 1 de 3 · 23 consultas')).toBeTruthy();
    fireEvent.click(screen.getAllByText('Pregunta 1')[0]);
    expect(screen.getByText('Respuesta 1')).toBeTruthy();
    expect(container.querySelector('ul.max-h-\\[32rem\\].overflow-y-auto')).toBeTruthy();
    expect(screen.getByText('Respuesta 1').className).toContain('overflow-y-auto');
    fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }));
    expect((await screen.findAllByText('Pregunta 11')).length).toBeGreaterThan(0);
    expect(screen.getByText('Página 2 de 3 · 23 consultas')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }));
    expect((await screen.findAllByText('Pregunta 21')).length).toBeGreaterThan(0);
    expect(screen.getByText('Página 3 de 3 · 23 consultas')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Siguiente' }).disabled).toBe(true);
  });
});
