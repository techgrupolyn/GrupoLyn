export function historyChat(chat: { id?: string | null; name?: string | null; unreadCount?: number | null }, instanceId: string) {
  const unreadMessages = typeof chat.unreadCount === 'number' && Number.isFinite(chat.unreadCount)
    ? Math.max(0, Math.floor(chat.unreadCount))
    : undefined;
  return {
    remoteJid: chat.id,
    instanceId,
    ...(chat.name != null ? { name: chat.name } : {}),
    ...(unreadMessages !== undefined ? { unreadMessages } : {}),
  };
}
