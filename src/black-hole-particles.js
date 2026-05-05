import { clamp } from './music.js';

const TAU = Math.PI * 2;

function hashString(value = '') {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function blackHoleSeed(blackHole = {}, seed = '') {
  return hashString([
    seed,
    Number(blackHole.x || 0).toFixed(2),
    Number(blackHole.y || 0).toFixed(2),
    Number(blackHole.radius || 0).toFixed(2),
    Number(blackHole.eventHorizonRadius || 0).toFixed(2),
  ].join(':'));
}

function particleColor(unit) {
  if (unit < 0.26) return '#77a7ff';
  if (unit < 0.56) return '#bd82ff';
  if (unit < 0.82) return '#fff1c2';
  return '#ff8f5c';
}

function resetParticle(particle, system, rng) {
  const inner = system.innerRadius;
  const outer = system.outerRadius;
  const band = rng();
  particle.orbitRadius = inner + Math.pow(band, 0.48) * (outer - inner);
  particle.angle = (particle.angle || 0) + Math.PI * (0.35 + rng() * 0.9);
  particle.alpha = 0.22 + rng() * 0.56;
  particle.size = 0.55 + rng() * 1.45;
  particle.temperature = rng();
  particle.color = particleColor(particle.temperature);
  particle.inwardSpeed = (3.2 + rng() * 9.5) * Math.max(0.7, system.radius / 13);
  particle.angularVelocity = (0.46 + rng() * 1.35) * (rng() < 0.5 ? -1 : 1) * Math.sqrt(system.radius / Math.max(1, particle.orbitRadius));
  particle.wobble = rng() * TAU;
  particle.tilt = 0.36 + rng() * 0.18;
  particle.spin = -0.24 + (rng() - 0.5) * 0.18;
  return particle;
}

export function createBlackHoleParticleSystem(blackHole = {}, { count = 96, seed = 'black-hole' } = {}) {
  const radius = Math.max(4, Number(blackHole.radius || 10));
  const horizon = Math.max(radius * 0.95, Number(blackHole.eventHorizonRadius || radius));
  const particleCount = Math.max(8, Math.min(220, Math.round(Number(count) || 96)));
  const rng = mulberry32(blackHoleSeed(blackHole, seed));
  const system = {
    radius,
    horizonRadius: horizon,
    innerRadius: horizon * 1.16,
    outerRadius: radius * 6.1,
    particles: [],
    rng,
  };

  for (let index = 0; index < particleCount; index += 1) {
    const particle = {
      id: index,
      angle: rng() * TAU,
      orbitRadius: system.innerRadius,
      angularVelocity: 0,
      inwardSpeed: 0,
      alpha: 1,
      size: 1,
      temperature: 0,
      color: '#77a7ff',
      wobble: rng() * TAU,
      tilt: 0.42,
      spin: -0.24,
    };
    resetParticle(particle, system, rng);
    system.particles.push(particle);
  }

  return system;
}

export function advanceBlackHoleParticles(system, dt = 0, energy = {}) {
  if (!system?.particles?.length) return system;
  const safeDt = Math.max(0, Math.min(0.08, Number(dt) || 0));
  const intensity = clamp(Number(energy?.intensity ?? energy?.energy ?? 0), 0, 1.25);
  const angularBoost = 1.0 + intensity * 0.72;
  const pullBoost = 1.0 + intensity * 0.38;
  const innerLimit = system.innerRadius;

  for (const particle of system.particles) {
    particle.angle += particle.angularVelocity * safeDt * angularBoost * (1 + system.radius / Math.max(system.radius, particle.orbitRadius));
    particle.orbitRadius -= particle.inwardSpeed * safeDt * pullBoost;
    particle.wobble += safeDt * (0.8 + Math.abs(particle.angularVelocity) * 0.55);
    if (particle.orbitRadius < innerLimit || !Number.isFinite(particle.orbitRadius)) {
      resetParticle(particle, system, system.rng);
      particle.orbitRadius = Math.max(innerLimit, particle.orbitRadius);
    }
  }
  return system;
}

export function blackHoleParticleSnapshots(system, blackHole = {}) {
  if (!system?.particles?.length) return [];
  const cx = Number(blackHole.x || 0);
  const cy = Number(blackHole.y || 0);
  const rotation = -0.22;
  const cosR = Math.cos(rotation);
  const sinR = Math.sin(rotation);

  return system.particles.map((particle) => {
    const radius = Math.max(system.innerRadius, Number(particle.orbitRadius || system.innerRadius));
    const angle = Number(particle.angle || 0);
    const wobble = Math.sin((particle.wobble || 0) + angle * 2.4) * system.radius * 0.22;
    const localX = Math.cos(angle) * radius + Math.cos(angle * 2.1) * wobble;
    const localY = Math.sin(angle) * radius * Number(particle.tilt || 0.42) + Math.sin(angle * 1.7) * wobble * 0.35;
    const tangentAngle = angle + Math.PI / 2;
    const tailLength = (5.5 + particle.size * 4.2) * (1 + system.radius / Math.max(system.radius * 2, radius));
    const rotatedX = localX * cosR - localY * sinR;
    const rotatedY = localX * sinR + localY * cosR;
    const tx = Math.cos(tangentAngle) * tailLength;
    const ty = Math.sin(tangentAngle) * tailLength * Number(particle.tilt || 0.42);
    const rotatedTailX = tx * cosR - ty * sinR;
    const rotatedTailY = tx * sinR + ty * cosR;

    return {
      id: particle.id,
      x: cx + rotatedX,
      y: cy + rotatedY,
      tailX: cx + rotatedX - rotatedTailX,
      tailY: cy + rotatedY - rotatedTailY,
      radius,
      size: particle.size,
      alpha: clamp(particle.alpha * (1.16 - Math.min(0.58, radius / system.outerRadius)), 0.04, 1),
      color: particle.color,
    };
  });
}
