import { clamp } from './music.js';

const DEFAULT_MIN_MIDI = 36;
const DEFAULT_MAX_MIDI = 84;

export function midiToFrequencyBin(midi, bandCount, { minMidi = DEFAULT_MIN_MIDI, maxMidi = DEFAULT_MAX_MIDI } = {}) {
  const count = Math.max(1, Math.floor(bandCount || 1));
  const unit = clamp((Number(midi) - minMidi) / Math.max(1, maxMidi - minMidi), 0, 1);
  return Math.max(0, Math.min(count - 1, Math.round(unit * (count - 1))));
}

export function createVisualEffectsState({ bandCount = 56 } = {}) {
  const count = Math.max(1, Math.floor(bandCount));
  return {
    frequencyBands: Array.from({ length: count }, () => 0),
    impactFrames: [],
    particles: [],
    screenImpact: 0,
    blackHolePulse: 0,
    dominantNoteColor: null,
    dominantNoteEnergy: 0,
  };
}

function impactParticleAngle(midi, index, count) {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const seed = (Number(midi) || 60) * 0.173;
  return seed + index * golden + (index / Math.max(1, count)) * Math.PI * 0.35;
}

function createImpactParticles({ midi, velocity, x, y, color, energy, sceneMode, personality }) {
  const particleMultiplier = Math.max(
    0.2,
    Number(sceneMode?.particleMultiplier ?? 1) * Number(personality?.sparkMultiplier ?? 1),
  );
  const radiusScale = Math.max(0.35, Number(personality?.impactRadiusScale ?? 1));
  const count = Math.max(4, Math.min(72, Math.round((6 + energy * 12 + Number(velocity || 0) * 14) * particleMultiplier)));
  const amplitude = clamp(Number(velocity || 0.7), 0.05, 1.15);
  const particles = [];

  for (let index = 0; index < count; index += 1) {
    const angle = impactParticleAngle(midi, index, count);
    const unit = index / Math.max(1, count - 1);
    const burstStyle = personality?.name === 'drums' ? 1.18 : personality?.name === 'bass' ? 0.82 : 1;
    const burst = (72 + amplitude * 174 + energy * 54 + Math.sin(index * 1.91 + Number(midi || 0)) * 18) * burstStyle;
    const tangential = (unit - 0.5) * 48 * energy * Math.max(0.75, particleMultiplier);
    const radius = (0.62 + amplitude * 2.85 + (index % 4) * 0.18) * radiusScale;
    const lengthStyle = personality?.name === 'treble' ? 1.22 : personality?.name === 'bass' ? 0.72 : 1;
    const length = (5.5 + amplitude * 24 + energy * 11 + unit * 8) * lengthStyle * Math.min(1.38, Math.max(0.72, particleMultiplier));

    particles.push({
      x,
      y,
      vx: Math.cos(angle) * burst - Math.sin(angle) * tangential,
      vy: Math.sin(angle) * burst + Math.cos(angle) * tangential,
      radius,
      length,
      color,
      style: personality?.name || 'default',
      life: 1,
      age: 0,
      decay: 1.35 + unit * 0.75 + amplitude * 0.15,
    });
  }

  return particles;
}

export function registerNoteImpact(effects, impact = {}) {
  if (!effects?.frequencyBands?.length) return effects;

  const { midi = 60, velocity = 0.7, x = 0, y = 0, color = '#fff' } = impact;
  const energy = clamp(0.28 + Number(velocity || 0.7) * 0.72, 0.18, 1.15);
  const sceneMode = impact.sceneMode || null;
  const personality = impact.personality || null;
  const impactMultiplier = Math.max(
    0.2,
    Number(sceneMode?.impactMultiplier ?? 1) * Number(personality?.impactRadiusScale ?? 1),
  );
  const bin = midiToFrequencyBin(midi, effects.frequencyBands.length);
  const spread = [
    [bin, energy],
    [bin - 1, energy * 0.38],
    [bin + 1, energy * 0.38],
    [bin - 2, energy * 0.14],
    [bin + 2, energy * 0.14],
  ];

  for (const [index, amount] of spread) {
    if (index < 0 || index >= effects.frequencyBands.length) continue;
    effects.frequencyBands[index] = clamp(effects.frequencyBands[index] + amount, 0, 1.35);
  }

  effects.impactFrames.push({
    x,
    y,
    color,
    midi,
    life: 1,
    age: 0,
    energy,
    sceneMode: sceneMode?.name || 'default',
    personality: personality?.name || 'default',
    burstRadius: (24 + Number(velocity || 0.7) * 74 + energy * 18) * impactMultiplier,
  });
  effects.impactFrames = effects.impactFrames.slice(-96);
  effects.particles.push(...createImpactParticles({ midi, velocity, x, y, color, energy, sceneMode, personality }));
  effects.particles = effects.particles.slice(-420);
  effects.screenImpact = clamp(effects.screenImpact + energy * 0.18 * impactMultiplier, 0, 0.52);
  const amplitude = clamp(Number(velocity || 0.7), 0.05, 1.15);
  const pulse = energy * (0.24 + amplitude * 0.42) * Math.sqrt(impactMultiplier);
  effects.blackHolePulse = clamp(Math.max(Number(effects.blackHolePulse || 0), pulse) + pulse * 0.22, 0, 1.15);

  const dominantEnergy = clamp(energy * Math.sqrt(impactMultiplier) * (0.84 + amplitude * 0.32), 0.12, 1.15);
  const currentDominantEnergy = Number(effects.dominantNoteEnergy || 0);
  if (!effects.dominantNoteColor || dominantEnergy >= currentDominantEnergy * 0.78) {
    effects.dominantNoteColor = color;
  }
  effects.dominantNoteEnergy = clamp(Math.max(currentDominantEnergy * 0.72, dominantEnergy), 0, 1.15);
  return effects;
}

export function decayVisualEffects(effects, dt) {
  if (!effects) return effects;
  const safeDt = Math.max(0, Number(dt) || 0);
  const bandDecay = Math.exp(-safeDt * 7.8);
  effects.frequencyBands = (effects.frequencyBands || []).map((value) => {
    const next = value * bandDecay;
    return next < 0.002 ? 0 : next;
  });

  for (const frame of effects.impactFrames || []) {
    frame.age += safeDt;
    frame.life = Math.max(0, frame.life - safeDt * 4.8);
  }
  effects.impactFrames = (effects.impactFrames || []).filter((frame) => frame.life > 0);
  for (const particle of effects.particles || []) {
    const damping = Math.exp(-safeDt * 2.1);
    particle.age += safeDt;
    particle.x += particle.vx * safeDt;
    particle.y += particle.vy * safeDt;
    particle.vx *= damping;
    particle.vy = particle.vy * damping + safeDt * 42;
    particle.life = Math.max(0, particle.life - safeDt * (particle.decay || 3.2));
  }
  effects.particles = (effects.particles || []).filter((particle) => particle.life > 0);
  effects.screenImpact = Math.max(0, effects.screenImpact - safeDt * 5.6);
  if (effects.screenImpact < 0.002) effects.screenImpact = 0;
  effects.blackHolePulse = Math.max(0, Number(effects.blackHolePulse || 0) * Math.exp(-safeDt * 3.35) - safeDt * 0.018);
  if (effects.blackHolePulse < 0.002) effects.blackHolePulse = 0;

  effects.dominantNoteEnergy = Math.max(
    0,
    Number(effects.dominantNoteEnergy || 0) * Math.exp(-safeDt * 2.55) - safeDt * 0.012,
  );
  if (effects.dominantNoteEnergy < 0.012) {
    effects.dominantNoteEnergy = 0;
    effects.dominantNoteColor = null;
  }
  return effects;
}
