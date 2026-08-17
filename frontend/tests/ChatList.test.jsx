import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatList } from '../src/App';

describe('ChatList smoke', () => {
  it('renderiza la lista de chats', () => {
    render(<ChatList chats={[]} selectedId={null} onSelect={() => {}} onNotificationRead={() => {}} activeTab="chats" onTabChange={() => {}} />);
    expect(screen.getByText(/Sin conversaciones aún/i)).toBeTruthy();
  });
});
