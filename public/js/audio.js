// Orbit Hill — sonido 100% sintetizado con WebAudio (sin archivos externos).
// Todo es opcional: si el navegador bloquea el audio o el jugador silencia,
// el juego sigue funcionando igual.

const MUTE_KEY = 'orbit-hill-mute';

export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    try {
      this.muted = localStorage.getItem(MUTE_KEY) === '1';
    } catch {
      this.muted = false;
    }
    this.budget = 0;      // limita cuantos sonidos simultaneos sintetizamos
    this.lastReset = 0;
  }

  /** Debe llamarse tras un gesto del usuario (click / tecla). */
  unlock() {
    try {
      this.ensure();
    } catch {
      /* el audio es opcional */
    }
  }

  ensure() {
    if (!this.ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  setMuted(value) {
    this.muted = !!value;
    try {
      localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0');
    } catch {
      /* modo privado */
    }
    return this.muted;
  }

  toggle() {
    return this.setMuted(!this.muted);
  }

  /** Control de presupuesto: evita saturar cuando hay 8 naves disparando. */
  spend(cost = 1) {
    const now = performance.now();
    if (now - this.lastReset > 250) {
      this.lastReset = now;
      this.budget = 0;
    }
    if (this.budget + cost > 10) return false;
    this.budget += cost;
    return true;
  }

  tone({ type = 'square', from = 440, to = null, dur = 0.12, gain = 0.16, delay = 0 }) {
    if (this.muted) return;
    const ctx = this.ensure();
    if (!ctx || !this.spend()) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t0);
    if (to && to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(24, to), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  noise({ dur = 0.35, gain = 0.24, freq = 900, q = 0.9, freqTo = null }) {
    if (this.muted) return;
    const ctx = this.ensure();
    if (!ctx || !this.spend(2)) return;
    const frames = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(freq, ctx.currentTime);
    if (freqTo) filter.frequency.exponentialRampToValueAtTime(Math.max(60, freqTo), ctx.currentTime + dur);
    filter.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    src.connect(filter).connect(g).connect(this.master);
    src.start();
  }

  shoot(kind = 'auto') {
    if (kind === 'plasma') {
      this.noise({ dur: .16, gain: .14, freq: 1500, freqTo: 110 });
      this.tone({ type: 'triangle', from: 180, to: 48, dur: .19, gain: .11 });
    } else if (kind === 'sniper') {
      this.tone({ type: 'sawtooth', from: 1300, to: 130, dur: .12, gain: .075 });
      this.noise({ dur: .07, gain: .085, freq: 2600, freqTo: 400 });
    } else if (kind === 'boomer') {
      this.tone({ type: 'sine', from: 120, to: 38, dur: .25, gain: .14 });
      this.noise({ dur: .16, gain: .12, freq: 800, freqTo: 100 });
    } else this.tone({ type: 'square', from: 880, to: 240, dur: 0.09, gain: 0.08 });
  }
  smoke() { this.noise({ dur: .3, gain: .05, freq: 2200, freqTo: 500 }); }
  bounce() { this.tone({ type: 'triangle', from: 140, to: 270, dur: .06, gain: .045 }); }
  blast() { this.boom(.25); }
  enemyShoot() { this.tone({ type: 'triangle', from: 560, to: 180, dur: 0.07, gain: 0.035 }); }
  hit() { this.tone({ type: 'sawtooth', from: 320, to: 120, dur: 0.07, gain: 0.09 }); }
  shield() { this.tone({ type: 'sine', from: 1200, to: 1700, dur: 0.09, gain: 0.06 }); }
  rock(scale = 0) { this.noise({ dur: 0.22 + scale * 0.08, gain: 0.16, freq: 700 - scale * 120, freqTo: 160 }); }
  boom(scale = 1) {
    this.noise({ dur: 0.35 + scale * 0.15, gain: 0.3, freq: 1200, freqTo: 90 });
    this.tone({ type: 'sine', from: 180 - scale * 30, to: 40, dur: 0.4, gain: 0.22 });
  }
  death() {
    this.noise({ dur: 0.6, gain: 0.34, freq: 1800, freqTo: 80 });
    this.tone({ type: 'sawtooth', from: 420, to: 60, dur: 0.5, gain: 0.16 });
  }
  boost() { this.tone({ type: 'sawtooth', from: 180, to: 720, dur: 0.28, gain: 0.09 }); }
  capture() { this.tone({ type: 'triangle', from: 620, to: 940, dur: 0.16, gain: 0.1 }); }
  tick() { this.tone({ type: 'square', from: 1200, dur: 0.05, gain: 0.05 }); }
  win() {
    [523, 659, 784, 1046].forEach((f, i) =>
      this.tone({ type: 'triangle', from: f, to: f * 1.01, dur: 0.22, gain: 0.16, delay: i * 0.13 }),
    );
  }
  lose() {
    [392, 330, 262].forEach((f, i) =>
      this.tone({ type: 'sine', from: f, to: f * 0.98, dur: 0.3, gain: 0.14, delay: i * 0.16 }),
    );
  }
  ui() { this.tone({ type: 'square', from: 660, to: 880, dur: 0.05, gain: 0.05 }); }
  error() { this.tone({ type: 'square', from: 200, to: 120, dur: 0.16, gain: 0.09 }); }
}
