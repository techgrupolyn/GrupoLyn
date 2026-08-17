function messageKey(message) {
  const id = String(message?.id || '').trim();
  if (id) return `id:${id}`;
  return `fallback:${String(message?.timestamp || '')}:${String(message?.remitente || '')}:${String(message?.texto || '')}`;
}

function compareTimestamps(left, right) {
  return String(left?.timestamp || '').localeCompare(String(right?.timestamp || ''));
}

export function getLatestMessageTimestamp(messages) {
  if (!Array.isArray(messages) || !messages.length) return '';
  return messages.reduce((latest, message) => (
    compareTimestamps(message, latest) > 0 ? message : latest
  ), messages[0])?.timestamp || '';
}

export function mergeMessages(existing, incoming, maxMessages) {
  const byKey = new Map();
  for (const message of Array.isArray(existing) ? existing : []) {
    if (message && typeof message === 'object') byKey.set(messageKey(message), message);
  }
  for (const message of Array.isArray(incoming) ? incoming : []) {
    if (message && typeof message === 'object') byKey.set(messageKey(message), message);
  }

  const limit = Math.max(1, Number(maxMessages) || 200);
  return Array.from(byKey.values()).sort(compareTimestamps).slice(-limit);
}