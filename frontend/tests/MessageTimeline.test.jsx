import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageTimeline } from '../src/App';

describe('MessageTimeline smoke', () => {
  it('renderiza el timeline vacio', () => {
    render(<MessageTimeline mensajes={[]} />);
    expect(screen.getByText(/LYN Web/i)).toBeTruthy();
  });
});
