// Ghost layer: each ghost is a deformable veil of gauze drawn as live SVG
// paths, animated by one rAF loop.
//
// Model: a head point (stable, led by the ghost's own drift), a mid point and a
// hem point that follow it on progressively softer springs. The three points
// define a curved spine; the outline is built around that spine with a domed
// head, breathing/twisting sides and an irregular hem. Lag between the three
// springs gives the drag: the head moves first, body and hem catch up later.
//
// A ghost's (x, y) is the rest position of the text it carries, so it can rise
// from — and land back on — the exact glyphs in the editor.

import { ghostLabel } from './text';

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface LayerEnv {
  /** Where ghosts may live (layer coords). */
  sky(): Box;
  /** Editor rectangle (layer coords). */
  editor(): Box;
  /** Editor font size in px, so the ghost text can match the page text. */
  editorFontSize(): number;
  onLanded(id: number): void;
}

type Phase = 'spawn' | 'teleport' | 'float' | 'fadeout' | 'appear' | 'return';
type V = { x: number; y: number };

interface Ghost {
  id: number;
  text: string;
  textEl: HTMLDivElement;
  group: SVGGElement;
  veil: SVGGElement;
  body: SVGPathElement;
  edge: SVGPathElement;
  clip: SVGPathElement;
  folds: SVGPathElement[];
  glow: SVGEllipseElement;
  eyes: SVGGElement;
  eyeL: SVGEllipseElement;
  eyeR: SVGEllipseElement;
  grads: SVGLinearGradientElement[];
  glowGrad: SVGRadialGradientElement;
  // measured
  tw: number;
  th: number;
  font: number;
  R: number; // head radius
  dT: number; // head centre -> text centre
  L: number; // head centre -> hem
  // state
  phase: Phase;
  t0: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  ox: number;
  oy: number;
  tx: number;
  ty: number;
  homeX: number;
  homeY: number;
  born: number;
  fade: number;
  rank: number;
  M: V;
  Mv: V;
  E: V;
  Ev: V;
  liftL: number;
  liftR: number;
  liftTL: number;
  liftTR: number;
  liftEnd: number;
  nextLift: number;
  gx: number;
  gy: number;
  blinkAt: number;
  yearnUntil: number;
  yearnX: number;
  yearnY: number;
  retA0: number; // body angle when the return began (0 = hanging down)
  // personality: every ghost breathes and flutters at its own pace
  seed: number;
  sus: number;
  bobAmp: number;
  bobFreq: number;
  swayAmp: number;
  swayFreq: number;
  flFreq: number;
  brFreq: number;
  twFreq: number;
  asym: number;
  lean: number; // personal hem direction: negative = left, positive = right
  jitter: number;
  foldA: number[];
  foldV: number[];
}

interface Memory {
  text: string;
  x: number;
  y: number;
}

const MAX_GHOSTS = 20;
const SPAWN_MS = 1000;
const RETURN_MS = 620;
const APPEAR_MS = 280;
const FADEOUT_MS = 1800;
const SVG_NS = 'http://www.w3.org/2000/svg';
const DOWN: V = { x: 0, y: 1 };
const SPINE = [0, 0.1, 0.22, 0.35, 0.48, 0.6, 0.72, 0.83, 0.92, 1];
const HEM_STEPS = 18;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const smooth = (a: number, b: number, t: number) => {
  const u = clamp((t - a) / (b - a), 0, 1);
  return u * u * (3 - 2 * u);
};
const norm = (x: number, y: number): V => {
  const l = Math.hypot(x, y) || 1;
  return { x: x / l, y: y / l };
};
const f1 = (n: number) => n.toFixed(1);

/** Smooth closed outline through points (Catmull-Rom -> cubic Béziers). */
function closedPath(p: V[]) {
  const n = p.length;
  let d = `M${f1(p[0].x)} ${f1(p[0].y)}`;
  for (let i = 0; i < n; i++) {
    const p0 = p[(i - 1 + n) % n];
    const p1 = p[i];
    const p2 = p[(i + 1) % n];
    const p3 = p[(i + 2) % n];
    d += `C${f1(p1.x + (p2.x - p0.x) / 6)} ${f1(p1.y + (p2.y - p0.y) / 6)} ${f1(p2.x - (p3.x - p1.x) / 6)} ${f1(
      p2.y - (p3.y - p1.y) / 6,
    )} ${f1(p2.x)} ${f1(p2.y)}`;
  }
  return d + 'Z';
}

/**
 * One breeze shared by every ghost. It travels across the page, so ghosts at
 * different x feel the same gust at different moments. Incommensurate
 * frequencies keep it from looping visibly.
 */
function windAt(x: number, t: number) {
  const u = t - x / 240;
  const base = 0.55 * Math.sin(u * 0.21 + 1.3) + 0.3 * Math.sin(u * 0.53 + 0.4) + 0.15 * Math.sin(u * 1.13 + 2.1);
  const gust = Math.pow(Math.max(0, Math.sin(u * 0.17 + 0.6)), 6);
  const gustDir = Math.sin(u * 0.071 + 2.2); // gusts come from either side
  return base * 0.55 + gust * gustDir * (0.6 + 0.15 * Math.sin(u * 2.3));
}

/** Keep `p` within `max` radians of straight down from `anchor`. */
function keepBelow(p: V, anchor: V, max: number, vel: V) {
  const dx = p.x - anchor.x;
  const dy = p.y - anchor.y;
  const a = Math.atan2(dx, dy);
  if (Math.abs(a) <= max) return;
  const d = Math.hypot(dx, dy);
  const c = Math.sign(a) * max;
  p.x = anchor.x + Math.sin(c) * d;
  p.y = anchor.y + Math.cos(c) * d;
  vel.x *= 0.5;
  vel.y *= 0.5;
}

function keepDistance(p: V, anchor: V, min: number, max: number) {
  const dx = p.x - anchor.x;
  const dy = p.y - anchor.y;
  const d = Math.hypot(dx, dy) || 0.01;
  const c = clamp(d, min, max);
  if (c !== d) {
    p.x = anchor.x + (dx / d) * c;
    p.y = anchor.y + (dy / d) * c;
  }
}

export class GhostLayer {
  private ghosts = new Map<number, Ghost>();
  private memory = new Map<number, Memory>();
  private svg: SVGSVGElement;
  private uid = Math.random().toString(36).slice(2, 7);
  private raf = 0;
  private last = 0;
  private mouse: Point | null = null;
  private mouseVel: V = { x: 0, y: 0 };
  private mouseT = 0;
  private nextYearn = 0;
  private reduced = false;
  private hover = true;
  private mqReduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  private mqHover = window.matchMedia('(hover: hover) and (pointer: fine)');
  private nextId = 1;
  private skyBox: Box | null = null; // cached once per frame

  constructor(private layer: HTMLElement, private env: LayerEnv) {
    this.reduced = this.mqReduced.matches;
    this.hover = this.mqHover.matches;
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('class', 'ghost-svg');
    this.svg.innerHTML = `<defs>
      <filter id="${this.uid}-soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="0.8"/></filter>
      <filter id="${this.uid}-fold" x="-60%" y="-30%" width="220%" height="160%"><feGaussianBlur stdDeviation="2"/></filter>
    </defs>`;
    layer.appendChild(this.svg);
    this.mqReduced.addEventListener('change', this.onMq);
    this.mqHover.addEventListener('change', this.onMq);
    window.addEventListener('pointermove', this.onPointer, { passive: true });
    document.addEventListener('pointerleave', this.onLeave);
    window.addEventListener('blur', this.onLeave);
    window.addEventListener('resize', this.onResize);
    window.visualViewport?.addEventListener('resize', this.onResize);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.resizeTimer);
    this.mqReduced.removeEventListener('change', this.onMq);
    this.mqHover.removeEventListener('change', this.onMq);
    window.removeEventListener('pointermove', this.onPointer);
    document.removeEventListener('pointerleave', this.onLeave);
    window.removeEventListener('blur', this.onLeave);
    window.removeEventListener('resize', this.onResize);
    window.visualViewport?.removeEventListener('resize', this.onResize);
    this.layer.textContent = '';
    this.ghosts.clear();
  }

  newId() {
    return this.nextId++;
  }

  get count() {
    return this.ghosts.size;
  }

  isAlive(id: number) {
    return this.ghosts.has(id);
  }

  // ---------------------------------------------------------------- public API

  /** A deletion just happened: lift the text off the page at `at`. */
  spawn(id: number, text: string, at: Point) {
    const old = this.ghosts.get(id);
    if (old) this.removeEl(old);
    const g = this.create(id, text, at.x, at.y);
    g.phase = 'spawn';
    this.ghosts.set(id, g);
    this.memory.set(id, { text, x: g.homeX, y: g.homeY });
    this.enforceLimit();
    this.start();
  }

  /** Held backspace: the same veil gathers more text and grows. */
  grow(id: number, text: string, at: Point | null) {
    const g = this.ghosts.get(id);
    if (!g || g.phase === 'return') return false;
    g.text = text;
    this.layout(g);
    const mem = this.memory.get(id);
    if (mem) mem.text = text;
    if (g.phase === 'spawn' || g.phase === 'teleport') {
      g.phase = 'spawn';
      g.t0 = performance.now() - SPAWN_MS * 0.5;
      if (at) {
        g.ox = lerp(g.ox, at.x, 0.5);
        g.oy = lerp(g.oy, at.y, 0.5);
      }
    }
    return true;
  }

  /** Undo of a deletion: draw the veil back onto the text at `to`. */
  recall(id: number, text: string, to: Point) {
    let g = this.ghosts.get(id);
    const now = performance.now();
    if (!g) {
      // Already faded away: let it reappear where it used to drift.
      const mem = this.memory.get(id);
      const sky = this.env.sky();
      const x = mem ? mem.x : lerp(sky.left, sky.right, Math.random());
      const y = mem ? mem.y : lerp(sky.top, sky.bottom, 0.5);
      g = this.create(id, mem?.text ?? text, x, y, 1);
      g.fade = 0;
      g.phase = 'appear';
      g.t0 = now;
      g.tx = to.x;
      g.ty = to.y;
      this.ghosts.set(id, g);
      this.start();
      return;
    }
    g.phase = 'return';
    g.t0 = now;
    g.ox = g.x;
    g.oy = g.y;
    g.tx = to.x;
    g.ty = to.y;
    g.retA0 = Math.atan2(g.E.x - g.x, g.E.y - (g.y - g.dT));
    this.start();
  }

  /** Finish a return instantly (e.g. the restored text was edited). */
  dismiss(id: number) {
    const g = this.ghosts.get(id);
    if (g) this.removeEl(g);
  }

  // ---------------------------------------------------------------- internals

  private onMq = () => {
    this.reduced = this.mqReduced.matches;
    this.hover = this.mqHover.matches;
  };

  private onPointer = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse' || !this.hover) {
      this.mouse = null;
      return;
    }
    const r = this.layer.getBoundingClientRect();
    const p = { x: e.clientX - r.left, y: e.clientY - r.top };
    const now = performance.now();
    if (this.mouse && this.mouseT) {
      const dt = Math.max(8, now - this.mouseT) / 1000;
      const vx = clamp((p.x - this.mouse.x) / dt, -1600, 1600);
      const vy = clamp((p.y - this.mouse.y) / dt, -1600, 1600);
      this.mouseVel.x = lerp(this.mouseVel.x, vx, 0.5);
      this.mouseVel.y = lerp(this.mouseVel.y, vy, 0.5);
    }
    this.mouse = p;
    this.mouseT = now;
  };

  private onLeave = () => {
    this.mouse = null;
    this.mouseVel = { x: 0, y: 0 };
  };

  private resizeTimer = 0;

  private onResize = () => {
    this.skyBox = this.env.sky();
    for (const g of this.ghosts.values()) this.clampHome(g);
    // Once the window settles, spread out again over the new space; ghosts
    // drift to their new spots on their own.
    clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      this.skyBox = this.env.sky();
      const floating = [...this.ghosts.values()].filter((g) => g.phase === 'float');
      for (const g of floating) {
        g.homeX = g.homeY = NaN; // ignore its own old spot while choosing
      }
      for (const g of floating) this.pickHome(g);
    }, 250);
  };

  private bounds(g: Ghost) {
    const sky = this.skyBox ?? this.env.sky();
    // Room for sway, wind lean and the flared hem, so nothing leaves the screen.
    const half = g.R * 1.9 + 14;
    const minY = sky.top + g.dT + g.R + 28;
    return {
      minX: sky.left + half,
      maxX: Math.max(sky.left + half, sky.right - half),
      minY,
      maxY: Math.max(minY, sky.bottom - (g.L - g.dT + g.R * 0.9) - 16),
    };
  }

  private clampHome(g: Ghost) {
    const b = this.bounds(g);
    g.homeX = clamp(g.homeX, b.minX, b.maxX);
    g.homeY = clamp(g.homeY, b.minY, b.maxY);
  }

  private create(id: number, text: string, x: number, y: number, startScale = 0.3): Ghost {
    const u = `${this.uid}-${id}-${Math.random().toString(36).slice(2, 6)}`;
    const textEl = document.createElement('div');
    textEl.className = 'ghost-text';
    this.layer.insertBefore(textEl, this.svg);

    const group = document.createElementNS(SVG_NS, 'g');
    // Opacity lives in the gradients, so the gauze is thin at the top and
    // vanishes toward the hem, wherever the body bends.
    group.innerHTML = `
      <defs>
        <linearGradient id="${u}b" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#f3ede1" stop-opacity="0.44"/>
          <stop offset="0.35" stop-color="#efe8da" stop-opacity="0.38"/>
          <stop offset="0.72" stop-color="#ece4d4" stop-opacity="0.25"/>
          <stop offset="1" stop-color="#e9e0ce" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="${u}e" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#f8f3e8" stop-opacity="0.26"/>
          <stop offset="0.4" stop-color="#f8f3e8" stop-opacity="0.06"/>
          <stop offset="0.8" stop-color="#f8f3e8" stop-opacity="0.012"/>
          <stop offset="1" stop-color="#f8f3e8" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="${u}f" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#f6f0e4" stop-opacity="1"/>
          <stop offset="0.6" stop-color="#f6f0e4" stop-opacity="0.75"/>
          <stop offset="1" stop-color="#f6f0e4" stop-opacity="0"/>
        </linearGradient>
        <radialGradient id="${u}g" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#faf6ec" stop-opacity="0.025"/>
          <stop offset="1" stop-color="#faf6ec" stop-opacity="0"/>
        </radialGradient>
        <clipPath id="${u}c"><path/></clipPath>
      </defs>
      <g class="veil">
        <path fill="url(#${u}b)" filter="url(#${this.uid}-soft)"/>
        <g clip-path="url(#${u}c)">
          <ellipse fill="url(#${u}g)"/>
          <g filter="url(#${this.uid}-fold)">
            <path fill="url(#${u}f)"/><path fill="url(#${u}f)"/><path fill="url(#${u}f)"/>
          </g>
        </g>
        <path fill="none" stroke="url(#${u}e)" stroke-width="0.8"/>
      </g>
      <g class="ghost-eyes"><ellipse/><ellipse/></g>`;
    this.svg.appendChild(group);
    const veil = group.querySelector('.veil') as SVGGElement;
    const vpaths = Array.from(veil.querySelectorAll(':scope > path')) as SVGPathElement[];
    const folds = Array.from(veil.querySelectorAll(':scope > g > g > path')) as SVGPathElement[];
    const eyes = group.querySelector('.ghost-eyes') as SVGGElement;
    const [eyeL, eyeR] = Array.from(eyes.querySelectorAll('ellipse')) as SVGEllipseElement[];

    const seed = Math.random() * 1000;
    const now = performance.now();
    const g: Ghost = {
      id,
      text,
      textEl,
      group,
      veil,
      body: vpaths[0],
      edge: vpaths[1],
      clip: group.querySelector('clipPath path') as SVGPathElement,
      folds,
      glow: veil.querySelector('ellipse') as SVGEllipseElement,
      eyes,
      eyeL,
      eyeR,
      grads: Array.from(group.querySelectorAll('linearGradient')) as SVGLinearGradientElement[],
      glowGrad: group.querySelector('radialGradient') as SVGRadialGradientElement,
      tw: 0,
      th: 0,
      font: 20,
      R: 24,
      dT: 30,
      L: 80,
      phase: 'spawn',
      t0: now,
      x,
      y,
      vx: 0,
      vy: 0,
      ox: x,
      oy: y,
      tx: x,
      ty: y,
      homeX: x,
      homeY: y,
      born: now,
      fade: 1,
      rank: 1,
      M: { x, y },
      Mv: { x: 0, y: 0 },
      E: { x, y },
      Ev: { x: 0, y: 0 },
      liftL: 0,
      liftR: 0,
      liftTL: 0,
      liftTR: 0,
      liftEnd: 0,
      nextLift: now + 3000 + Math.random() * 6000,
      gx: 0,
      gy: 0,
      blinkAt: now + 2500 + Math.random() * 5000,
      yearnUntil: 0,
      yearnX: 0,
      yearnY: 0,
      retA0: 0,
      seed,
      sus: 0.75 + Math.random() * 0.5,
      bobAmp: 3 + Math.random() * 3,
      bobFreq: 0.45 + Math.random() * 0.3,
      swayAmp: 3 + Math.random() * 3,
      swayFreq: 0.22 + Math.random() * 0.18,
      flFreq: 1.1 + Math.random() * 0.6,
      brFreq: 0.55 + Math.random() * 0.35,
      twFreq: 0.3 + Math.random() * 0.25,
      asym: (Math.random() - 0.5) * 0.14,
      lean: (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random() * 0.4),
      jitter: 0.92 + Math.random() * 0.16,
      foldA: [-0.42 + Math.random() * 0.12, -0.05 + Math.random() * 0.12, 0.3 + Math.random() * 0.14],
      foldV: [0.3 + Math.random() * 0.15, 0.18 + Math.random() * 0.15, 0.35 + Math.random() * 0.15],
    };
    this.layout(g);
    // Start the body hanging at rest below the head.
    const hy = y - g.dT * startScale;
    g.M = { x, y: hy + g.L * startScale * 0.5 };
    g.E = { x, y: hy + g.L * startScale };
    this.pickHome(g);
    return g;
  }

  /** (Re)compute dimensions from the text. Layout is read only here. */
  private layout(g: Ghost) {
    const { label, count } = ghostLabel(g.text, 30);
    g.textEl.textContent = label;
    g.font = count <= 2 ? 20 : count <= 6 ? 17 : count <= 14 ? 14.5 : 13;
    g.textEl.style.fontSize = `${g.font}px`;
    g.tw = g.textEl.offsetWidth;
    g.th = g.textEl.offsetHeight;
    g.R = clamp(g.tw * 0.42 + 17, 23, 62) * g.jitter;
    g.dT = g.R * 0.5 + g.th * 0.5 + 6;
    g.L = g.dT + g.th * 0.5 + g.R * 1.05 + 12;
  }

  /** Anywhere above the box, as far from the other ghosts as possible. */
  private pickHome(g: Ghost) {
    const b = this.bounds(g);
    const others = [...this.ghosts.values()].filter(
      (o) => o !== g && o.phase !== 'return' && o.phase !== 'fadeout' && !Number.isNaN(o.homeX),
    );
    let best = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, score: -Infinity };
    for (let i = 0; i < 24; i++) {
      const x = lerp(b.minX, b.maxX, Math.random());
      // Stay in the lower part of the sky, close to the writing.
      const y = lerp(lerp(b.minY, b.maxY, 0.45), b.maxY, Math.random());
      let score = 1e6;
      for (const o of others) score = Math.min(score, Math.hypot(o.homeX - x, (o.homeY - y) * 1.2) - (o.R + g.R) * 1.3);
      score += Math.random() * 20; // a little randomness so layouts differ
      if (score > best.score) best = { x, y, score };
    }
    g.homeX = best.x;
    g.homeY = best.y;
  }

  private enforceLimit() {
    const living = [...this.ghosts.values()]
      .filter((g) => g.phase !== 'return' && g.phase !== 'fadeout' && g.phase !== 'appear')
      .sort((a, b) => a.born - b.born);
    const extra = living.length - MAX_GHOSTS;
    for (let i = 0; i < extra; i++) {
      living[i].phase = 'fadeout';
      living[i].t0 = performance.now();
    }
  }

  private removeEl(g: Ghost) {
    const mem = this.memory.get(g.id);
    if (mem) {
      mem.x = g.homeX;
      mem.y = g.homeY;
    }
    g.textEl.remove();
    g.group.remove();
    this.ghosts.delete(g.id);
  }

  private start() {
    if (this.raf) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (now: number) => {
    const dt = clamp((now - this.last) / 1000, 0, 1 / 30);
    this.last = now;
    const t = now / 1000;
    this.skyBox = this.env.sky();
    const decay = Math.exp(-dt * 5);
    this.mouseVel.x *= decay;
    this.mouseVel.y *= decay;

    const floating = [...this.ghosts.values()]
      .filter((g) => g.phase === 'float' || g.phase === 'teleport')
      .sort((a, b) => b.born - a.born);
    floating.forEach((g, i) => {
      const target = 1 - 0.5 * (i / Math.max(1, MAX_GHOSTS - 1));
      g.rank = lerp(g.rank, target, 1 - Math.exp(-dt * 2));
    });

    this.maybeYearn(now, floating);

    // Gentle personal space between floating ghosts.
    const sep = new Map<Ghost, V>();
    for (let i = 0; i < floating.length; i++) {
      for (let j = i + 1; j < floating.length; j++) {
        const a = floating[i];
        const b = floating[j];
        const dx = a.x - b.x;
        const dy = a.y - a.dT + a.L * 0.4 - (b.y - b.dT + b.L * 0.4);
        const min = (a.R + b.R) * 1.35 + 8;
        const d = Math.hypot(dx, dy) || 0.01;
        if (d < min) {
          const f = (min - d) * 4;
          const pa = sep.get(a) ?? { x: 0, y: 0 };
          const pb = sep.get(b) ?? { x: 0, y: 0 };
          pa.x += (dx / d) * f;
          pa.y += (dy / d) * f * 0.6;
          pb.x -= (dx / d) * f;
          pb.y -= (dy / d) * f * 0.6;
          sep.set(a, pa);
          sep.set(b, pb);
        }
      }
    }

    for (const g of [...this.ghosts.values()]) this.step(g, now, t, dt, sep.get(g));

    if (this.ghosts.size > 0) this.raf = requestAnimationFrame(this.tick);
    else this.raf = 0;
  };

  private maybeYearn(now: number, floating: Ghost[]) {
    if (this.reduced || floating.length === 0) return;
    if (!this.nextYearn) this.nextYearn = now + 7000 + Math.random() * 5000;
    if (now < this.nextYearn) return;
    this.nextYearn = now + 9000 + Math.random() * 8000;
    const candidates = floating.filter((g) => g.phase === 'float' && now - g.born > 4000);
    if (!candidates.length) return;
    const g = candidates[Math.floor(Math.random() * candidates.length)];
    const ed = this.env.editor();
    g.yearnUntil = now + 2800 + Math.random() * 1400;
    g.yearnX = clamp(g.homeX, ed.left + g.R * 1.5, ed.right - g.R * 1.5);
    // The hem stays just above the editor, so the caret is never covered.
    g.yearnY = ed.top - (g.L - g.dT + g.R * 0.9) - 10;
  }

  private step(g: Ghost, now: number, t: number, dt: number, sep?: V) {
    const rm = this.reduced;
    const scale0 = this.env.editorFontSize() / g.font;
    let sc = 1; // veil size while forming
    let veilA = 1;
    let eyesA = 1;
    let textA = 0.8;
    let textS = 1;
    let textPin = 0; // 1 = text held exactly at (x, y)
    let collapse = 1;
    let stretch = 1;
    let stiff = 1;
    let restDir = DOWN;
    let cone = 1.15; // max lean of the body from vertical, radians
    let headFollow = 0.35;
    let taper = 0; // 1 = tail narrows to a wisp (while being pulled back)
    let guided: { ang: number; bend: number } | null = null; // scripted spine (return)
    let opacity = g.fade * g.rank;
    const u = now - g.t0;

    switch (g.phase) {
      case 'spawn': {
        // The words fade and rise; a thin veil gathers around them.
        const m = clamp(u / (rm ? 320 : SPAWN_MS), 0, 1);
        g.x = g.ox;
        // Rise gently and keep accelerating, so the drift that follows
        // continues the same motion instead of starting from a standstill.
        g.y = g.oy - (rm ? 0 : 16 * m * m);
        sc = lerp(0.3, 1, easeOut(smooth(0.05, 1, m)));
        veilA = smooth(0.1, 0.85, m);
        eyesA = smooth(0.65, 1, m);
        textA = lerp(1, 0.8, smooth(0, 0.75, m));
        textS = lerp(scale0, 1, easeOut(m));
        textPin = 1 - smooth(0.5, 1, m);
        if (m >= 1) {
          g.vx = 0;
          g.vy = -32 / (SPAWN_MS / 1000); // same speed the rise ended with
          g.phase = rm ? 'teleport' : 'float';
          g.t0 = now;
          // Spend the rest of this frame drifting, so the hand-off has no gap.
          const over = (u - SPAWN_MS) / 1000;
          if (!rm && over > 0) this.drift(g, t, Math.min(over, dt), now, sep);
        }
        break;
      }
      case 'teleport': {
        // Reduced motion: cross-fade to its home instead of drifting there.
        const m = clamp(u / 380, 0, 1);
        opacity *= m < 0.5 ? 1 - m * 2 : (m - 0.5) * 2;
        if (m >= 0.5) {
          g.x = g.homeX;
          g.y = g.homeY;
        }
        if (m >= 1) {
          g.phase = 'float';
          g.t0 = now;
        }
        break;
      }
      case 'float':
      case 'fadeout': {
        if (g.phase === 'fadeout') {
          const m = clamp(u / FADEOUT_MS, 0, 1);
          g.fade = 1 - easeInOut(m);
          opacity = g.fade * g.rank;
          if (m >= 1) {
            this.removeEl(g);
            return;
          }
        } else if (g.fade < 1) {
          g.fade = Math.min(1, g.fade + dt * 3);
        }
        if (rm) {
          g.x = g.homeX;
          g.y = g.homeY;
          break;
        }
        this.drift(g, t, dt, now, sep);
        break;
      }
      case 'appear': {
        const m = clamp(u / APPEAR_MS, 0, 1);
        g.fade = easeOut(m);
        opacity = g.fade;
        g.rank = 1;
        if (m >= 1) {
          g.phase = 'return';
          g.t0 = now;
          g.ox = g.x;
          g.oy = g.y;
          g.retA0 = 0;
        }
        break;
      }
      case 'return': {
        const m = clamp(u / (rm ? 240 : RETURN_MS), 0, 1);
        g.fade = Math.min(1, g.fade + dt * 8);
        g.rank = lerp(g.rank, 1, 1 - Math.exp(-dt * 12));
        opacity = g.fade * g.rank;
        if (rm) {
          g.x = g.tx;
          g.y = g.ty;
          veilA = 1 - m;
          eyesA = 1 - m;
          textS = scale0;
          textA = lerp(0.8, 1, m);
          textPin = 1;
        } else {
          // Sucked back: a slow start, then faster and faster into the line.
          const p = m * m * (1.6 - 0.6 * m);
          g.x = lerp(g.ox, g.tx, p);
          g.y = lerp(g.oy, g.ty, p);
          // The veil tips over head-first toward its word, its body pointing
          // back along the path and stretching out behind it.
          const fl = norm(g.tx - g.ox, g.ty - g.oy);
          const target = Math.atan2(-fl.x, -fl.y);
          let delta = target - g.retA0;
          while (delta > Math.PI) delta -= Math.PI * 2;
          while (delta < -Math.PI) delta += Math.PI * 2;
          // Straight down: tip over on the side away from any sideways pull.
          if (Math.abs(delta) > 2.7) delta = (fl.x <= 0 ? 1 : -1) * Math.abs(delta);
          const turn = easeInOut(smooth(0, 0.42, m));
          guided = {
            ang: g.retA0 + delta * turn,
            // The tail lags the turn a little, then straightens as it's pulled.
            bend: -Math.sign(delta) * Math.sin(smooth(0, 0.6, m) * Math.PI) * 0.35,
          };
          headFollow = 1;
          stretch = 1 + 0.6 * smooth(0.2, 0.85, m);
          taper = smooth(0.12, 0.65, m);
          collapse = lerp(1, 0.22, smooth(0.3, 1, m));
          veilA = 1 - smooth(0.55, 1, m);
          eyesA = 1 - smooth(0, 0.35, m);
          textA = lerp(0.8, 1, smooth(0.15, 0.85, m));
          textS = lerp(1, scale0, easeInOut(m));
          textPin = smooth(0, 0.6, m);
        }
        if (m >= 1) {
          this.removeEl(g);
          this.env.onLanded(g.id);
          return;
        }
        break;
      }
    }

    const R = g.R * sc;
    const dT = g.dT * sc;
    const L = g.L * sc * stretch;
    let head: V = { x: g.x, y: g.y - dT };
    const wind = rm ? 0 : clamp(windAt(head.x, t) * g.sus, -1.1, 1.2);
    if (guided) {
      // The words sit on the spine dT from the head, whichever way it points.
      const dir = { x: Math.sin(guided.ang), y: Math.cos(guided.ang) };
      const perp = { x: dir.y, y: -dir.x };
      head = { x: g.x - dir.x * dT, y: g.y - dir.y * dT };
      g.M = { x: head.x + dir.x * L * 0.5 + perp.x * guided.bend * L * 0.12, y: head.y + dir.y * L * 0.5 + perp.y * guided.bend * L * 0.12 };
      g.E = { x: head.x + dir.x * L + perp.x * guided.bend * L * 0.3, y: head.y + dir.y * L + perp.y * guided.bend * L * 0.3 };
      g.Mv = { x: 0, y: 0 };
      g.Ev = { x: 0, y: 0 };
      g.liftL = g.liftR = 0;
    } else {
      this.simulate(g, head, R, L, wind, dt, stiff, restDir, rm, cone);
      this.updateLifts(g, now, dt, wind, rm);
    }
    this.paint(g, head, R, L, dT, rm ? 0 : t, dt, now, {
      opacity,
      veilA,
      eyesA,
      textA,
      textS,
      textPin,
      collapse,
      headFollow,
      taper,
    });
  }

  /** The head's own slow drift toward home, nudged by wind and the mouse. */
  private drift(g: Ghost, t: number, dt: number, now: number, sep?: V) {
    const wind = windAt(g.x, t) * g.sus;
    let tx = g.homeX + Math.sin(t * g.swayFreq + g.seed) * g.swayAmp + wind * g.R * 0.2;
    let ty = g.homeY + Math.sin(t * g.bobFreq + g.seed * 1.7) * g.bobAmp;
    if (now < g.yearnUntil) {
      tx = g.yearnX + Math.sin(t * 0.9 + g.seed) * 3;
      ty = g.yearnY + Math.sin(t * 1.3 + g.seed) * 2;
    }
    const k = 1.5;
    const c = 2.3;
    let ax = (tx - g.x) * k - g.vx * c;
    let ay = (ty - g.y) * k - g.vy * c;
    if (this.mouse) {
      const hx = g.x;
      const hy = g.y - g.dT + g.L * 0.3;
      const dx = hx - this.mouse.x;
      const dy = hy - this.mouse.y;
      const d = Math.hypot(dx, dy) || 0.01;
      const RA = 110 + g.R * 1.4;
      if (d < RA) {
        const f = Math.pow(1 - d / RA, 1.5);
        ax += (dx / d) * f * 120 + this.mouseVel.x * f * 0.3;
        ay += (dy / d) * f * 80 + this.mouseVel.y * f * 0.2;
      }
    }
    if (sep) {
      ax += sep.x;
      ay += sep.y;
    }
    // Soft walls: a gentle push back inside, never a snap. A new ghost starts
    // down at the editor, below its allowed area, and simply rises out of it.
    const b = this.bounds(g);
    if (g.x < b.minX) ax += (b.minX - g.x) * 6;
    if (g.x > b.maxX) ax += (b.maxX - g.x) * 6;
    if (g.y < b.minY) ay += (b.minY - g.y) * 6;
    g.vx += ax * dt;
    g.vy += ay * dt;
    const sp = Math.hypot(g.vx, g.vy);
    if (sp > 150) {
      g.vx *= 150 / sp;
      g.vy *= 150 / sp;
    }
    g.x += g.vx * dt;
    g.y += g.vy * dt;
  }

  /** Mid and hem follow the head on softer and softer springs (drag). */
  private simulate(
    g: Ghost,
    head: V,
    R: number,
    L: number,
    wind: number,
    dt: number,
    stiff: number,
    rest: V,
    rm: boolean,
    cone: number,
  ) {
    // Personal lean, slowly breathing so a hem sometimes eases to the other side.
    const lean = rm ? 0 : g.lean + 0.35 * Math.sin(performance.now() / 1000 * 0.11 + g.seed);
    const kM = 22 * stiff;
    const cM = 6.5 * Math.sqrt(stiff);
    const kE = 9 * stiff;
    const cE = 3.9 * Math.sqrt(stiff);

    const mr = {
      x: head.x + rest.x * L * 0.5 + (wind * 0.35 + lean * 0.6) * R * 0.26,
      y: head.y + rest.y * L * 0.5 - Math.abs(wind) * R * 0.05,
    };
    let ax = (mr.x - g.M.x) * kM - g.Mv.x * cM;
    let ay = (mr.y - g.M.y) * kM - g.Mv.y * cM;
    let bx = 0;
    let by = 0;
    if (this.mouse && !rm) {
      // A passing hand stirs the air: the gauze is pushed along with it.
      const RA = 130 + R * 1.6;
      const dm = Math.hypot(this.mouse.x - g.M.x, this.mouse.y - g.M.y);
      if (dm < RA) {
        const f = Math.pow(1 - dm / RA, 2);
        ax += this.mouseVel.x * f * 1.4;
        ay += this.mouseVel.y * f * 0.7;
      }
      const de = Math.hypot(this.mouse.x - g.E.x, this.mouse.y - g.E.y);
      if (de < RA) {
        const f = Math.pow(1 - de / RA, 2);
        bx += this.mouseVel.x * f * 2.1;
        by += this.mouseVel.y * f * 1;
      }
    }
    g.Mv.x += ax * dt;
    g.Mv.y += ay * dt;
    g.M.x += g.Mv.x * dt;
    g.M.y += g.Mv.y * dt;

    const hm = norm(g.M.x - head.x, g.M.y - head.y);
    const dir = norm(lerp(rest.x, hm.x, 0.7), lerp(rest.y, hm.y, 0.7));
    const er = {
      x: g.M.x + dir.x * L * 0.5 + (wind * 0.35 + lean * 1.2) * R * 0.42,
      y: g.M.y + dir.y * L * 0.5 - Math.abs(wind) * R * 0.12,
    };
    g.Ev.x += ((er.x - g.E.x) * kE - g.Ev.x * cE + bx) * dt;
    g.Ev.y += ((er.y - g.E.y) * kE - g.Ev.y * cE + by) * dt;
    g.E.x += g.Ev.x * dt;
    g.E.y += g.Ev.y * dt;

    keepDistance(g.M, head, L * 0.32, L * 0.72);
    keepDistance(g.E, g.M, L * 0.3, L * 0.8);
    // Cloth hangs: the body may lean and swing, but never fold up over the
    // head — that is what made sharp, crossing outlines.
    keepBelow(g.M, head, cone, g.Mv);
    keepBelow(g.E, g.M, cone * 1.15, g.Ev);
  }

  /** Now and then one side of the hem is lifted by the air, then settles. */
  private updateLifts(g: Ghost, now: number, dt: number, wind: number, rm: boolean) {
    if (rm) {
      g.liftL = g.liftR = 0;
      return;
    }
    if (g.phase === 'float' && now > g.nextLift) {
      const amt = 0.5 + Math.random() * 0.5;
      if (Math.random() < 0.5) g.liftTL = amt;
      else g.liftTR = amt;
      g.liftEnd = now + 700 + Math.random() * 1000;
      g.nextLift = now + 5000 + Math.random() * 8000;
    }
    if (now > g.liftEnd) g.liftTL = g.liftTR = 0;
    // A strong gust lifts the downwind edge too.
    const gustR = Math.max(0, wind - 0.6) * 0.8;
    const gustL = Math.max(0, -wind - 0.6) * 0.8;
    const ease = (cur: number, target: number) =>
      cur + (target - cur) * (1 - Math.exp(-dt * (target > cur ? 2.4 : 0.8)));
    g.liftL = ease(g.liftL, Math.min(1, g.liftTL + gustL));
    g.liftR = ease(g.liftR, Math.min(1, g.liftTR + gustR));
  }

  private paint(
    g: Ghost,
    head: V,
    R: number,
    L: number,
    dT: number,
    t: number,
    dt: number,
    now: number,
    s: {
      opacity: number;
      veilA: number;
      eyesA: number;
      textA: number;
      textS: number;
      textPin: number;
      collapse: number;
      headFollow: number;
      taper: number;
    },
  ) {
    const M = g.M;
    const E = g.E;
    // Quadratic spine through head, mid and hem.
    const C = { x: 2 * M.x - 0.5 * (head.x + E.x), y: 2 * M.y - 0.5 * (head.y + E.y) };
    const at = (v: number): V => {
      const a = (1 - v) * (1 - v);
      const b = 2 * v * (1 - v);
      const c = v * v;
      return { x: a * head.x + b * C.x + c * E.x, y: a * head.y + b * C.y + c * E.y };
    };
    const tan = (v: number): V =>
      norm(2 * (1 - v) * (C.x - head.x) + 2 * v * (E.x - C.x), 2 * (1 - v) * (C.y - head.y) + 2 * v * (E.y - C.y));

    const sd = g.seed;
    const col = s.collapse;
    // Layered, out-of-phase motion: a ripple travelling down the body,
    // breathing (billow and gather), and a slow twist.
    const flutter = (v: number) =>
      R *
      (0.11 * Math.pow(v, 1.6) * Math.sin(v * 3 - t * g.flFreq + sd) +
        0.05 * v * v * Math.sin(v * 6.3 - t * g.flFreq * 1.63 + sd * 1.3));
    const breath = (v: number) => 0.055 * Math.sin(t * g.brFreq + sd - v * 2.2);
    const twist = (v: number) => 0.08 * Math.sin(t * g.twFreq + sd * 0.7) * v;
    // Body as wide as the head all the way down, barely widening at the hem.
    const widthAt = (v: number) => R * (1 + 0.08 * Math.pow(v, 1.5));

    // Head frame: mostly upright, only partly following the body. While being
    // drawn home it turns fully with the body so the outline never folds over.
    const t0 = tan(0);
    const ht = norm(lerp(DOWN.x, t0.x, s.headFollow), lerp(DOWN.y, t0.y, s.headFollow));
    const hn = { x: ht.y, y: -ht.x };
    const up = { x: -ht.x, y: -ht.y };
    const domeH = R * 0.92 * lerp(1, col, 0.5);

    const samples = SPINE.map((v) => {
      const T = tan(v);
      // Blend from the head's frame into the body's so the shoulders stay round.
      const k = smooth(0, 0.45, v);
      const N = norm(lerp(hn.x, T.y, k), lerp(hn.y, -T.x, k));
      const base = at(v);
      const fl = flutter(v);
      const w = widthAt(v) * (1 - s.taper * 0.7 * Math.pow(v, 1.4));
      const b = breath(v);
      const tw = twist(v);
      return {
        p: { x: base.x + N.x * fl, y: base.y + N.y * fl },
        n: N,
        t: T,
        wr: (w * (1 + b + tw + g.asym) + g.liftR * R * 0.3 * v * v * v) * col,
        wl: (w * (1 + b - tw - g.asym) + g.liftL * R * 0.3 * v * v * v) * col,
      };
    });

    const pts: V[] = [];
    // Dome: left -> crown -> right. Softly lopsided, never a perfect arc.
    for (let k = 0; k <= 8; k++) {
      const th = Math.PI * (1 - k / 8);
      const c = Math.cos(th);
      const off = c < 0 ? c * samples[0].wl : c * samples[0].wr;
      const bump = 1 + 0.03 * Math.sin(th * 3 + t * 0.7 + sd);
      const sn = Math.sin(th) * domeH * bump;
      pts.push({ x: head.x + hn.x * off + up.x * sn, y: head.y + hn.y * off + up.y * sn });
    }
    // Right side, downward.
    for (let i = 1; i < samples.length; i++) {
      const sm = samples[i];
      pts.push({ x: sm.p.x + sm.n.x * sm.wr, y: sm.p.y + sm.n.y * sm.wr });
    }
    // Hem, right -> left: a thin, irregular edge, never regular teeth.
    const last = samples[samples.length - 1];
    const tau = Math.PI * 2;
    for (let j = 1; j < HEM_STEPS; j++) {
      const q = j / HEM_STEPS;
      const across = lerp(last.wr, -last.wl, q);
      const noise =
        0.1 * Math.sin(q * tau * 1.3 + t * 0.9 + sd) +
        0.07 * Math.sin(q * tau * 2.7 - t * 1.4 + sd * 1.9) +
        0.03 * Math.sin(q * tau * 4.1 + t * 1.8 + sd * 0.4);
      let ext = R * (0.3 + noise * 1.3 * col * col) * (1 - s.taper * 0.5) * (0.2 + 0.8 * Math.pow(Math.sin(q * Math.PI), 0.7)) * col;
      ext -= R * 0.38 * (g.liftR * (1 - q) * (1 - q) + g.liftL * q * q) * col;
      const out = R * 0.22 * (g.liftR * (1 - q) * (1 - q) - g.liftL * q * q) * col;
      pts.push({
        x: last.p.x + last.n.x * (across + out) + last.t.x * ext,
        y: last.p.y + last.n.y * (across + out) + last.t.y * ext,
      });
    }
    // Left side, upward.
    for (let i = samples.length - 1; i >= 1; i--) {
      const sm = samples[i];
      pts.push({ x: sm.p.x - sm.n.x * sm.wl, y: sm.p.y - sm.n.y * sm.wl });
    }
    const d = closedPath(pts);
    g.body.setAttribute('d', d);
    g.edge.setAttribute('d', d);
    g.clip.setAttribute('d', d);

    // Gradients run along the body's own axis, so they bend with it.
    const top = { x: head.x + up.x * R, y: head.y + up.y * R };
    const bottom = { x: last.p.x + last.t.x * R * 0.45, y: last.p.y + last.t.y * R * 0.45 };
    for (const gr of g.grads) {
      gr.setAttribute('x1', f1(top.x));
      gr.setAttribute('y1', f1(top.y));
      gr.setAttribute('x2', f1(bottom.x));
      gr.setAttribute('y2', f1(bottom.y));
    }
    const gc = { x: head.x + up.x * R * 0.15, y: head.y + up.y * R * 0.15 };
    g.glowGrad.setAttribute('cx', f1(gc.x));
    g.glowGrad.setAttribute('cy', f1(gc.y));
    g.glowGrad.setAttribute('r', f1(R * 1.3));
    g.glow.setAttribute('cx', f1(gc.x));
    g.glow.setAttribute('cy', f1(gc.y));
    g.glow.setAttribute('rx', f1(R * 1.3));
    g.glow.setAttribute('ry', f1(R * 1.3));

    // Folds: where the gauze overlaps itself it reads a little brighter.
    // They deepen when the body bends or gathers, and fade as it billows.
    const ex = E.x - head.x;
    const ey = E.y - head.y;
    const bend = Math.abs(ex * (M.y - head.y) - ey * (M.x - head.x)) / Math.max(1, ex * ex + ey * ey);
    for (let i = 0; i < g.folds.length; i++) {
      const v0 = g.foldV[i];
      const right: V[] = [];
      const left: V[] = [];
      for (let k = 0; k <= 6; k++) {
        const v = lerp(v0, 1, k / 6);
        const T = tan(v);
        const N = { x: T.y, y: -T.x };
        const base = at(v);
        const w = widthAt(v) * col;
        const off = g.foldA[i] * w + 0.13 * w * Math.sin(t * 0.6 + sd + i * 2.1 + v * 1.4) + flutter(v);
        const thick =
          (R * (0.035 + 0.1 * v) * (0.7 + 0.3 * Math.sin(t * 0.8 + i + v * 2)) * smooth(v0, v0 + 0.2, v) + 0.4) * col;
        const cx = base.x + N.x * off;
        const cy = base.y + N.y * off;
        right.push({ x: cx + N.x * thick, y: cy + N.y * thick });
        left.unshift({ x: cx - N.x * thick, y: cy - N.y * thick });
      }
      const compress = clamp(bend * 3 + Math.max(0, -breath(0.6)) * 5 + Math.abs(twist(0.7)) * 2.5, 0, 1);
      const a = (0.09 + 0.22 * compress) * (0.8 + 0.2 * Math.sin(t * 0.5 + i * 1.7 + sd));
      g.folds[i].setAttribute('d', closedPath([...right, ...left]));
      g.folds[i].setAttribute('fill-opacity', a.toFixed(3));
    }

    // Eyes: two small, low-contrast marks floating in the gauze.
    let gx = Math.sin(t * 0.4 + sd) * 0.4;
    let gy = 0.2;
    if (now < g.yearnUntil) {
      gx = 0;
      gy = 1;
    } else if (this.mouse && g.phase !== 'return') {
      const mx = this.mouse.x - head.x;
      const my = this.mouse.y - head.y;
      const md = Math.hypot(mx, my);
      if (md < 500) {
        gx = mx / Math.max(md, 40);
        gy = my / Math.max(md, 40);
      }
    }
    g.gx = lerp(g.gx, gx, 1 - Math.exp(-dt * 4));
    g.gy = lerp(g.gy, gy, 1 - Math.exp(-dt * 4));
    let blink = 1;
    if (now > g.blinkAt) {
      const b = (now - g.blinkAt) / 180;
      if (b >= 1) g.blinkAt = now + 3000 + Math.random() * 6000;
      else blink = 0.15 + 0.85 * Math.abs(1 - 2 * b);
    }
    const ec = {
      x: head.x + up.x * R * 0.06 + g.gx * R * 0.05,
      y: head.y + up.y * R * 0.06 + g.gy * R * 0.04,
    };
    const spacing = R * 0.29 * lerp(1, col, 0.6);
    const erx = clamp(R * 0.085, 2.6, 4.2);
    g.eyeL.setAttribute('cx', f1(ec.x - hn.x * spacing));
    g.eyeL.setAttribute('cy', f1(ec.y - hn.y * spacing));
    g.eyeR.setAttribute('cx', f1(ec.x + hn.x * spacing));
    g.eyeR.setAttribute('cy', f1(ec.y + hn.y * spacing));
    for (const e of [g.eyeL, g.eyeR]) {
      e.setAttribute('rx', erx.toFixed(2));
      e.setAttribute('ry', (erx * 1.35 * blink).toFixed(2));
    }

    g.group.style.opacity = s.opacity.toFixed(3);
    g.veil.style.opacity = s.veilA.toFixed(3);
    g.eyes.style.opacity = s.eyesA.toFixed(3);

    // The words drift inside the body, carried by it.
    const vt = clamp(dT / Math.max(1, L), 0, 1);
    const tp = at(vt);
    const tf = flutter(vt);
    const T = tan(vt);
    const free = { x: tp.x + T.y * tf, y: tp.y - T.x * tf };
    const px = lerp(free.x, g.x, s.textPin);
    const py = lerp(free.y, g.y, s.textPin);
    const rot = clamp(-Math.atan2(T.x, T.y) * 57.2958 * 0.35, -16, 16) * (1 - s.textPin);
    g.textEl.style.transform = `translate(${(px - g.tw / 2).toFixed(1)}px, ${(py - g.th / 2).toFixed(
      1,
    )}px) rotate(${rot.toFixed(2)}deg) scale(${s.textS.toFixed(3)})`;
    g.textEl.style.opacity = (s.textA * s.opacity).toFixed(3);
    const blur = 0.6 * (1 - Math.max(s.textPin, smooth(0.3, 1, s.textA)));
    g.textEl.style.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : '';
  }
}
