// Orbit Hill — partículas, anillos de explosión y sacudida de cámara.
// Todo se dibuja en el espacio del mundo (la cámara ya aplica escala).

import { WORLD } from '/shared/constants.js';

const TAU = Math.PI * 2;

export class Particles {
  constructor(max = 1200) {
    this.max = max;
    this.list = [];
    // El mundo puede cambiar entre partidas (arenas del servidor): se ajusta
    // sin tocar las constantes compartidas.
    this.world = { w: WORLD.w, h: WORLD.h };
  }

  setWorld(world) {
    if (world && Number(world.w) > 0 && Number(world.h) > 0) {
      this.world = { w: Number(world.w), h: Number(world.h) };
    }
  }

  clear() {
    this.list.length = 0;
  }

  spawn(p) {
    if (this.list.length >= this.max) this.list.shift();
    this.list.push({
      x: p.x,
      y: p.y,
      vx: p.vx ?? 0,
      vy: p.vy ?? 0,
      life: p.life ?? 0.6,
      maxLife: p.life ?? 0.6,
      size: p.size ?? 3,
      color: p.color ?? '#ffffff',
      shape: p.shape ?? 'dot',
      drag: p.drag ?? 1.6,
      spin: p.spin ?? 0,
      angle: p.angle ?? 0,
      alpha: p.alpha ?? 1,
      glow: p.glow ?? 1,
    });
  }

  burst(x, y, count, opts = {}) {
    const {
      color = '#ffffff',
      speed = 160,
      spread = TAU,
      dir = 0,
      life = 0.6,
      size = 3,
      shape = 'spark',
      drag = 1.8,
    } = opts;
    for (let i = 0; i < count; i++) {
      const a = dir + (Math.random() - 0.5) * spread;
      const s = speed * (0.35 + Math.random() * 0.85);
      this.spawn({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        life: life * (0.6 + Math.random() * 0.7),
        size: size * (0.6 + Math.random() * 0.8),
        color,
        shape,
        drag,
      });
    }
  }

  ring(x, y, opts = {}) {
    const { radius = 40, color = '#ffffff', life = 0.5, size = 3 } = opts;
    this.spawn({ x, y, life, size, color, shape: 'ring', drag: 0, sv: radius, glow: 1 });
    const p = this.list[this.list.length - 1];
    p.targetRadius = radius;
    return p;
  }

  update(dt) {
    const next = [];
    for (const p of this.list) {
      p.life -= dt;
      if (p.life <= 0) continue;
      if (p.shape === 'ring') {
        p.radius = (p.radius ?? 0) + ((p.targetRadius ?? 40) - (p.radius ?? 0)) * Math.min(1, dt * 9);
      } else {
        const damp = Math.exp(-p.drag * dt);
        p.vx *= damp;
        p.vy *= damp;
        p.x = (p.x + p.vx * dt + this.world.w) % this.world.w;
        p.y = (p.y + p.vy * dt + this.world.h) % this.world.h;
        p.angle += p.spin * dt;
      }
      next.push(p);
    }
    this.list = next;
  }

  draw(ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.list) {
      const t = Math.max(0, p.life / p.maxLife);
      ctx.globalAlpha = Math.min(1, t * 1.5) * p.alpha;
      ctx.strokeStyle = p.color;
      ctx.fillStyle = p.color;
      ctx.lineWidth = Math.max(0.7, p.size * 0.5);
      if (p.shape === 'ring') {
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(1, p.radius ?? p.size), 0, TAU);
        ctx.stroke();
      } else if (p.shape === 'spark') {
        const len = Math.min(22, Math.hypot(p.vx, p.vy) * 0.05) * t + 2;
        const a = Math.atan2(p.vy, p.vx);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - Math.cos(a) * len, p.y - Math.sin(a) * len);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(0.6, p.size * t), 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  }
}

export class Shake {
  constructor() {
    this.amount = 0;
    this.t = 0;
  }

  add(value) {
    this.amount = Math.min(2, this.amount + value * 0.1);
  }

  update(dt) {
    this.amount *= Math.exp(-12 * dt);
    this.t += dt;
    if (this.amount < 0.05) this.amount = 0;
  }

  offset() {
    if (this.amount === 0) return { x: 0, y: 0 };
    return {
      x: Math.sin(this.t * 61) * this.amount,
      y: Math.cos(this.t * 47) * this.amount * 0.8,
    };
  }
}

export function makeStarfield(world, count = 260) {
  const stars = [];
  for (let i = 0; i < count; i++) {
    stars.push({
      x: Math.random() * world.w,
      y: Math.random() * world.h,
      r: Math.random() < 0.82 ? Math.random() * 1.1 + 0.35 : Math.random() * 1.9 + 1,
      depth: 0.25 + Math.random() * 0.75,
      tw: Math.random() * TAU,
    });
  }
  return stars;
}
