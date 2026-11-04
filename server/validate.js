// Orbit Hill - limitador de ritmo y validacion de mensajes entrantes.
// Regla de oro: el servidor nunca confia en el cliente. Cada mensaje se
// valida en tamano, tipo y frecuencia antes de tocar la simulacion.

import { NET } from '../shared/constants.js';

/** Token bucket simple y determinista (facil de testear). */
export class RateLimiter {
  constructor({ rate = NET.msgsPerSecond, burst = NET.msgBurst } = {}) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
    this.lastRefill = 0;
    this.rejected = 0;
  }

  /** Consume un token. Devuelve false si hay que descartar el mensaje. */
  take(nowMs) {
    if (this.lastRefill === 0) this.lastRefill = nowMs;
    const elapsed = Math.max(0, nowMs - this.lastRefill) / 1000;
    this.lastRefill = nowMs;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rate);
    if (this.tokens < 1) {
      this.rejected += 1;
      return false;
    }
    this.tokens -= 1;
    return true;
  }
}

export const MAX_RAW_BYTES = NET.maxMessageBytes;

/**
 * Convierte un frame crudo del WebSocket en objeto JSON, o null si es basura.
 * Acepta solo texto, tamano acotado y tipos de mensaje conocidos.
 */
export function parseClientFrame(raw, isBinary = false) {
  if (isBinary) return null;
  const text = typeof raw === 'string' ? raw : raw?.toString?.('utf8');
  if (typeof text !== 'string') return null;
  if (text.length === 0 || text.length > NET.maxMessageBytes) return null;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (typeof obj.t !== 'string') return null;
  return obj;
}

export const CLIENT_MESSAGE_TYPES = new Set([
  'create',
  'join',
  'team',
  'mode',
  'settings',
  'battlefield',
  'input',
  'chaos_armory',
  'start',
  'rematch',
  'chat',
  'ping',
  'name',
]);

/** Valida la forma de un mensaje ya parseado. */
export function isKnownMessage(msg) {
  return !!msg && typeof msg.t === 'string' && CLIENT_MESSAGE_TYPES.has(msg.t);
}
