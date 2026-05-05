import { frequencyForMidi } from './music.js';

export function soundButtonLabel(enabled) {
  return enabled ? 'audio on' : 'audio muted';
}

export function instrumentVoiceForNote(noteOrMidi, velocity = 0.7) {
  const note = typeof noteOrMidi === 'number' ? { midi: noteOrMidi, velocity } : (noteOrMidi || {});
  const program = Math.max(0, Math.min(127, Math.round(note.program ?? 0)));
  const channel = note.channel ?? 0;
  const midi = note.midi ?? 60;

  if (note.isDrum || channel === 9) {
    if (midi === 35 || midi === 36) return { kind: 'drum', family: 'kick', oscillator: 'sine', filterType: 'lowpass', filterFrequency: 120, attack: 0.001, release: 0.28, detune: 0 };
    if (midi === 38 || midi === 40) return { kind: 'drum', family: 'snare', oscillator: 'noise', filterType: 'bandpass', filterFrequency: 1800, attack: 0.001, release: 0.18, detune: 0 };
    if ([42, 44, 46, 51, 53, 59].includes(midi)) return { kind: 'drum', family: 'hat', oscillator: 'noise', filterType: 'highpass', filterFrequency: 5200, attack: 0.001, release: midi === 46 ? 0.22 : 0.07, detune: 0 };
    if ([49, 52, 55, 57].includes(midi)) return { kind: 'drum', family: 'cymbal', oscillator: 'noise', filterType: 'highpass', filterFrequency: 3600, attack: 0.001, release: 0.48, detune: 0 };
    return { kind: 'drum', family: 'tom', oscillator: 'triangle', filterType: 'lowpass', filterFrequency: 900, attack: 0.001, release: 0.22, detune: 0 };
  }

  if (program >= 24 && program <= 31) {
    const aggressive = program >= 29;
    return {
      kind: 'melodic',
      family: 'guitar',
      oscillator: aggressive ? 'sawtooth' : 'triangle',
      filterType: aggressive ? 'lowpass' : 'lowpass',
      filterFrequency: aggressive ? 1350 : 1450,
      attack: aggressive ? 0.008 : 0.006,
      release: aggressive ? 0.26 : 0.28,
      detune: aggressive ? -2 : -2,
      gainScale: aggressive ? 0.72 : 0.86,
    };
  }
  if (program >= 32 && program <= 39) return { kind: 'melodic', family: 'bass', oscillator: 'triangle', filterType: 'lowpass', filterFrequency: 720, attack: 0.006, release: 0.26, detune: -7 };
  if (program >= 40 && program <= 55) return { kind: 'melodic', family: 'strings', oscillator: 'sawtooth', filterType: 'lowpass', filterFrequency: 2400, attack: 0.045, release: 0.45, detune: 3 };
  if (program >= 56 && program <= 63) return { kind: 'melodic', family: 'brass', oscillator: 'sawtooth', filterType: 'lowpass', filterFrequency: 2100, attack: 0.025, release: 0.34, detune: 2 };
  if (program >= 64 && program <= 79) return { kind: 'melodic', family: 'reed', oscillator: 'square', filterType: 'bandpass', filterFrequency: 1700, attack: 0.018, release: 0.28, detune: 0 };
  if (program >= 80 && program <= 103) return { kind: 'melodic', family: 'synth', oscillator: program === 80 ? 'square' : 'sawtooth', filterType: 'lowpass', filterFrequency: 3200, attack: 0.01, release: 0.32, detune: 5 };
  return { kind: 'melodic', family: 'keys', oscillator: program <= 7 ? 'triangle' : 'sine', filterType: 'lowpass', filterFrequency: 2600, attack: 0.008, release: 0.3, detune: 0 };
}

function scheduleGainEnvelope(gain, now, peak, attack, release) {
  gain.gain.setValueAtTime?.(0.0001, now);
  gain.gain.exponentialRampToValueAtTime?.(Math.max(0.0002, peak), now + Math.max(0.001, attack));
  gain.gain.exponentialRampToValueAtTime?.(0.0001, now + Math.max(0.03, attack + release));
}

export class AudioEngine {
  constructor({ enabledByDefault = false } = {}) {
    this.context = null;
    this.master = null;
    this.enabled = enabledByDefault;
    this.backingSource = null;
    this.backingStartedAt = null;
    this.backingOffsetSeconds = 0;
    this.backingPlaybackRate = 1;
    this.backingBufferDuration = 0;
    this.backingEnded = false;
  }

  async ensure({ resume = true } = {}) {
    if (!this.context) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.master.gain.value = 0.22;
      this.master.connect(this.context.destination);
    }
    if (resume && this.context.state === 'suspended') await this.context.resume();
  }

  async setEnabled(enabled) {
    this.enabled = enabled;
    if (enabled) await this.ensure();
  }

  async armIfEnabled() {
    if (this.enabled) await this.ensure();
  }


  async decodeAudioData(arrayBuffer, { resume = true } = {}) {
    await this.ensure({ resume });
    const copy = arrayBuffer.slice ? arrayBuffer.slice(0) : arrayBuffer;
    return this.context.decodeAudioData(copy);
  }

  startBackingTrack(buffer, offsetSeconds = 0, playbackRate = 1) {
    if (!this.enabled || !this.context || !this.master || !buffer) return null;
    this.stopBackingTrack();

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate?.setValueAtTime?.(Math.max(0.05, playbackRate), this.context.currentTime);
    source.connect(this.master);
    const safeOffset = Math.max(0, Math.min(offsetSeconds, Math.max(0, (buffer.duration || 0) - 0.01)));
    const startedAt = this.context.currentTime || 0;
    const safeRate = Math.max(0.05, playbackRate);
    source.start(startedAt, safeOffset);
    this.backingStartedAt = startedAt;
    this.backingOffsetSeconds = safeOffset;
    this.backingPlaybackRate = safeRate;
    this.backingBufferDuration = Math.max(0, buffer.duration || 0);
    this.backingEnded = false;
    source.onended = () => {
      if (this.backingSource === source) {
        this.backingSource = null;
        this.backingEnded = true;
      }
    };
    this.backingSource = source;
    return source;
  }

  backingTimelineTime() {
    if (!this.context) return null;
    if (this.backingEnded) return this.backingBufferDuration;
    if (!this.backingSource || this.backingStartedAt === null) return null;
    const elapsed = Math.max(0, (this.context.currentTime || 0) - this.backingStartedAt);
    return Math.max(0, Math.min(
      this.backingBufferDuration,
      this.backingOffsetSeconds + elapsed * this.backingPlaybackRate,
    ));
  }

  stopBackingTrack() {
    const source = this.backingSource;
    this.backingSource = null;
    this.backingStartedAt = null;
    this.backingOffsetSeconds = 0;
    this.backingPlaybackRate = 1;
    this.backingBufferDuration = 0;
    this.backingEnded = false;
    if (!source) return;
    try { source.stop(); } catch (_) {}
    try { source.disconnect?.(); } catch (_) {}
  }


  createNoiseBuffer(duration = 0.2) {
    if (!this.context?.createBuffer) return null;
    const sampleRate = this.context.sampleRate || 44100;
    const length = Math.max(1, Math.floor(sampleRate * duration));
    const buffer = this.context.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) {
      const envelope = 1 - (i / length);
      data[i] = (Math.random() * 2 - 1) * envelope;
    }
    return buffer;
  }

  triggerDrum(midi, velocity, duration, voice) {
    const now = this.context.currentTime || 0;
    const gain = this.context.createGain();
    const filter = this.context.createBiquadFilter();
    const peak = Math.max(0.025, Math.min(0.24, velocity * 0.2 * (voice.gainScale ?? 1)));
    filter.type = voice.filterType;
    filter.frequency.setValueAtTime?.(voice.filterFrequency, now);
    filter.Q?.setValueAtTime?.(voice.family === 'snare' ? 1.7 : 0.8, now);
    filter.connect(gain);
    gain.connect(this.master);
    scheduleGainEnvelope(gain, now, peak, voice.attack, Math.max(voice.release, duration * 0.7));

    if (voice.oscillator === 'noise') {
      const source = this.context.createBufferSource?.();
      const buffer = this.createNoiseBuffer(Math.max(voice.release + 0.05, duration));
      if (source && buffer) {
        source.buffer = buffer;
        source.connect(filter);
        source.start(now);
        source.stop?.(now + Math.max(voice.release + 0.04, duration));
        return;
      }
    }

    const osc = this.context.createOscillator();
    osc.type = voice.oscillator === 'noise' ? 'square' : voice.oscillator;
    const base = voice.family === 'kick' ? 86 : voice.family === 'tom' ? Math.max(90, frequencyForMidi(midi - 24)) : frequencyForMidi(midi);
    osc.frequency.setValueAtTime?.(base, now);
    osc.frequency.exponentialRampToValueAtTime?.(Math.max(35, base * 0.52), now + Math.max(0.04, voice.release * 0.7));
    osc.detune?.setValueAtTime?.(voice.detune || 0, now);
    osc.connect(filter);
    osc.start(now);
    osc.stop(now + Math.max(voice.release + 0.04, duration));
  }

  trigger(midiOrNote, velocity = 0.7, duration = 0.18, noteMeta = {}) {
    if (!this.enabled || !this.context || !this.master) return;
    const note = typeof midiOrNote === 'number'
      ? { ...noteMeta, midi: midiOrNote, velocity }
      : { ...midiOrNote, velocity: midiOrNote?.velocity ?? velocity };
    const midi = note.midi ?? 60;
    const voice = instrumentVoiceForNote(note, velocity);
    if (voice.kind === 'drum') {
      this.triggerDrum(midi, velocity, duration, voice);
      return;
    }

    const now = this.context.currentTime || 0;
    const osc = this.context.createOscillator();
    const gain = this.context.createGain();
    const filter = this.context.createBiquadFilter();

    osc.type = voice.oscillator;
    osc.frequency.setValueAtTime(frequencyForMidi(midi), now);
    osc.detune.setValueAtTime(voice.detune || 0, now);

    filter.type = voice.filterType;
    filter.frequency.setValueAtTime(voice.filterFrequency, now);
    filter.Q.setValueAtTime(voice.family === 'guitar' ? 1.35 : 0.8, now);

    const peak = Math.max(0.025, Math.min(0.18, velocity * 0.16 * (voice.gainScale ?? 1)));
    scheduleGainEnvelope(gain, now, peak, voice.attack, Math.max(voice.release, duration));

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    osc.start(now);
    osc.stop(now + Math.max(duration, voice.attack + voice.release) + 0.04);
  }
}
