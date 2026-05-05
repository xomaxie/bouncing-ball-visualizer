import { clamp } from './music.js';

const DEFAULT_WINDOW_SECONDS = 1.45;
const DEFAULT_HOP_SECONDS = 0.25;
const DEFAULT_THRESHOLD = 0.52;

function levelForEnergy(energy) {
  if (energy >= 0.68) return 'high';
  if (energy >= 0.38) return 'medium';
  return 'low';
}

function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value >= edge1 ? 1 : 0;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function percentile(values, unit) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const index = clamp(unit, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const mix = index - lower;
  return sorted[lower] * (1 - mix) + sorted[upper] * mix;
}

function flattenNotes(tracks = []) {
  return tracks.flatMap((track) => (track.notes || []).map((note) => ({
    time: Number(note.time) || 0,
    duration: Math.max(0.04, Number(note.duration) || 0.12),
    velocity: clamp(Number(note.velocity ?? 0.72), 0.02, 1.15),
    midi: Number(note.midi) || 60,
  }))).sort((a, b) => a.time - b.time || a.midi - b.midi);
}

function noteWeightAtTime(note, time, halfWindow) {
  const noteCenter = note.time + Math.min(note.duration, halfWindow) * 0.45;
  const distance = Math.abs(noteCenter - time);
  if (distance > halfWindow) return 0;
  const proximity = 1 - (distance / Math.max(halfWindow, 1e-6));
  const envelope = proximity * proximity * (3 - 2 * proximity);
  const durationBoost = 0.78 + Math.min(note.duration, 0.55) * 0.75;
  return Math.pow(note.velocity, 1.28) * durationBoost * envelope;
}

export function createEnergyProfile(tracks = [], options = {}) {
  const notes = flattenNotes(tracks);
  const windowSeconds = Math.max(0.35, Number(options.windowSeconds) || DEFAULT_WINDOW_SECONDS);
  const hopSeconds = Math.max(0.05, Number(options.hopSeconds) || DEFAULT_HOP_SECONDS);
  const threshold = clamp(Number(options.threshold ?? DEFAULT_THRESHOLD), 0.05, 0.95);
  const halfWindow = windowSeconds / 2;
  const duration = Math.max(0, ...notes.map((note) => note.time + note.duration));

  if (!notes.length || duration <= 0) {
    return { samples: [], duration: 0, windowSeconds, hopSeconds, threshold };
  }

  const rawSamples = [];
  for (let time = 0; time <= duration + hopSeconds + 1e-9; time += hopSeconds) {
    let raw = 0;
    let active = 0;
    for (const note of notes) {
      if (note.time > time + halfWindow) break;
      const weight = noteWeightAtTime(note, time, halfWindow);
      if (weight <= 0) continue;
      raw += weight;
      active += 1;
    }
    rawSamples.push({
      time: Number(time.toFixed(6)),
      raw: raw * (1 + Math.min(1.8, active / 18) * 0.32),
    });
  }

  const smoothed = rawSamples.map((sample, index) => {
    const previous = rawSamples[Math.max(0, index - 1)].raw;
    const next = rawSamples[Math.min(rawSamples.length - 1, index + 1)].raw;
    return sample.raw * 0.58 + previous * 0.21 + next * 0.21;
  });
  const p90 = percentile(smoothed, 0.90);
  const max = Math.max(...smoothed, 1e-9);
  const normalizer = Math.max(1e-9, Math.min(max, Math.max(p90 * 1.06, max * 0.42)));

  const samples = rawSamples.map((sample, index) => {
    const energy = clamp(smoothed[index] / normalizer, 0, 1);
    const intensity = smoothstep(threshold, 1, energy);
    return {
      time: sample.time,
      raw: sample.raw,
      energy,
      intensity,
      level: levelForEnergy(energy),
    };
  });

  return {
    samples,
    duration,
    windowSeconds,
    hopSeconds,
    threshold,
    peakRaw: max,
  };
}

export function energyAtTime(profile, time = 0) {
  const samples = profile?.samples || [];
  if (!samples.length) {
    return { time: Number(time) || 0, energy: 0, intensity: 0, level: 'low', raw: 0 };
  }

  const currentTime = Number(time) || 0;
  if (currentTime <= samples[0].time) return { ...samples[0] };
  const last = samples[samples.length - 1];
  if (currentTime >= last.time) return { ...last };

  let low = 0;
  let high = samples.length - 1;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (samples[mid].time <= currentTime) low = mid;
    else high = mid;
  }

  const a = samples[low];
  const b = samples[high];
  const mix = clamp((currentTime - a.time) / Math.max(1e-9, b.time - a.time), 0, 1);
  const energy = a.energy * (1 - mix) + b.energy * mix;
  const raw = a.raw * (1 - mix) + b.raw * mix;
  const threshold = profile.threshold ?? DEFAULT_THRESHOLD;
  const intensity = smoothstep(threshold, 1, energy);
  return {
    time: currentTime,
    raw,
    energy,
    intensity,
    level: levelForEnergy(energy),
  };
}

export function sceneModeForEnergy(energyState = {}) {
  const energy = clamp(Number(energyState.energy) || 0, 0, 1);
  const intensity = clamp(Number(energyState.intensity) || smoothstep(0.52, 1, energy), 0, 1);
  const level = energyState.level || levelForEnergy(energy);

  if (level === 'high' || energy >= 0.68) {
    return {
      name: 'surge',
      label: 'surge',
      energy,
      intensity,
      lightMultiplier: 1.10 + intensity * 0.22,
      particleMultiplier: 1.22 + intensity * 0.35,
      impactMultiplier: 1.12 + intensity * 0.28,
      wallRippleMultiplier: 1.18 + intensity * 0.42,
      ballPulse: 0.08 + intensity * 0.10,
    };
  }

  if (level === 'medium' || energy >= 0.38) {
    return {
      name: 'drive',
      label: 'drive',
      energy,
      intensity,
      lightMultiplier: 0.96 + energy * 0.26,
      particleMultiplier: 0.96 + energy * 0.28,
      impactMultiplier: 0.94 + energy * 0.22,
      wallRippleMultiplier: 0.98 + energy * 0.30,
      ballPulse: 0.035 + energy * 0.055,
    };
  }

  return {
    name: 'calm',
    label: 'calm',
    energy,
    intensity,
    lightMultiplier: 0.72 + energy * 0.32,
    particleMultiplier: 0.66 + energy * 0.26,
    impactMultiplier: 0.72 + energy * 0.20,
    wallRippleMultiplier: 0.68 + energy * 0.22,
    ballPulse: 0.015 + energy * 0.035,
  };
}

export function sceneModeAtTime(profile, time = 0) {
  return sceneModeForEnergy(energyAtTime(profile, time));
}

export function dynamicSolverOptionsForEnergy(baseOptions = {}, energyState = {}) {
  const base = { ...baseOptions };
  const threshold = clamp(Number(base.energyThreshold ?? energyState.threshold ?? DEFAULT_THRESHOLD), 0.05, 0.95);
  const energy = clamp(Number(energyState.energy) || 0, 0, 1);
  const intensity = energy <= threshold
    ? 0
    : clamp(Number(energyState.intensity), 0, 1) || smoothstep(threshold, 1, energy);

  if (intensity <= 0) {
    return {
      ...base,
      energy,
      energyIntensity: 0,
      energyLevel: levelForEnergy(energy),
    };
  }

  const minFlightTime = Number(base.minFlightTime ?? 0.28);
  const preferredFlightTime = Number(base.preferredFlightTime ?? 0.82);
  const recoveryTime = Number(base.recoveryTime ?? 0.06);
  const spawnPreferred = Number(base.spawnPreferredFlightTime ?? 0.32);
  const spawnMax = Number(base.spawnMaxFlightTime ?? 0.42);

  const nextMinFlightTime = Math.max(0.15, minFlightTime * (1 - intensity * 0.34));
  const nextSpawnPreferred = Math.max(nextMinFlightTime, spawnPreferred * (1 - intensity * 0.26));

  return {
    ...base,
    gravityY: Number(base.gravityY ?? 160) * (1 + intensity * 0.72),
    maxSpeed: Number(base.maxSpeed ?? 1550) * (1 + intensity * 0.34),
    minFlightTime: nextMinFlightTime,
    preferredFlightTime: Math.max(nextMinFlightTime, preferredFlightTime * (1 - intensity * 0.23)),
    recoveryTime: Math.max(0.018, recoveryTime * (1 - intensity * 0.46)),
    spawnPreferredFlightTime: nextSpawnPreferred,
    spawnMaxFlightTime: Math.max(nextSpawnPreferred, spawnMax * (1 - intensity * 0.18)),
    energy,
    energyIntensity: intensity,
    energyLevel: levelForEnergy(energy),
  };
}
