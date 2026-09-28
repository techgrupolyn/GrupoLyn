import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ChatList, DashboardView } from '../src/App';
import api from '../src/api';

afterEach(() => vi.restoreAllMocks());

describe('ChatList smoke', () => {
  it('renderiza la lista de chats', () => {
    render(<ChatList chats={[]} selectedId={null} onSelect={() => {}} onNotificationRead={() => {}} activeTab="chats" onTabChange={() => {}} />);
    expect(screen.getByText(/Sin conversaciones aún/i)).toBeTruthy();
  });

  it('consulta llamadas del chat seleccionado y actualiza al cambiarlo', async () => {
    const calls=vi.spyOn(api,'callHistory').mockResolvedValue([]);
    vi.spyOn(api,'chats').mockResolvedValue([]);
    const view=render(<ChatList chats={[]} selectedId="chat-a" activeTab="calls" />);
    await waitFor(()=>expect(calls).toHaveBeenCalledWith('chat-a'));
    view.rerender(<ChatList chats={[]} selectedId="chat-b" activeTab="calls" />);
    await waitFor(()=>expect(calls).toHaveBeenCalledWith('chat-b'));
    await screen.findByText('No hay llamadas registradas.');
  });

  it('abre el detalle de una llamada sin errores de variables fuera de alcance', async () => {
    vi.spyOn(api,'callHistory').mockResolvedValue([{id:'qa-call',remoteJid:'123@s.whatsapp.net',type:'outgoing',status:'completed'}]);
    vi.spyOn(api,'chats').mockResolvedValue([{id:'123@s.whatsapp.net',nombre:'Contacto QA'}]);
    render(<DashboardView chats={[]} mensajes={[]} selectedChatId={null} activeTab="calls" />);
    fireEvent.click(await screen.findByRole('button',{name:/Contacto QA.*Llamada saliente/i}));
    expect(await screen.findByText('ID: qa-call')).toBeTruthy();
  });
});
