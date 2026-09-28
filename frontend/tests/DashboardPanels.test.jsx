import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LabelsView from '../src/ceo-dashboard/views/LabelsView';
import TemplatesView from '../src/ceo-dashboard/views/TemplatesView';
import SpecialistsView from '../src/ceo-dashboard/views/SpecialistsView';
import BusinessView from '../src/ceo-dashboard/views/BusinessView';
import GroupsView from '../src/ceo-dashboard/views/GroupsView';
import api from '../src/ceo-dashboard/api';

vi.mock('../src/ceo-dashboard/api', () => ({ default: {
  labels: {list:vi.fn(),handle:vi.fn()}, templates:{list:vi.fn()}, specialists:{list:vi.fn()},
  business:{catalog:vi.fn(),collections:vi.fn()}, ceoChats:vi.fn(),
} }));

describe('QA transversal de paneles', () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([
    ['etiquetas', LabelsView, () => api.labels.list],
    ['plantillas', TemplatesView, () => api.templates.list],
    ['especialistas', SpecialistsView, () => api.specialists.list],
  ])('no oculta errores de carga en %s', async (_name, Component, request) => {
    request().mockRejectedValue(new Error('Servicio temporalmente no disponible'));
    render(<Component />);
    expect(await screen.findByText('Servicio temporalmente no disponible')).toBeInTheDocument();
  });

  it.each(['Consultar catálogo','Consultar colecciones'])('muestra el fallo de %s', async (button) => {
    api.business.catalog.mockRejectedValue(new Error('Evolution no disponible'));
    api.business.collections.mockRejectedValue(new Error('Evolution no disponible'));
    render(<BusinessView />);
    fireEvent.change(screen.getAllByPlaceholderText('Número')[0],{target:{value:'34000000000'}});
    fireEvent.click(screen.getByRole('button',{name:button}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Evolution no disponible');
  });

  it('no confunde error en grupos con una cuenta sin grupos', async () => {
    api.ceoChats.mockRejectedValue(new Error('API no disponible'));
    render(<GroupsView />);
    expect(await screen.findByText('No se pudo cargar el registro central de grupos.')).toBeInTheDocument();
    expect(screen.queryByText('No hay grupos sincronizados para mostrar.')).not.toBeInTheDocument();
  });
});
