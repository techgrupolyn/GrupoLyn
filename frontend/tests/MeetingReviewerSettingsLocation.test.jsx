import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import SettingsView from '../src/ceo-dashboard/views/SettingsView';

vi.mock('../src/ceo-dashboard/api', () => ({default:{}}));
vi.mock('../src/ceo-dashboard/views/MeetingsView', () => ({default:() => <p>Fuentes sincronizadas</p>}));
vi.mock('../src/ceo-dashboard/views/OperationsView', () => ({default:() => null}));

describe('Revisores obtenidos del proyecto sin configuración duplicada', () => {
  it('conserva los ajustes habituales sin solicitar designar otra vez el equipo', () => {
    render(<SettingsView activeTab="meetings" />);
    expect(screen.getByText('Fuentes sincronizadas')).toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'Revisores por obra'})).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Obra a configurar')).not.toBeInTheDocument();
  });
});
