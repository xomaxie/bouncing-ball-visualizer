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

function energyIntensity(energy = {}) {
  const rawIntensity = Number(energy?.intensity);
  if (Number.isFinite(rawIntensity)) return clamp(rawIntensity, 0, 1);
  return clamp(Number(energy?.energy ?? 0), 0, 1);
}

function energyPulse(energy = {}) {
  return clamp(Number(energy?.pulse ?? energy?.blackHolePulse ?? energy?.burst ?? 0), 0, 1.15);
}

function displayPowerForEnergy(energy = {}) {
  const intensity = energyIntensity(energy);
  const energyLevel = clamp(Number(energy?.energy ?? intensity), 0, 1);
  const pulse = energyPulse(energy);
  const sectionLift = clamp((energyLevel - 0.24) * 0.78, 0, 1);
  const basePower = Math.max(intensity, sectionLift);
  const pulseBoost = pulse * (0.50 + Math.max(0, 1 - basePower) * 0.38);
  return clamp(Math.max(pulse, basePower + pulseBoost), 0, 1.15);
}

function softParticleVisibility(index, count, visibleFraction, feather = 0.12) {
  const safeCount = Math.max(1, count);
  const rank = (index + 0.5) / safeCount;
  const safeFeather = Math.max(0.025, Number(feather) || 0.12);
  return clamp((Number(visibleFraction || 0) - rank + safeFeather) / safeFeather, 0, 1);
}

function resetParticle(particle, system, rng) {
  const inner = system.innerRadius;
  const outer = system.outerRadius;
  const band = rng();
  particle.orbitRadius = inner + Math.pow(band, 0.48) * (outer - inner);
  particle.angle = (particle.angle || 0) + Math.PI * (0.35 + rng() * 0.9);
  particle.alpha = 0.22 + rng() * 0.56;
  particle.size = 0.22 + rng() * 0.68;
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
  const particleCount = Math.max(8, Math.min(1400, Math.round(Number(count) || 96)));
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
  const power = displayPowerForEnergy(energy);
  const angularBoost = 0.88 + power * 1.48;
  const pullBoost = 0.92 + power * 0.82;
  const innerLimit = system.innerRadius;
  const steps = Math.max(1, Math.ceil(safeDt / (1 / 90)));
  const stepDt = safeDt / steps;

  for (let step = 0; step < steps; step += 1) {
    for (const particle of system.particles) {
      particle.angle += particle.angularVelocity * stepDt * angularBoost * (1 + system.radius / Math.max(system.radius, particle.orbitRadius));
      particle.orbitRadius -= particle.inwardSpeed * stepDt * pullBoost;
      particle.wobble += stepDt * (0.8 + Math.abs(particle.angularVelocity) * 0.55);
      if (particle.orbitRadius < innerLimit || !Number.isFinite(particle.orbitRadius)) {
        resetParticle(particle, system, system.rng);
        particle.orbitRadius = Math.max(innerLimit, particle.orbitRadius);
      }
    }
  }
  return system;
}

export function blackHoleParticleSnapshots(system, blackHole = {}, energy = {}) {
  if (!system?.particles?.length) return [];
  const cx = Number(blackHole.x || 0);
  const cy = Number(blackHole.y || 0);
  const baseIntensity = energyIntensity(energy);
  const energyLevel = clamp(Number(energy?.energy ?? baseIntensity), 0, 1);
  const pulse = energyPulse(energy);
  const displayPower = displayPowerForEnergy(energy);
  const visibleFraction = clamp(0.28 + displayPower * 0.72, 0.24, 1);
  const radiusScale = 0.68 + energyLevel * 0.05 + displayPower * 0.92 + pulse * 0.18;
  const alphaScale = 0.38 + displayPower * 0.82 + pulse * 0.26;
  const particleSizeScale = 0.42 + displayPower * 0.30 + pulse * 0.10;
  const tailScale = 0.24 + displayPower * 0.30 + pulse * 0.10;
  const visibleCount = Math.max(8, Math.min(system.particles.length, Math.round(system.particles.length * visibleFraction)));
  const rotation = -0.22;
  const cosR = Math.cos(rotation);
  const sinR = Math.sin(rotation);

  return system.particles.map((particle, index) => {
    const visibility = softParticleVisibility(index, system.particles.length, visibleCount / Math.max(1, system.particles.length), 0.13);
    const radius = Math.max(system.innerRadius, Number(particle.orbitRadius || system.innerRadius)) * radiusScale;
    const angle = Number(particle.angle || 0);
    const wobble = Math.sin((particle.wobble || 0) + angle * 2.4) * system.radius * 0.22;
    const localX = Math.cos(angle) * radius + Math.cos(angle * 2.1) * wobble;
    const localY = Math.sin(angle) * radius * Number(particle.tilt || 0.42) + Math.sin(angle * 1.7) * wobble * 0.35;
    const tangentAngle = angle + Math.PI / 2;
    const tailLength = (1.05 + particle.size * 1.65) * (1 + system.radius / Math.max(system.radius * 2, radius)) * tailScale;
    const rotatedX = localX * cosR - localY * sinR;
    const rotatedY = localX * sinR + localY * cosR;
    const tx = Math.cos(tangentAngle) * tailLength;
    const ty = Math.sin(tangentAngle) * tailLength * Number(particle.tilt || 0.42);
    const rotatedTailX = tx * cosR - ty * sinR;
    const rotatedTailY = tx * sinR + ty * cosR;
    const x = cx + rotatedX;
    const y = cy + rotatedY;
    const tailX = cx + rotatedX - rotatedTailX;
    const tailY = cy + rotatedY - rotatedTailY;
    const chordX = x - tailX;
    const chordY = y - tailY;
    const chordLength = Math.max(0.001, Math.hypot(chordX, chordY));
    const normalX = -chordY / chordLength;
    const normalY = chordX / chordLength;
    const swirl = Math.sign(Number(particle.angularVelocity || 1)) || 1;
    const bend = Math.min(4.2, Math.max(0.42, tailLength * (0.22 + displayPower * 0.16))) * swirl;
    const controlX = tailX + chordX * 0.58 + normalX * bend;
    const controlY = tailY + chordY * 0.58 + normalY * bend;

    return {
      id: particle.id,
      x,
      y,
      tailX,
      tailY,
      controlX,
      controlY,
      radius,
      size: particle.size * particleSizeScale,
      spriteRadius: 0,
      renderMode: 'micro-streak',
      alpha: clamp(particle.alpha * alphaScale * visibility * (1.16 - Math.min(0.58, radius / (system.outerRadius * radiusScale))), 0, 1),
      visibility,
      color: particle.color,
    };
  });
}

export function blackHoleLightParticleSnapshots(system, blackHole = {}, energy = {}, colorState = {}) {
  if (!system?.particles?.length) return [];
  const dominantColor = String(colorState?.color || '').trim() || '#bd82ff';
  const dominantEnergy = clamp(Number(colorState?.colorEnergy ?? 0), 0, 1.15);
  const displayPower = displayPowerForEnergy(energy);
  const pulse = energyPulse(energy);
  const energyLevel = clamp(Number(energy?.energy ?? displayPower), 0, 1);
  const emissionPower = clamp(displayPower * 0.72 + dominantEnergy * 0.36 + pulse * 0.20, 0, 1.15);
  const visibleFraction = clamp(0.055 + emissionPower * 0.74, 0, 0.94);
  const visibleCount = Math.max(0, Math.min(system.particles.length, Math.round(system.particles.length * visibleFraction)));

  const cx = Number(blackHole.x || 0);
  const cy = Number(blackHole.y || 0);
  const rotation = -0.22;
  const cosR = Math.cos(rotation);
  const sinR = Math.sin(rotation);
  const discScale = 0.82 + energyLevel * 0.16 + emissionPower * 0.50 + pulse * 0.14;
  const alphaScale = 0.080 + emissionPower * 0.30 + dominantEnergy * 0.10;
  const streakScale = 0.38 + emissionPower * 0.22 + dominantEnergy * 0.10;

  return system.particles.map((particle, index) => {
    const visibility = softParticleVisibility(index, system.particles.length, visibleCount / Math.max(1, system.particles.length), 0.11);
    const unit = index / Math.max(1, system.particles.length - 1);
    const angle = Number(particle.angle || 0) + Math.sin((particle.wobble || 0) * 0.8) * 0.05;
    const baseRadius = Math.max(system.innerRadius * 1.42, Number(particle.orbitRadius || system.innerRadius)) * discScale;
    const wobble = Math.sin((particle.wobble || 0) + angle * 1.7) * system.radius * 0.18;
    const localX = Math.cos(angle) * baseRadius + Math.cos(angle * 1.5) * wobble;
    const localY = Math.sin(angle) * baseRadius * Number(particle.tilt || 0.42) + Math.sin(angle * 2.3) * wobble * 0.25;
    const x = cx + localX * cosR - localY * sinR;
    const y = cy + localX * sinR + localY * cosR;

    const radialLength = (0.42 + particle.size * 0.34 + unit * 0.54) * streakScale;
    const radialX = Math.cos(angle) * radialLength;
    const radialY = Math.sin(angle) * radialLength * Number(particle.tilt || 0.42);
    const tangentX = Math.cos(angle + Math.PI / 2) * radialLength * (0.10 + emissionPower * 0.055);
    const tangentY = Math.sin(angle + Math.PI / 2) * radialLength * Number(particle.tilt || 0.42) * (0.10 + emissionPower * 0.055);
    const tailLocalX = localX - radialX * 0.38 - tangentX * 0.16;
    const tailLocalY = localY - radialY * 0.38 - tangentY * 0.16;
    const tailX = cx + tailLocalX * cosR - tailLocalY * sinR;
    const tailY = cy + tailLocalX * sinR + tailLocalY * cosR;
    const controlLocalX = (localX + tailLocalX) * 0.5 + tangentX * 0.42;
    const controlLocalY = (localY + tailLocalY) * 0.5 + tangentY * 0.42;
    const controlX = cx + controlLocalX * cosR - controlLocalY * sinR;
    const controlY = cy + controlLocalX * sinR + controlLocalY * cosR;
    const baseAlpha = Number(particle.alpha || 0.45) * alphaScale * visibility * (0.62 + unit * 0.32);

    return {
      id: particle.id,
      x,
      y,
      tailX,
      tailY,
      controlX,
      controlY,
      radius: baseRadius,
      glowRadius: (0.38 + particle.size * 0.22 + unit * 0.34) * (0.62 + emissionPower * 0.56),
      pointRadius: (0.16 + particle.size * 0.12 + unit * 0.16) * (0.78 + emissionPower * 0.18),
      lineWidth: (0.038 + particle.size * 0.032) * (0.78 + emissionPower * 0.20),
      alpha: clamp(baseAlpha, 0, 0.58),
      visibility,
      color: dominantColor,
      spriteRadius: 0,
      renderMode: 'photon-dust',
    };
  });
}
