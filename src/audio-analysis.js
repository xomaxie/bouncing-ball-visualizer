import { clamp, midiInstrumentName, trackColor } from './music.js';

const DEFAULT_AUDIO_ANALYSIS_OPTIONS = {
  frameSize: 2048,
  hopSize: 512,
  minSpacingSeconds: 0.06,
  sustainSpacingSeconds: 0.12,
  maxEvents: 1800,
  maxPitchesPerFrame: 3,
  minBandPowerRatio: 0.16,
  minEventVelocity: 0.14,
  minMidi: 36,
  maxMidi: 96,
};

function midiForFrequency(frequency) {
  return 69 + 12 * Math.log2(Math.max(1, frequency) / 440);
}

function frequencyForMidiLocal(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function nextPowerOfTwoFloor(value) {
  let power = 1;
  while (power * 2 <= value) power *= 2;
  return power;
}

function safeFrameSize(length, requested) {
  if (length <= 0) return requested;
  return Math.max(128, Math.min(requested, nextPowerOfTwoFloor(length)));
}

export function mixAudioBufferToMono(audioBuffer) {
  const channels = Math.max(1, audioBuffer.numberOfChannels || 1);
  const length = audioBuffer.length || audioBuffer.getChannelData(0).length;
  const samples = new Float32Array(length);

  for (let channel = 0; channel < channels; channel += 1) {
    const data = audioBuffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) samples[i] += data[i] / channels;
  }

  return {
    samples,
    sampleRate: audioBuffer.sampleRate,
    duration: audioBuffer.duration ?? (length / audioBuffer.sampleRate),
  };
}

function rmsForFrame(samples, start, frameSize) {
  let energy = 0;
  const end = Math.min(samples.length, start + frameSize);
  for (let i = start; i < end; i += 1) energy += samples[i] * samples[i];
  return Math.sqrt(energy / Math.max(1, end - start));
}

function goertzelPower(samples, start, usable, sampleRate, midi, stride) {
  const frequency = frequencyForMidiLocal(midi);
  const normalized = Math.PI * 2 * frequency * stride / sampleRate;
  const coeff = 2 * Math.cos(normalized);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let mean = 0;
  let count = 0;

  for (let offset = 0; offset < usable; offset += stride) {
    mean += samples[start + offset] || 0;
    count += 1;
  }
  mean /= Math.max(1, count);

  for (let offset = 0; offset < usable; offset += stride) {
    const value = (samples[start + offset] || 0) - mean;
    s0 = value + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }

  return Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2);
}

function estimateProminentMidis(samples, start, frameSize, sampleRate, options) {
  const maxFrequency = sampleRate * 0.47;
  const minMidi = Math.max(options.minMidi, Math.ceil(midiForFrequency(45)));
  const maxMidi = Math.min(options.maxMidi, Math.floor(midiForFrequency(maxFrequency)));
  const end = Math.min(samples.length, start + frameSize);
  const usable = Math.max(1, end - start);
  const stride = usable >= 2048 ? 4 : usable >= 1024 ? 2 : 1;
  const bandWinners = [
    { band: 0, midi: minMidi, power: -Infinity },
    { band: 1, midi: minMidi, power: -Infinity },
    { band: 2, midi: minMidi, power: -Infinity },
  ];
  let globalPower = -Infinity;

  for (let midi = minMidi; midi <= maxMidi; midi += 1) {
    const power = goertzelPower(samples, start, usable, sampleRate, midi, stride);
    const band = bandForMidi(midi);
    if (power > bandWinners[band].power) {
      bandWinners[band] = { band, midi, power };
    }
    if (power > globalPower) globalPower = power;
  }

  if (!Number.isFinite(globalPower) || globalPower <= 1e-12) {
    return [{ midi: clamp(minMidi, options.minMidi, options.maxMidi), strength: 1, power: 0, band: 0 }];
  }

  return bandWinners
    .filter((winner) => winner.power >= globalPower * (options.minBandPowerRatio ?? 0.16))
    .sort((a, b) => b.power - a.power)
    .slice(0, Math.max(1, options.maxPitchesPerFrame ?? 3))
    .map((winner) => ({
      ...winner,
      midi: clamp(winner.midi, options.minMidi, options.maxMidi),
      strength: clamp(Math.sqrt(winner.power / globalPower), 0.2, 1),
    }))
    .sort((a, b) => a.band - b.band || a.midi - b.midi);
}

function bandForMidi(midi) {
  if (midi < 52) return 0;
  if (midi < 72) return 1;
  return 2;
}

const MP3_PSEUDO_INSTRUMENTS = [
  { id: 0, label: 'MP3 bass', program: 38 },
  { id: 1, label: 'MP3 mid', program: 81 },
  { id: 2, label: 'MP3 treble', program: 11 },
];

function makeTracks(events) {
  const tracks = MP3_PSEUDO_INSTRUMENTS.map((instrument, index) => {
    const instrumentName = midiInstrumentName(instrument.program, index);
    return {
      id: instrument.id,
      index: instrument.id,
      name: `${instrument.label} · ${instrumentName}`,
      color: trackColor(index),
      channel: index,
      program: instrument.program,
      instrumentName,
      notes: [],
    };
  });

  for (const event of events) {
    const track = tracks[bandForMidi(event.midi)];
    track.notes.push({
      time: event.time,
      duration: event.duration,
      midi: event.midi,
      velocity: event.velocity,
      channel: track.channel,
      program: track.program,
      instrumentName: track.instrumentName,
      isDrum: false,
      source: event.source || 'audio-analysis',
    });
  }

  for (const track of tracks) track.notes.sort((a, b) => a.time - b.time || a.midi - b.midi);
  return tracks.filter((track) => track.notes.length > 0);
}

export function analyzeAudioBufferToSong(audioBuffer, options = {}) {
  const opts = { ...DEFAULT_AUDIO_ANALYSIS_OPTIONS, ...options };
  const mono = mixAudioBufferToMono(audioBuffer);
  const frameSize = safeFrameSize(mono.samples.length, opts.frameSize);
  const hopSize = Math.max(32, Math.min(opts.hopSize, frameSize));
  const energies = [];
  const frameStarts = [];

  for (let start = 0; start < mono.samples.length; start += hopSize) {
    frameStarts.push(start);
    energies.push(rmsForFrame(mono.samples, start, frameSize));
    if (start + frameSize >= mono.samples.length) break;
  }

  const peakEnergy = Math.max(0, ...energies);
  const avgEnergy = energies.reduce((sum, value) => sum + value, 0) / Math.max(1, energies.length);
  const energyThreshold = Math.max(peakEnergy * 0.025, avgEnergy * 0.18, 1e-5);
  const fluxThreshold = Math.max(peakEnergy * 0.012, avgEnergy * 0.08, 1e-5);
  const sustainEnergyThreshold = Math.max(peakEnergy * 0.02, avgEnergy * 0.18, 1e-5);
  const minSpacingFrames = Math.max(1, Math.round((opts.minSpacingSeconds * mono.sampleRate) / hopSize));
  const sustainSpacingFrames = Math.max(1, Math.round(((opts.sustainSpacingSeconds ?? 0.12) * mono.sampleRate) / hopSize));
  const candidates = [];
  let lastOnsetFrame = -Infinity;

  for (let index = 1; index < energies.length; index += 1) {
    const energy = energies[index];
    const previous = energies[index - 1] || 0;
    const previous2 = energies[index - 2] || 0;
    const flux = energy - Math.max(previous * 0.86, previous2 * 0.72);
    if (energy < energyThreshold || flux < fluxThreshold) continue;
    if (index - lastOnsetFrame < minSpacingFrames) {
      const current = candidates.at(-1);
      if (current && energy > current.energy) {
        current.frameIndex = index;
        current.start = frameStarts[index];
        current.energy = energy;
        current.flux = flux;
        current.score = flux + energy * 0.35;
      }
      continue;
    }

    candidates.push({
      kind: 'onset',
      frameIndex: index,
      start: frameStarts[index],
      energy,
      flux,
      score: flux + energy * 0.35,
    });
    lastOnsetFrame = index;
  }

  let lastSustainFrame = -Infinity;
  for (let index = 0; index < energies.length; index += 1) {
    const energy = energies[index];
    if (energy < sustainEnergyThreshold) continue;
    if (index - lastSustainFrame < sustainSpacingFrames) continue;

    const previous = energies[index - 1] || 0;
    const next = energies[index + 1] || 0;
    const localLift = Math.max(0, energy - Math.min(previous, next) * 0.92);
    candidates.push({
      kind: 'sustain',
      frameIndex: index,
      start: frameStarts[index],
      energy,
      flux: localLift,
      score: energy * 0.7 + localLift,
    });
    lastSustainFrame = index;
  }

  const mergedFrames = [];
  for (const candidate of candidates.sort((a, b) => a.frameIndex - b.frameIndex || b.score - a.score)) {
    const current = mergedFrames.at(-1);
    if (current && candidate.frameIndex - current.frameIndex < minSpacingFrames) {
      const candidateWins =
        candidate.score > current.score ||
        (candidate.kind === 'onset' && current.kind !== 'onset' && candidate.score >= current.score * 0.7);
      if (candidateWins) mergedFrames[mergedFrames.length - 1] = candidate;
      continue;
    }
    mergedFrames.push(candidate);
  }

  const expandedEvents = mergedFrames.flatMap((event) => {
    const pitches = estimateProminentMidis(mono.samples, event.start, frameSize, mono.sampleRate, opts);
    const baseVelocity = clamp(event.energy / Math.max(peakEnergy, 1e-9), opts.minEventVelocity, 1);
    return pitches.map((pitch) => ({
      time: event.start / mono.sampleRate,
      duration: clamp((frameSize / mono.sampleRate) * (event.kind === 'sustain' ? 0.68 : 0.42), 0.08, 0.36),
      midi: pitch.midi,
      velocity: clamp(baseVelocity * pitch.strength, opts.minEventVelocity, 1),
      energy: event.energy,
      score: event.score * pitch.strength,
      source: event.kind === 'onset' ? 'audio-transient' : 'audio-sustain',
      band: pitch.band,
    }));
  });

  const events = thinEventsChronologically(expandedEvents, opts.maxEvents)
    .sort((a, b) => a.time - b.time || a.band - b.band || a.midi - b.midi)
    .map(({ score, band, ...event }) => event);

  return {
    format: 'audio-analysis',
    duration: mono.duration,
    sampleRate: mono.sampleRate,
    tracks: makeTracks(events),
    analysis: {
      frameSize,
      hopSize,
      frames: energies.length,
      detectedEvents: events.length,
      candidateFrames: mergedFrames.length,
      peakEnergy,
    },
  };
}

function thinEventsChronologically(events, maxEvents) {
  const sorted = [...events].sort((a, b) => a.time - b.time || b.score - a.score);
  const limit = Math.max(1, maxEvents || sorted.length);
  if (sorted.length <= limit) return sorted;
  if (limit === 1) return [sorted.reduce((best, event) => (event.score > best.score ? event : best), sorted[0])];

  const selected = [];
  const used = new Set();
  for (let i = 0; i < limit; i += 1) {
    const idealIndex = Math.round((i * (sorted.length - 1)) / (limit - 1));
    let bestIndex = idealIndex;
    let bestScore = -Infinity;
    const radius = Math.ceil(sorted.length / limit);
    const from = Math.max(0, idealIndex - radius);
    const to = Math.min(sorted.length - 1, idealIndex + radius);
    for (let candidate = from; candidate <= to; candidate += 1) {
      if (used.has(candidate)) continue;
      const score = sorted[candidate].score ?? 0;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = candidate;
      }
    }
    while (used.has(bestIndex) && bestIndex < sorted.length - 1) bestIndex += 1;
    while (used.has(bestIndex) && bestIndex > 0) bestIndex -= 1;
    if (used.has(bestIndex)) continue;
    used.add(bestIndex);
    selected.push(sorted[bestIndex]);
  }
  return selected;
}
