/**
 * The `/ws` connection, with automatic reconnection.
 *
 * Without it a single dropped socket leaves the tab permanently deaf: the
 * backend keeps working and emitting events, but the page stays frozen on
 * whatever it last saw — invitation runs stuck on "en file d'attente" while
 * they were in fact running. The backend restarts on every edit under
 * `tsx watch`, so in dev this happened constantly.
 *
 * The server answers a new connection with a full `snapshot`, so a reconnect
 * heals the UI on its own — every consumer already rebuilds its state from it.
 */
export function connectLive(
  onMessage: (msg: any) => void,
  onStatus?: (connected: boolean) => void
): () => void {
  let ws: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let closed = false;

  const open = () => {
    if (closed) return;
    const wsHost = import.meta.env.DEV ? 'localhost:3210' : location.host;
    ws = new WebSocket(`ws://${wsHost}/ws`);
    ws.onopen = () => {
      attempt = 0;
      onStatus?.(true);
    };
    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data));
      } catch {
        // ignore a malformed frame rather than killing the handler
      }
    };
    ws.onclose = () => {
      onStatus?.(false);
      if (closed) return;
      // Back off to 10 s: a backend restart takes a second, but a backend that
      // is down for good shouldn't be hammered.
      const delay = Math.min(500 * 2 ** attempt++, 10_000);
      retry = setTimeout(open, delay);
    };
    // An error is always followed by a close — let that path do the retry.
    ws.onerror = () => ws?.close();
  };

  open();

  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    ws?.close();
  };
}
