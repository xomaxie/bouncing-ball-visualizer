import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAudioBufferToSong, mixAudioBufferToMono } from '../src/audio-analysis.js';

function syntheticBuffer({ sampleRate = 8000, duration = 3, pulses = [] } = {}) {
  const length = Math.floor(sampleRate * duration);
  const data = new Float32Array(length);

  for (const pulse of pulses) {
    const start = Math.floor(pulse.time * sampleRate);
    const end = Math.min(length, start + Math.floor((pulse.duration ?? 0.12) * sampleRate));
    for (let i = start; i < end; i += 1) {
      const local = (i - start) / Math.max(1, end - start);
      const envelope = Math.sin(Math.PI * local);
      data[i] += Math.sin((i / sampleRate) * Math.PI * 2 * pulse.frequency) * (pulse.gain ?? 0.8) * envelope;
    }
  }

  return {
    numberOfChannels: 1,
    length,
    sampleRate,
    duration,
    getChannelData(index) {
      assert.equal(index, 0);
      return data;
    },
  };
}

test('mixAudioBufferToMono averages channels without losing duration metadata', () => {
  const left = Float32Array.from([0.2, 0.4, -0.2]);
  const right = Float32Array.from([0.6, -0.2, 0.2]);
  const buffer = {
    numberOfChannels: 2,
    length: 3,
    sampleRate: 3000,
    duration: 0.001,
    getChannelData(index) {
      return index === 0 ? left : right;
    },
  };

  const mono = mixAudioBufferToMono(buffer);

  assert.deepEqual([...mono.samples].map((value) => Number(value.toFixed(3))), [0.4, 0.1, 0]);
  assert.equal(mono.sampleRate, 3000);
  assert.equal(mono.duration, 0.001);
});

test('analyzeAudioBufferToSong converts MP3-like audio transients into bass/mid/treble note tracks', () => {
  const buffer = syntheticBuffer({
    duration: 2.5,
    pulses: [
      { time: 0.35, frequency: 110, duration: 0.14, gain: 0.9 },
      { time: 0.78, frequency: 440, duration: 0.13, gain: 0.75 },
      { time: 1.18, frequency: 1760, duration: 0.11, gain: 0.65 },
      { time: 1.70, frequency: 147, duration: 0.13, gain: 0.85 },
    ],
  });

  const song = analyzeAudioBufferToSong(buffer, {
    frameSize: 512,
    hopSize: 128,
    minSpacingSeconds: 0.16,
    minEventVelocity: 0.12,
  });
  const notes = song.tracks.flatMap((track) => track.notes.map((note) => ({ ...note, track: track.name })));

  assert.equal(song.format, 'audio-analysis');
  assert.equal(song.duration, 2.5);
  assert.ok(notes.length >= 4, `expected at least four detected audio events, got ${notes.length}`);
  assert.ok(notes.some((note) => note.track.startsWith('MP3 bass') && note.midi < 52), 'expected a low-frequency bass event');
  assert.ok(notes.some((note) => note.track.startsWith('MP3 mid') && note.midi >= 52 && note.midi < 72), 'expected a mid-frequency event');
  assert.ok(notes.some((note) => note.track.startsWith('MP3 treble') && note.midi >= 72), 'expected a high-frequency event');
  assert.ok(notes.some((note) => Math.abs(note.time - 0.35) < 0.12), 'expected first transient timing to survive analysis');
  assert.ok(notes.every((note) => note.velocity >= 0.12 && note.velocity <= 1), 'velocity should be normalized for playback');
});

test('analyzeAudioBufferToSong caps dense audio events and keeps each track sorted by time', () => {
  const pulses = Array.from({ length: 80 }, (_, index) => ({
    time: 0.08 + index * 0.055,
    frequency: index % 3 === 0 ? 110 : index % 3 === 1 ? 440 : 1320,
    duration: 0.035,
    gain: 0.7,
  }));
  const buffer = syntheticBuffer({ duration: 5, pulses });

  const song = analyzeAudioBufferToSong(buffer, {
    frameSize: 512,
    hopSize: 128,
    minSpacingSeconds: 0.02,
    maxEvents: 18,
    minEventVelocity: 0.05,
  });
  const notes = song.tracks.flatMap((track) => track.notes);

  assert.ok(notes.length <= 18, `expected event cap to be respected, got ${notes.length}`);
  for (const track of song.tracks) {
    const times = track.notes.map((note) => note.time);
    assert.deepEqual(times, [...times].sort((a, b) => a - b), `${track.name} should stay sorted`);
  }
});

test('analyzeAudioBufferToSong represents sustained pitch changes, not only loud attacks', () => {
  const notes = Array.from({ length: 24 }, (_, index) => ({
    time: index * 0.18,
    frequency: 220 * Math.pow(2, (index % 12) / 12),
    duration: 0.18,
    gain: 0.55,
  }));
  const buffer = syntheticBuffer({ sampleRate: 16000, duration: 4.6, pulses: notes });

  const song = analyzeAudioBufferToSong(buffer, {
    frameSize: 1024,
    hopSize: 256,
    minSpacingSeconds: 0.06,
    sustainSpacingSeconds: 0.12,
    minEventVelocity: 0.08,
  });
  const detected = song.tracks.flatMap((track) => track.notes);

  assert.ok(
    detected.length >= 18,
    `expected sustained melody analysis to keep most notes, got ${detected.length}`,
  );
  assert.ok(
    detected.some((note) => Math.abs(note.time - 2.0) < 0.18),
    'expected later sustained notes to survive instead of detecting only the first attack',
  );
});

test('analyzeAudioBufferToSong extracts simultaneous bass, mid, and treble events from audio frames', () => {
  const buffer = syntheticBuffer({
    duration: 1.8,
    pulses: [
      { time: 0.45, frequency: 110, duration: 0.26, gain: 0.72 },
      { time: 0.45, frequency: 440, duration: 0.26, gain: 0.68 },
      { time: 0.45, frequency: 1760, duration: 0.26, gain: 0.62 },
    ],
  });

  const song = analyzeAudioBufferToSong(buffer, {
    frameSize: 1024,
    hopSize: 256,
    minSpacingSeconds: 0.06,
    sustainSpacingSeconds: 0.12,
    minBandPowerRatio: 0.12,
    minEventVelocity: 0.08,
  });
  const tracks = new Set(song.tracks.map((track) => track.name));
  const clustered = song.tracks.flatMap((track) => track.notes)
    .filter((note) => Math.abs(note.time - 0.45) < 0.2);

  assert.ok([...tracks].some((name) => name.startsWith('MP3 bass')), 'expected bass pseudo-track from simultaneous audio');
  assert.ok([...tracks].some((name) => name.startsWith('MP3 mid')), 'expected mid pseudo-track from simultaneous audio');
  assert.ok([...tracks].some((name) => name.startsWith('MP3 treble')), 'expected treble pseudo-track from simultaneous audio');
  assert.ok(clustered.length >= 3, `expected simultaneous audio frame to create multiple notes, got ${clustered.length}`);
});

test('analyzeAudioBufferToSong keeps quiet early intro notes aligned before the loud section', () => {
  const loudSection = Array.from({ length: 26 }, (_, index) => ({
    time: 1.65 + index * 0.08,
    frequency: index % 2 === 0 ? 220 : 880,
    duration: 0.07,
    gain: 0.9,
  }));
  const buffer = syntheticBuffer({
    sampleRate: 16000,
    duration: 4.2,
    pulses: [
      { time: 0.46, frequency: 660, duration: 0.18, gain: 0.11 },
      ...loudSection,
    ],
  });

  const song = analyzeAudioBufferToSong(buffer, {
    frameSize: 1024,
    hopSize: 256,
    minSpacingSeconds: 0.05,
    sustainSpacingSeconds: 0.1,
    minEventVelocity: 0.04,
  });
  const notes = song.tracks.flatMap((track) => track.notes);
  const firstNoteTime = Math.min(...notes.map((note) => note.time));

  assert.ok(
    firstNoteTime < 0.75,
    `expected the first inferred note to stay near the audible intro, got ${firstNoteTime.toFixed(3)}s`,
  );
});


test('analyzeAudioBufferToSong assigns playable pseudo-instruments for MP3 bands', () => {
  const buffer = syntheticBuffer({
    duration: 1.6,
    pulses: [
      { time: 0.30, frequency: 110, duration: 0.22, gain: 0.8 },
      { time: 0.62, frequency: 440, duration: 0.22, gain: 0.75 },
      { time: 0.94, frequency: 1760, duration: 0.22, gain: 0.7 },
    ],
  });

  const song = analyzeAudioBufferToSong(buffer, {
    frameSize: 1024,
    hopSize: 256,
    minSpacingSeconds: 0.05,
    minBandPowerRatio: 0.1,
  });

  const byName = new Map(song.tracks.map((track) => [track.name, track]));
  assert.equal(byName.get('MP3 bass · Synth Bass 1')?.program, 38);
  assert.equal(byName.get('MP3 mid · Lead 2 (sawtooth)')?.program, 81);
  assert.equal(byName.get('MP3 treble · Vibraphone')?.program, 11);

  for (const track of song.tracks) {
    assert.ok(track.notes.length > 0, `${track.name} should have notes`);
    assert.ok(track.notes.every((note) => note.program === track.program), `${track.name} notes should carry the pseudo-instrument program`);
    assert.ok(track.notes.every((note) => note.instrumentName === track.instrumentName), `${track.name} notes should carry instrument labels`);
  }
});
