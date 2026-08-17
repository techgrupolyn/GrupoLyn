import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatHeader } from '../src/App';

describe('ChatHeader smoke', () => {
  it('renderiza el header del chat', () => {
    render(<ChatHeader chat={{ id: '1', nombre: 'Contacto' }} onRename={() => {}} onDisconnect={() => {}} onAuthStateChange={() => {}} />);
    expect(screen.getByText(/Contacto/i)).toBeTruthy();
  });
});
