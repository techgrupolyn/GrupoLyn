import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AuthView } from '../src/App';

describe('AuthView smoke', () => {
  it('renderiza la vista de auth', () => {
    render(<AuthView qr={null} state="close" error={null} onRefresh={() => {}} />);
    expect(screen.getByText(/Superagente/i)).toBeTruthy();
  });
});
