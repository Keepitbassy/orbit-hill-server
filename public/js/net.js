// Orbit Hill — capa de red del cliente.
// Solo envía intenciones (input, equipo, chat): nunca posiciones ni puntos.

export class Net {
  constructor({ url, onChange } = {}) {
    this.url = url ?? defaultUrl();
    this.socket = null;
    this.handlers = new Map();
    this.connected = false;
    this.manualClose = false;
    this.ping = 0;
    this.lastPingAt = 0;
    this.pingTimer = null;
    this.onChange = onChange ?? (() => {});
    this.stats = { sent: 0, received: 0, bytes: 0 };
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type)?.delete(fn);
  }

  emit(type, payload) {
    for (const fn of this.handlers.get(type) ?? []) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[net] handler ${type} falló`, err);
      }
    }
  }

  connect() {
    if (this.socket && (this.socket.readyState === 0 || this.socket.readyState === 1)) return;
    this.manualClose = false;
    try {
      this.socket = new WebSocket(this.url);
    } catch (err) {
      this.emit('closed', { reason: 'no_ws' });
      return;
    }

    this.socket.addEventListener('open', () => {
      this.connected = true;
      this.emit('open');
      this.onChange();
      this.pingTimer = setInterval(() => {
        this.lastPingAt = performance.now();
        this.send({ t: 'ping', ts: Date.now() });
      }, 1200);
    });

    this.socket.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return; // el servidor es de fiar, pero no rompemos si llega basura
      }
      if (!msg || typeof msg.t !== 'string') return;
      this.stats.received += 1;
      this.stats.bytes += typeof ev.data === 'string' ? ev.data.length : 0;
      if (msg.t === 'pong') {
        this.ping = Math.round(performance.now() - this.lastPingAt);
        return;
      }
      this.emit(msg.t, msg);
      this.emit('*', msg);
    });

    this.socket.addEventListener('close', () => {
      this.connected = false;
      clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.emit('closed', { manual: this.manualClose });
      this.onChange();
    });

    this.socket.addEventListener('error', () => {
      /* el evento close se encarga */
    });
  }

  send(obj) {
    if (!this.socket || this.socket.readyState !== 1) return false;
    const payload = JSON.stringify(obj);
    if (payload.length > 2048) return false; // límite espejo del servidor
    this.stats.sent += 1;
    this.socket.send(payload);
    return true;
  }

  close() {
    this.manualClose = true;
    clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.socket?.close();
    this.connected = false;
  }
}

export function defaultUrl() {
  // config.js connects a static Netlify build to its separately deployed game server.
  const configured = String(globalThis.ORBIT_HILL_SERVER_URL ?? '').trim();
  if (configured) {
    const url = new URL(configured, location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.href;
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}`;
}
