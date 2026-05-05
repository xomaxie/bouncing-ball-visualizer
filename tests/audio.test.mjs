import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioEngine, soundButtonLabel, instrumentVoiceForNote } from '../src/audio.js';

function installFakeAudioContext({ initialState = 'running' } = {}) {
  let created = 0;
  let resumed = 0;
  const previousWindow = globalThis.window;

  class FakeGain {
    constructor() {
      this.gain = {
        value: 0,
        setValueAtTime() {},
        exponentialRampToValueAtTime() {},
      };
    }
    connect() {}
  }

  class FakeAudioContext {
    constructor() {
      created += 1;
      this.state = initialState;
      this.destination = {};
    }
    createGain() { return new FakeGain(); }
    createOscillator() {
      return {
        type: 'sine',
        frequency: { setValueAtTime() {} },
        detune: { setValueAtTime() {} },
        connect() {},
        start() {},
        stop() {},
      };
    }
    createBiquadFilter() {
      return {
        type: 'lowpass',
        frequency: { setValueAtTime() {} },
        Q: { setValueAtTime() {} },
        connect() {},
      };
    }
    async resume() {
      resumed += 1;
      this.state = 'running';
    }
  }

  globalThis.window = { AudioContext: FakeAudioContext };
  return {
    stats: () => ({ created, resumed }),
    restore: () => {
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
    },
  };
}

test('AudioEngine can default to sound-on preference before a browser context exists', () => {
  const engine = new AudioEngine({ enabledByDefault: true });

  assert.equal(engine.enabled, true);
  assert.equal(engine.context, null);
});

test('AudioEngine.armIfEnabled creates Web Audio on play click when sound is wanted', async () => {
  const fake = installFakeAudioContext({ initialState: 'suspended' });
  try {
    const engine = new AudioEngine({ enabledByDefault: true });

    await engine.armIfEnabled();

    assert.equal(engine.enabled, true);
    assert.ok(engine.context);
    assert.deepEqual(fake.stats(), { created: 1, resumed: 1 });
  } finally {
    fake.restore();
  }
});

test('soundButtonLabel makes the current audio state unambiguous', () => {
  assert.equal(soundButtonLabel(true), 'audio on');
  assert.equal(soundButtonLabel(false), 'audio muted');
});

test('instrumentVoiceForNote chooses General MIDI-inspired voices instead of pitch-only rough synths', () => {
  assert.deepEqual(
    instrumentVoiceForNote({ midi: 52, program: 30, channel: 0, velocity: 0.8 }),
    {
      kind: 'melodic',
      family: 'guitar',
      oscillator: 'sawtooth',
      filterType: 'lowpass',
      filterFrequency: 1350,
      attack: 0.008,
      release: 0.26,
      detune: -2,
      gainScale: 0.72,
    },
  );

  const drums = instrumentVoiceForNote({ midi: 36, program: 0, channel: 9, velocity: 0.9 });
  assert.equal(drums.kind, 'drum');
  assert.equal(drums.family, 'kick');
});


test('AudioEngine can start and stop a decoded MP3 backing track at a simulation offset', async () => {
  let starts = [];
  let stops = 0;
  const previousWindow = globalThis.window;

  class FakeGain {
    constructor() {
      this.gain = {
        value: 0,
        setValueAtTime() {},
        exponentialRampToValueAtTime() {},
      };
    }
    connect() {}
  }

  class FakeSource {
    constructor() {
      this.playbackRate = { setValueAtTime(value) { this.value = value; } };
      this.buffer = null;
      this.onended = null;
    }
    connect() {}
    disconnect() {}
    start(when, offset) { starts.push({ when, offset, rate: this.playbackRate.value, buffer: this.buffer }); }
    stop() { stops += 1; }
  }

  class FakeAudioContext {
    constructor() {
      this.state = 'running';
      this.currentTime = 12.5;
      this.destination = {};
    }
    createGain() { return new FakeGain(); }
    createBufferSource() { return new FakeSource(); }
    createOscillator() { return { frequency: { setValueAtTime() {} }, detune: { setValueAtTime() {} }, connect() {}, start() {}, stop() {} }; }
    createBiquadFilter() { return { frequency: { setValueAtTime() {} }, Q: { setValueAtTime() {} }, connect() {} }; }
    async resume() {}
  }

  globalThis.window = { AudioContext: FakeAudioContext };
  try {
    const engine = new AudioEngine({ enabledByDefault: true });
    await engine.armIfEnabled();
    const buffer = { duration: 30 };

    engine.startBackingTrack(buffer, 4.25, 1.75);
    engine.stopBackingTrack();

    assert.equal(starts.length, 1);
    assert.deepEqual(starts[0], { when: 12.5, offset: 4.25, rate: 1.75, buffer });
    assert.equal(stops, 1);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('AudioEngine exposes the backing-track clock so visuals can stay synced to MP3 audio', async () => {
  const previousWindow = globalThis.window;

  class FakeGain {
    constructor() {
      this.gain = { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} };
    }
    connect() {}
  }

  class FakeSource {
    constructor() {
      this.playbackRate = { setValueAtTime(value) { this.value = value; } };
    }
    connect() {}
    disconnect() {}
    start() {}
    stop() {}
  }

  class FakeAudioContext {
    constructor() {
      this.state = 'running';
      this.currentTime = 20;
      this.destination = {};
    }
    createGain() { return new FakeGain(); }
    createBufferSource() { return new FakeSource(); }
    createOscillator() { return { frequency: { setValueAtTime() {} }, detune: { setValueAtTime() {} }, connect() {}, start() {}, stop() {} }; }
    createBiquadFilter() { return { frequency: { setValueAtTime() {} }, Q: { setValueAtTime() {} }, connect() {} }; }
    async resume() {}
  }

  globalThis.window = { AudioContext: FakeAudioContext };
  try {
    const engine = new AudioEngine({ enabledByDefault: true });
    await engine.armIfEnabled();
    engine.startBackingTrack({ duration: 30 }, 4, 1.5);

    engine.context.currentTime = 26;

    assert.equal(engine.backingTimelineTime(), 13);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
