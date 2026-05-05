import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeMp3WithPreferredTranscriber,
  basicPitchNotesToSong,
  detectAudioActivityWindow,
  serverBasicPitchResponseToSong,
  transcribeAudioFileWithServerBasicPitch,
} from '../src/basic-pitch-analysis.js';

const fakeAudioBuffer = { duration: 3.2, sampleRate: 44100 };

function makeFakeAudioBufferWithTailSilence({ duration = 15, activeEnd = 3.2, sampleRate = 100 } = {}) {
  const length = Math.ceil(duration * sampleRate);
  const data = new Float32Array(length);
  const activeSamples = Math.floor(activeEnd * sampleRate);
  for (let index = 0; index < activeSamples; index += 1) {
    data[index] = index % 2 === 0 ? 0.2 : -0.2;
  }
  return {
    duration,
    length,
    sampleRate,
    numberOfChannels: 1,
    getChannelData: () => data,
  };
}

test('basicPitchNotesToSong converts Basic Pitch notes into sorted low/mid/high visualizer tracks', () => {
  const song = basicPitchNotesToSong([
    { startTimeSeconds: 1.20, durationSeconds: 0.22, pitchMidi: 78, amplitude: 0.50 },
    { startTimeSeconds: 0.15, durationSeconds: 0.18, pitchMidi: 41, amplitude: 0.80 },
    { startTimeSeconds: 0.70, durationSeconds: 0.40, pitchMidi: 63, amplitude: 1.20 },
    { startTimeSeconds: 0.50, durationSeconds: 0.03, pitchMidi: 52, amplitude: -0.2 },
  ], {
    duration: 3.2,
    sampleRate: 44100,
  });

  assert.equal(song.format, 'basic-pitch');
  assert.equal(song.duration, 3.2);
  assert.equal(song.analysis.transcriber, 'spotify-basic-pitch');
  assert.equal(song.analysis.detectedEvents, 4);
  assert.equal(song.tracks.length, 3);
  assert.deepEqual(song.tracks.map((track) => track.name), [
    'Basic Pitch bass · Synth Bass 1',
    'Basic Pitch mid · Electric Piano 1',
    'Basic Pitch treble · Vibraphone',
  ]);

  const notes = song.tracks.flatMap((track) => track.notes.map((note) => ({ ...note, track: track.name })));
  assert.equal(notes.length, 4);
  assert.deepEqual(notes.map((note) => note.source), ['basic-pitch', 'basic-pitch', 'basic-pitch', 'basic-pitch']);
  assert.ok(notes.find((note) => note.midi === 41 && note.track.startsWith('Basic Pitch bass')));
  assert.ok(notes.find((note) => note.midi === 63 && note.track.startsWith('Basic Pitch mid')));
  assert.ok(notes.find((note) => note.midi === 78 && note.track.startsWith('Basic Pitch treble')));
  assert.ok(notes.every((note) => note.duration >= 0.08), 'very short Basic Pitch notes should be made visible/playable');
  assert.ok(notes.every((note) => note.velocity >= 0.08 && note.velocity <= 1), 'amplitudes should be normalized for playback');

  for (const track of song.tracks) {
    const times = track.notes.map((note) => note.time);
    assert.deepEqual(times, [...times].sort((a, b) => a - b), `${track.name} should be sorted`);
  }
});

test('basicPitchNotesToSong trims Basic Pitch tail hallucinations after decoded MP3 content ends', () => {
  const audioBuffer = makeFakeAudioBufferWithTailSilence({ duration: 15, activeEnd: 3.2 });
  const song = basicPitchNotesToSong([
    { startTimeSeconds: 0.25, durationSeconds: 0.30, pitchMidi: 60, amplitude: 0.7 },
    { startTimeSeconds: 3.05, durationSeconds: 1.00, pitchMidi: 64, amplitude: 0.7 },
    { startTimeSeconds: 12.00, durationSeconds: 0.40, pitchMidi: 67, amplitude: 0.7 },
  ], audioBuffer);

  const notes = song.tracks.flatMap((track) => track.notes);

  assert.equal(notes.length, 2, 'late Basic Pitch notes in MP3 tail silence should be discarded');
  assert.ok(notes.every((note) => note.time < 3.7), `expected notes to end near active content, got ${notes.map((note) => note.time).join(', ')}`);
  assert.ok(notes.every((note) => note.time + note.duration <= 3.7), 'notes overlapping the tail should be clipped near active content');
  assert.ok(song.analysis.audioContentEndSeconds > 3 && song.analysis.audioContentEndSeconds < 3.4);
  assert.equal(song.analysis.trimmedTailEvents, 1);
});

test('detectAudioActivityWindow still finds the ending for dense songs with only a short silent tail', () => {
  const audioBuffer = makeFakeAudioBufferWithTailSilence({ duration: 10, activeEnd: 9.2 });

  const activity = detectAudioActivityWindow(audioBuffer);

  assert.ok(activity.end > 9.1 && activity.end < 9.35, `expected content end near 9.2s, got ${activity.end}`);
});

test('analyzeMp3WithPreferredTranscriber uses high accuracy Basic Pitch result when available', async () => {
  const calls = [];
  const song = await analyzeMp3WithPreferredTranscriber(fakeAudioBuffer, {
    highAccuracy: async () => {
      calls.push('high');
      return basicPitchNotesToSong([
        { startTimeSeconds: 0.4, durationSeconds: 0.2, pitchMidi: 60, amplitude: 0.6 },
      ], fakeAudioBuffer);
    },
    fallback: async () => {
      calls.push('fallback');
      throw new Error('fallback should not run');
    },
  });

  assert.deepEqual(calls, ['high']);
  assert.equal(song.format, 'basic-pitch');
  assert.equal(song.tracks.flatMap((track) => track.notes).length, 1);
});

test('analyzeMp3WithPreferredTranscriber falls back to fast analyzer when Basic Pitch fails', async () => {
  const calls = [];
  const song = await analyzeMp3WithPreferredTranscriber(fakeAudioBuffer, {
    highAccuracy: async () => {
      calls.push('high');
      throw new Error('model unavailable');
    },
    fallback: async () => {
      calls.push('fallback');
      return {
        format: 'audio-analysis',
        duration: 3.2,
        tracks: [
          {
            id: 0,
            name: 'MP3 fallback',
            notes: [{ time: 0.2, duration: 0.1, midi: 64, velocity: 0.5 }],
          },
        ],
        analysis: { transcriber: 'fast-fallback' },
      };
    },
  });

  assert.deepEqual(calls, ['high', 'fallback']);
  assert.equal(song.format, 'audio-analysis');
  assert.equal(song.analysis.highAccuracyError, 'model unavailable');
  assert.equal(song.analysis.transcriber, 'fast-fallback');
});


test('serverBasicPitchResponseToSong preserves Basic Pitch server timing metadata', () => {
  const song = serverBasicPitchResponseToSong({
    notes: [
      { startTimeSeconds: 0.25, durationSeconds: 0.30, pitchMidi: 60, amplitude: 0.7 },
    ],
    analysis: { runtime: 'server', predictionSeconds: 1.4, model: 'basic-pitch-python' },
  }, fakeAudioBuffer);

  assert.equal(song.format, 'basic-pitch');
  assert.equal(song.analysis.transcriber, 'spotify-basic-pitch');
  assert.equal(song.analysis.runtime, 'server');
  assert.equal(song.analysis.predictionSeconds, 1.4);
  assert.equal(song.tracks.flatMap((track) => track.notes).length, 1);
});

test('transcribeAudioFileWithServerBasicPitch posts uploaded audio to the same-origin transcription endpoint', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init?.method, bodyType: init?.body?.constructor?.name });
    assert.equal(init?.method, 'POST');
    assert.ok(init?.body instanceof FormData, 'server transcription should send multipart FormData');
    return new Response(JSON.stringify({
      notes: [
        { startTimeSeconds: 0.1, durationSeconds: 0.2, pitchMidi: 48, amplitude: 0.5 },
      ],
      analysis: { runtime: 'server', predictionSeconds: 0.8 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const file = new Blob(['mp3 bytes'], { type: 'audio/mpeg' });
    file.name = 'clip.mp3';
    const song = await transcribeAudioFileWithServerBasicPitch(file, fakeAudioBuffer, { endpointUrl: '/music-visualizer/api/basic-pitch/transcribe' });
    assert.deepEqual(calls, [{ url: '/music-visualizer/api/basic-pitch/transcribe', method: 'POST', bodyType: 'FormData' }]);
    assert.equal(song.analysis.runtime, 'server');
    assert.equal(song.tracks[0].notes[0].midi, 48);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
