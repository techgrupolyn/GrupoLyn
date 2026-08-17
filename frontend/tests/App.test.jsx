import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AuthView } from '../src/App';

describe('App smoke', () => {
  it('renderiza la vista de auth cuando no hay conexion', () => {
    render(<AuthView qr={null} state="close" error={null} onRefresh={() => {}} />);
    expect(screen.getByText(/Conectar WhatsApp/i)).toBeTruthy();
  });
});
