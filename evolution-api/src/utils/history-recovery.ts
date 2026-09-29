type HistoryAnchor = {
  key: { id?: string; remoteJid?: string; remoteJidAlt?: string; fromMe?: boolean; participant?: string };
  messageTimestamp: number;
};

type RecoveryDependencies = {
  connected: () => boolean;
  enabled: () => boolean;
  oldest: (remoteJid: string) => Promise<HistoryAnchor | null>;
  request: (count: number, key: HistoryAnchor['key'], timestampMs: number) => Promise<string>;
  now?: () => number;
};

export function createHistoryRecovery(dependencies: RecoveryDependencies) {
  const requests = new Map<string, { anchor: string; at: number; requestId: string }>();
  const running = new Map<string, Promise<Record<string, unknown>>>();
  const now = dependencies.now || Date.now;
  return async (remoteJid: string): Promise<Record<string, unknown>> => {
    if (!/^[0-9-]+@g\.us$/.test(remoteJid)) throw new Error('Invalid group JID');
    const existing = running.get(remoteJid);
    if (existing) return existing;
    const execute = async () => {
      if (!dependencies.enabled()) return { status: 'disabled' };
      if (!dependencies.connected()) return { status: 'disconnected' };
      const anchor = await dependencies.oldest(remoteJid);
      if (
        !anchor?.key?.id ||
        typeof anchor.key.fromMe !== 'boolean' ||
        ![anchor.key.remoteJid, anchor.key.remoteJidAlt].includes(remoteJid) ||
        !Number.isSafeInteger(anchor.messageTimestamp) ||
        anchor.messageTimestamp <= 0
      ) {
        return { status: 'no_anchor' };
      }
      const timestampMs = anchor.messageTimestamp < 1e12 ? anchor.messageTimestamp * 1000 : anchor.messageTimestamp;
      if (!Number.isSafeInteger(timestampMs)) return { status: 'no_anchor' };
      const cursor = JSON.stringify([anchor.key.id, anchor.key.fromMe, timestampMs]);
      const previous = requests.get(remoteJid);
      if (previous?.anchor === cursor && now() - previous.at < 600_000) {
        return { status: now() - previous.at < 120_000 ? 'waiting' : 'no_progress', requestId: previous.requestId };
      }
      for (const [group, value] of requests) if (now() - value.at >= 600_000) requests.delete(group);
      if (requests.size >= 1000 && !requests.has(remoteJid)) return { status: 'busy' };
      const requestId = await dependencies.request(50, { ...anchor.key, remoteJid }, timestampMs);
      if (!requestId) throw new Error('History request was not acknowledged');
      requests.set(remoteJid, { anchor: cursor, at: now(), requestId });
      return { status: 'requested', requestId };
    };
    const promise = execute();
    running.set(remoteJid, promise);
    try {
      return await promise;
    } finally {
      running.delete(remoteJid);
    }
  };
}
