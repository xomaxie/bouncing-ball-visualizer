import * as PIXI from '../vendor/pixi/pixi.esm.js';

const TAU = Math.PI * 2;

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function hslToRgb(h, s, l) {
  const hue = ((((Number(h) || 0) % 360) + 360) % 360) / 360;
  const sat = clamp(Number(s) / 100);
  const light = clamp(Number(l) / 100);
  if (sat === 0) {
    const gray = Math.round(light * 255);
    return [gray, gray, gray];
  }
  const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
  const p = 2 * light - q;
  const convert = (t) => {
    let next = t;
    if (next < 0) next += 1;
    if (next > 1) next -= 1;
    if (next < 1 / 6) return p + (q - p) * 6 * next;
    if (next < 1 / 2) return q;
    if (next < 2 / 3) return p + (q - p) * (2 / 3 - next) * 6;
    return p;
  };
  return [convert(hue + 1 / 3), convert(hue), convert(hue - 1 / 3)].map((unit) => Math.round(clamp(unit) * 255));
}

function colorToHex(value, fallback = 0xbd82ff) {
  const raw = String(value || '').trim();
  const hex = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const body = hex[1].length === 3
      ? hex[1].split('').map((char) => `${char}${char}`).join('')
      : hex[1];
    return Number.parseInt(body, 16);
  }
  const hsl = raw.match(/^hsla?\(\s*([-0-9.]+)\s*,\s*([-0-9.]+)%\s*,\s*([-0-9.]+)%/i);
  if (hsl) {
    const [r, g, b] = hslToRgb(hsl[1], hsl[2], hsl[3]);
    return (r << 16) | (g << 8) | b;
  }
  const rgb = raw.match(/^rgba?\(\s*([-0-9.]+)\s*,\s*([-0-9.]+)\s*,\s*([-0-9.]+)/i);
  if (rgb) {
    const r = Math.round(clamp(rgb[1], 0, 255));
    const g = Math.round(clamp(rgb[2], 0, 255));
    const b = Math.round(clamp(rgb[3], 0, 255));
    return (r << 16) | (g << 8) | b;
  }
  return fallback;
}

function setFxCanvasStyle(canvas) {
  canvas.className = 'pixiFxLayer';
  Object.assign(canvas.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
    mixBlendMode: 'screen',
    zIndex: '2',
  });
}

function drawLightStreak(graphic, particle, color, power, { soft = false } = {}) {
  const alpha = clamp(particle.alpha) * (soft ? (0.18 + power * 0.10) : (0.44 + power * 0.16));
  if (alpha <= 0.006) {
    graphic.visible = false;
    return;
  }

  graphic.visible = true;
  graphic.clear();
  graphic.blendMode = 'add';
  const width = Math.max(0.08, Number(particle.lineWidth || 0.22)) * (soft ? (2.7 + power * 0.55) : (0.92 + power * 0.08));
  graphic.moveTo(particle.tailX, particle.tailY);
  graphic.quadraticCurveTo(
    Number.isFinite(particle.controlX) ? particle.controlX : (particle.tailX + particle.x) * 0.5,
    Number.isFinite(particle.controlY) ? particle.controlY : (particle.tailY + particle.y) * 0.5,
    particle.x,
    particle.y,
    18,
  );
  graphic.stroke({
    color,
    alpha: Math.min(0.78, alpha),
    width,
    cap: 'round',
    join: 'round',
  });
}

export async function createPixiLightParticleLayer({ host, width = 1, height = 1, dpr = 1, maxParticles = 220 } = {}) {
  if (!host) throw new Error('Pixi light layer requires a host element');

  const app = new PIXI.Application();
  await app.init({
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
    resolution: Math.max(1, Math.min(2, Number(dpr) || 1)),
    autoDensity: true,
    antialias: true,
    backgroundAlpha: 0,
    preference: 'webgl',
  });
  app.ticker.stop();
  setFxCanvasStyle(app.canvas);
  host.appendChild(app.canvas);

  const mask = new PIXI.Graphics();
  const glowContainer = new PIXI.Container();
  const streakContainer = new PIXI.Container();
  glowContainer.blendMode = 'add';
  streakContainer.blendMode = 'add';
  glowContainer.filters = [new PIXI.BlurFilter({ strength: 2.2, quality: 4 })];
  glowContainer.mask = mask;
  streakContainer.mask = mask;
  app.stage.addChild(mask, glowContainer, streakContainer);

  const count = Math.max(16, Math.min(900, Math.round(Number(maxParticles) || 520)));
  const softStreaks = [];
  const streaks = [];
  for (let index = 0; index < count; index += 1) {
    const softStreak = new PIXI.Graphics();
    const streak = new PIXI.Graphics();
    softStreak.visible = false;
    streak.visible = false;
    softStreaks.push(softStreak);
    streaks.push(streak);
    glowContainer.addChild(softStreak);
    streakContainer.addChild(streak);
  }

  function resize(next = {}) {
    const nextWidth = Math.max(1, Math.round(Number(next.width ?? width) || 1));
    const nextHeight = Math.max(1, Math.round(Number(next.height ?? height) || 1));
    const nextDpr = Math.max(1, Math.min(2, Number(next.dpr ?? dpr) || 1));
    app.renderer.resolution = nextDpr;
    app.renderer.resize(nextWidth, nextHeight);
    app.canvas.style.width = `${nextWidth}px`;
    app.canvas.style.height = `${nextHeight}px`;
  }

  function render({ particles = [], arena = null, power = 0 } = {}) {
    const safePower = clamp(power, 0, 1.15);
    mask.clear();
    if (arena?.radius > 0) {
      mask.circle(arena.cx, arena.cy, Math.max(1, arena.radius - 1));
      mask.fill({ color: 0xffffff, alpha: 1 });
    } else {
      mask.rect(0, 0, app.renderer.width, app.renderer.height);
      mask.fill({ color: 0xffffff, alpha: 1 });
    }

    const visible = particles.filter((particle) => Number(particle?.alpha || 0) > 0.006).slice(0, count);
    for (let index = 0; index < count; index += 1) {
      const particle = visible[index];
      if (!particle) {
        softStreaks[index].visible = false;
        streaks[index].visible = false;
        continue;
      }
      const color = colorToHex(particle.color);
      drawLightStreak(softStreaks[index], particle, color, safePower, { soft: true });
      drawLightStreak(streaks[index], particle, color, safePower);
    }
    app.renderer.render(app.stage);
    return visible.length;
  }

  function clear() {
    for (const graphic of softStreaks) graphic.visible = false;
    for (const graphic of streaks) graphic.visible = false;
    app.renderer.render(app.stage);
  }

  function destroy() {
    app.destroy(true, { children: true, texture: true });
  }

  resize({ width, height, dpr });
  return {
    kind: 'pixi-light-layer',
    app,
    ready: true,
    resize,
    render,
    clear,
    destroy,
    maxParticles: count,
  };
}

export const PixiLightLayerLibrary = {
  name: 'PixiJS',
  version: PIXI.VERSION,
  blendMode: 'additive',
  renderer: 'webgl',
};
