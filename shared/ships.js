// Orbit Hill Ciudadela — naves cosméticas del contrato v2.
//
// Todos los modelos comparten ESTADÍSTICAS (radio, vida, empuje, armas): el
// modelo es puramente cosmético y el servidor solo guarda el id. Este módulo es
// PURO (no importa nada) para que lo usen servidor, cliente y tests.
//
// Contrato fijo (nombres que NO deben cambiar):
//   SHIP_MODELS      catálogo [{id,label}]
//   SHIP_DEFAULT     modelo por defecto
//   sanitizeShipModel(raw) -> id | null
//
// Aditivo (v0.2): SHIP_HULLS y shipHull() con la geometría vectorial de cada
// casco en unidades de SHIP.radius (x = morro hacia delante, y = lateral).

export const SHIP_MODELS = Object.freeze([
  // Catálogo original del prototipo: se conserva intacto (mismos ids, mismo
  // orden y misma etiqueta) para no alterar partidas ni preferencias guardadas.
  { id: 'viper', label: 'Víbora' },
  { id: 'bastion', label: 'Bastión' },
  { id: 'spectre', label: 'Espectro' },
  // Cinco siluetas originales de homenaje. Son solo geometría vectorial
  // propia: no reproducen planos, texturas ni marcas de ninguna franquicia.
  { id: 'alastar', label: 'Ala Estelar' },
  { id: 'interceptor', label: 'Interceptor Negro' },
  { id: 'arwing', label: 'Cazador Arwing' },
  { id: 'lobo', label: 'Lobo Eclipse' },
  { id: 'prism-wing', label: 'Prisma Alada' },
].map(Object.freeze));
export const SHIP_DEFAULT='viper';
export const sanitizeShipModel = id => SHIP_MODELS.some(s=>s.id===id) ? id : null;

/**
 * Cascos vectoriales. Coordenadas locales normalizadas por SHIP.radius:
 *   · viper       → dardo estrecho y alargado (morro fino, cola muescada)
 *   · bastion     → cuña ancha blindada (hombros gruesos, morro romo)
 *   · spectre     → horquilla: dos púas delanteras y cola en delta
 *   · alastar     → caza de cuatro alas en X con morro fino
 *   · interceptor → fuselaje angular con dos motores traseros
 *   · arwing      → ala curva y afilada de caza arcade
 *   · lobo        → alas en garra con cola muescada y morro agresivo
 *   · prism-wing  → lanza central larga, alas blancas barridas y módulos azules
 * `cockpit` es [x,y,r] en las mismas unidades; `fin` son las aletas/buff tags;
 * `rings` son los aros de armadura decorativos que se pintan sobre el casco.
 */
export const SHIP_HULLS = Object.freeze({
  viper: Object.freeze({
    id: 'viper',
    hull: Object.freeze([[1.66, 0], [-0.44, -0.44], [-1.0, -0.8], [-0.66, -0.2], [-0.66, 0.2], [-1.0, 0.8], [-0.44, 0.44]].map(Object.freeze)),
    cockpit: Object.freeze([0.16, 0, 0.24]),
    fin: Object.freeze([[[-0.6, -0.34], [-1.12, -0.62]], [[-0.6, 0.34], [-1.12, 0.62]]]),
    rings: Object.freeze([{ x: -0.2, r: 0.42, span: 0.5 }]),
    thruster: Object.freeze({ x: -0.72, half: 0.34 }),
    hardpoints: Object.freeze([[0.98, -0.2], [0.98, 0.2]]),
  }),
  bastion: Object.freeze({
    id: 'bastion',
    hull: Object.freeze([[1.14, -0.62], [1.32, -0.2], [1.32, 0.2], [1.14, 0.62], [0.4, 0.9], [-0.62, 0.94], [-1.06, 0.52], [-0.58, 0], [-1.06, -0.52], [-0.62, -0.94], [0.4, -0.9]].map(Object.freeze)),
    cockpit: Object.freeze([0.42, 0, 0.3]),
    fin: Object.freeze([[[-0.5, -0.86], [-1.2, -0.72]], [[-0.5, 0.86], [-1.2, 0.72]]]),
    rings: Object.freeze([{ x: -0.1, r: 0.7, span: 0.34 }, { x: -0.1, r: 0.48, span: 0.24 }]),
    thruster: Object.freeze({ x: -0.86, half: 0.5 }),
    hardpoints: Object.freeze([[1.0, -0.42], [1.0, 0.42]]),
  }),
  spectre: Object.freeze({
    id: 'spectre',
    hull: Object.freeze([[1.62, -0.52], [1.62, -0.18], [0.34, -0.16], [0.34, 0.16], [1.62, 0.18], [1.62, 0.52], [0.24, 0.62], [-0.5, 0.74], [-1.02, 0.34], [-0.44, 0], [-1.02, -0.34], [-0.5, -0.74], [0.24, -0.62]].map(Object.freeze)),
    cockpit: Object.freeze([0.06, 0, 0.2]),
    fin: Object.freeze([[[-0.56, -0.58], [-1.24, -0.4]], [[-0.56, 0.58], [-1.24, 0.4]]]),
    rings: Object.freeze([{ x: -0.34, r: 0.36, span: 0.62 }]),
    thruster: Object.freeze({ x: -0.8, half: 0.3 }),
    hardpoints: Object.freeze([[1.34, -0.35], [1.34, 0.35]]),
  }),
  alastar: Object.freeze({
    id: 'alastar',
    // Cuatro superficies alares: dos palas delanteras y dos traseras. La
    // silueta se lee como una X incluso a escala de minimapa.
    hull: Object.freeze([[1.58, 0], [1.02, -0.26], [0.46, -0.5], [1.3, -1.02], [0.08, -1.26], [-0.18, -0.55], [-1.06, -0.34], [-1.2, 0], [-1.06, 0.34], [-0.18, 0.55], [0.08, 1.26], [1.3, 1.02], [0.46, 0.5], [1.02, 0.26]].map(Object.freeze)),
    cockpit: Object.freeze([0.48, 0, 0.22]),
    fin: Object.freeze([[[0.28, -0.5], [0.86, -0.9]], [[0.28, 0.5], [0.86, 0.9]]]),
    rings: Object.freeze([{ x: 0.06, r: 0.4, span: 0.38 }]),
    thruster: Object.freeze({ x: -0.9, half: 0.36 }),
    hardpoints: Object.freeze([[1.24, -0.94], [1.24, 0.94]]),
  }),
  interceptor: Object.freeze({
    id: 'interceptor',
    // Perfil de dardo que se abre en dos góndolas de motor al llegar a popa.
    hull: Object.freeze([[1.72, 0], [0.82, -0.2], [0.44, -0.64], [0.12, -1.1], [-0.44, -1.12], [-0.72, -0.58], [-0.72, -0.18], [-1.22, -0.34], [-1.38, 0], [-1.22, 0.34], [-0.72, 0.18], [-0.72, 0.58], [-0.44, 1.12], [0.12, 1.1], [0.44, 0.64], [0.82, 0.2]].map(Object.freeze)),
    cockpit: Object.freeze([0.5, 0, 0.19]),
    fin: Object.freeze([[[-0.56, -0.22], [-1.14, -0.62]], [[-0.56, 0.22], [-1.14, 0.62]]]),
    rings: Object.freeze([{ x: -0.12, r: 0.3, span: 0.58 }]),
    // Dos conos de escape separados: la firma visual del caza bimotor.
    thruster: Object.freeze({ x: -1.06, half: 0.2 }),
    thrusters: Object.freeze([{ x: -1.06, y: -0.62, half: 0.2 }, { x: -1.06, y: 0.62, half: 0.2 }]),
    hardpoints: Object.freeze([[1.24, -0.1], [1.24, 0.1]]),
  }),
  arwing: Object.freeze({
    id: 'arwing',
    // Ala en flecha con punta de lanza, pensada para leerse en movimiento.
    hull: Object.freeze([[1.76, 0], [0.92, -0.18], [0.42, -0.46], [-0.06, -1.18], [-0.52, -1.24], [-0.34, -0.52], [-0.94, -0.32], [-1.24, -0.56], [-1.28, 0], [-1.24, 0.56], [-0.94, 0.32], [-0.34, 0.52], [-0.52, 1.24], [-0.06, 1.18], [0.42, 0.46], [0.92, 0.18]].map(Object.freeze)),
    cockpit: Object.freeze([0.62, 0, 0.2]),
    fin: Object.freeze([[[0.18, -0.44], [-0.18, -1.0]], [[0.18, 0.44], [-0.18, 1.0]]]),
    rings: Object.freeze([{ x: -0.24, r: 0.34, span: 0.5 }]),
    thruster: Object.freeze({ x: -0.96, half: 0.27 }),
    hardpoints: Object.freeze([[1.2, -0.16], [1.2, 0.16]]),
  }),
  lobo: Object.freeze({
    id: 'lobo',
    // Alas en garra que avanzan hacia el morro y una cola en muesca.
    hull: Object.freeze([[1.74, -0.1], [1.58, 0.2], [0.82, 0.34], [1.08, 0.98], [0.42, 1.1], [0.06, 0.46], [-0.68, 0.7], [-1.3, 0.34], [-1.04, 0], [-1.3, -0.34], [-0.68, -0.7], [0.06, -0.46], [0.42, -1.1], [1.08, -0.98], [0.82, -0.34], [1.58, -0.2]].map(Object.freeze)),
    cockpit: Object.freeze([0.42, 0, 0.23]),
    fin: Object.freeze([[[0.32, -0.42], [0.82, -0.9]], [[0.32, 0.42], [0.82, 0.9]]]),
    rings: Object.freeze([{ x: -0.3, r: 0.4, span: 0.52 }]),
    thruster: Object.freeze({ x: -0.98, half: 0.34 }),
    hardpoints: Object.freeze([[1.16, -0.86], [1.16, 0.86]]),
  }),
  // Homenaje original a un caza de lanza: fuselaje central muy largo, alas
  // blancas de gran envergadura barridas hacia atrás y dos módulos azules.
  // La geometría es propia y no reproduce el plano de ninguna nave real.
  'prism-wing': Object.freeze({
    id: 'prism-wing',
    hull: Object.freeze([[2.04, 0], [1.34, -0.18], [0.76, -0.32], [0.32, -0.62], [0.06, -1.32], [-0.52, -1.62], [-1.02, -1.28], [-0.78, -0.44], [-1.36, -0.28], [-1.48, 0], [-1.36, 0.28], [-0.78, 0.44], [-1.02, 1.28], [-0.52, 1.62], [0.06, 1.32], [0.32, 0.62], [0.76, 0.32], [1.34, 0.18]].map(Object.freeze)),
    cockpit: Object.freeze([0.92, 0, 0.23]),
    fin: Object.freeze([[[-0.48, -1.1], [-0.88, -1.4]], [[-0.48, 1.1], [-0.88, 1.4]]]),
    rings: Object.freeze([{ x: -0.1, r: 0.34, span: 0.32 }]),
    // Dos conos laterales: la firma bimotora de la Prisma Alada.
    thruster: Object.freeze({ x: -1.18, half: 0.26 }),
    thrusters: Object.freeze([{ x: -1.12, y: -0.56, half: 0.2 }, { x: -1.12, y: 0.56, half: 0.2 }]),
    hardpoints: Object.freeze([[1.28, -0.18], [1.28, 0.18]]),
  }),
});

/** Geometría del casco de un modelo (nunca null: cae al modelo por defecto). */
export function shipHull(model) {
  return SHIP_HULLS[sanitizeShipModel(model) ?? SHIP_DEFAULT];
}

/** Caja envolvente del casco; los tests la usan para comparar siluetas. */
export function hullBounding(model) {
  const { hull } = shipHull(model);
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  for (const [x, y] of hull) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY, length: maxX - minX, width: maxY - minY };
}

/** Etiqueta corta del modelo para chips de UI. */
export function shipModelLabel(model) {
  const found = SHIP_MODELS.find((m) => m.id === sanitizeShipModel(model));
  return found ? found.label : SHIP_MODELS[0].label;
}
