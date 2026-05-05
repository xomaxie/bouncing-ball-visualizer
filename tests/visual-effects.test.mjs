import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createVisualEffectsState,
  decayVisualEffects,
  midiToFrequencyBin,
  registerNoteImpact,
} from '../src/visual-effects.js';

test('registerNoteImpact adds a short-lived impact frame and raises the matching frequency bin', () => {
  const effects = createVisualEffectsState({ bandCount: 24 });

  registerNoteImpact(effects, { midi: 60, velocity: 0.75, x: 120, y: 160, color: '#78ddff' });

  const bin = midiToFrequencyBin(60, 24);
  assert.equal(effects.impactFrames.length, 1);
  assert.equal(effects.impactFrames[0].midi, 60);
  assert.equal(effects.impactFrames[0].color, '#78ddff');
  assert.ok(effects.frequencyBands[bin] > 0.55, `expected bin ${bin} to receive energy`);
  assert.ok(effects.screenImpact > 0, 'expected a whole-circle impact frame pulse');
});

test('registerNoteImpact emits deterministic impact particles sized by note amplitude', () => {
  const quiet = createVisualEffectsState({ bandCount: 24 });
  const loud = createVisualEffectsState({ bandCount: 24 });

  registerNoteImpact(quiet, { midi: 60, velocity: 0.2, x: 120, y: 160, color: '#78ddff' });
  registerNoteImpact(loud, { midi: 60, velocity: 1.0, x: 120, y: 160, color: '#78ddff' });

  assert.ok(quiet.particles.length > 0, 'quiet impacts should still create a small spark burst');
  assert.ok(loud.particles.length > quiet.particles.length, 'louder notes should create more particles');
  assert.ok(
    Math.max(...loud.particles.map((particle) => particle.radius)) > Math.max(...quiet.particles.map((particle) => particle.radius)),
    'louder notes should create larger particles',
  );
  assert.ok(
    Math.max(...loud.particles.map((particle) => particle.length)) > Math.max(...quiet.particles.map((particle) => particle.length)),
    'louder notes should create longer spark streaks',
  );
  assert.ok(
    loud.impactFrames[0].burstRadius > quiet.impactFrames[0].burstRadius,
    'louder notes should create a larger impact explosion frame',
  );
  assert.ok(loud.particles.every((particle) => particle.color === '#78ddff'));
  assert.deepEqual(
    loud.particles.map((particle) => [particle.x, particle.y]).slice(0, 3),
    [[120, 160], [120, 160], [120, 160]],
    'particle starts should be deterministic at the impact point',
  );
});

test('decayVisualEffects fades frequency energy and removes spent impact frames', () => {
  const effects = createVisualEffectsState({ bandCount: 12 });
  registerNoteImpact(effects, { midi: 72, velocity: 1, x: 0, y: 0, color: '#fff' });
  const bin = midiToFrequencyBin(72, 12);
  const before = effects.frequencyBands[bin];

  decayVisualEffects(effects, 0.18);

  assert.ok(effects.frequencyBands[bin] < before, 'frequency energy should decay immediately');
  assert.ok(effects.impactFrames.length > 0, 'impact frame should survive a tiny fraction of a second');

  decayVisualEffects(effects, 2.0);

  assert.equal(effects.impactFrames.length, 0, 'spent impact frames should be removed');
  assert.equal(effects.particles.length, 0, 'spent impact particles should be removed');
  assert.ok(effects.frequencyBands.every((value) => value >= 0 && value < 0.02), 'frequency energy should settle near zero');
  assert.equal(effects.screenImpact, 0);
});

test('midiToFrequencyBin maps higher notes to higher bins and clamps extremes', () => {
  assert.ok(midiToFrequencyBin(72, 32) > midiToFrequencyBin(48, 32));
  assert.equal(midiToFrequencyBin(-10, 32), 0);
  assert.equal(midiToFrequencyBin(200, 32), 31);
});

test('registerNoteImpact scales impact particles by scene mode and ball personality', () => {
  const calmBass = createVisualEffectsState({ bandCount: 24 });
  const surgeDrums = createVisualEffectsState({ bandCount: 24 });

  registerNoteImpact(calmBass, {
    midi: 42,
    velocity: 0.7,
    x: 120,
    y: 160,
    color: '#78ddff',
    sceneMode: { name: 'calm', particleMultiplier: 0.72, impactMultiplier: 0.75 },
    personality: { name: 'bass', sparkMultiplier: 0.82, impactRadiusScale: 0.95 },
  });
  registerNoteImpact(surgeDrums, {
    midi: 42,
    velocity: 0.7,
    x: 120,
    y: 160,
    color: '#78ddff',
    sceneMode: { name: 'surge', particleMultiplier: 1.45, impactMultiplier: 1.35 },
    personality: { name: 'drums', sparkMultiplier: 1.55, impactRadiusScale: 1.28 },
  });

  assert.ok(surgeDrums.particles.length > calmBass.particles.length, 'surge drum hits should emit more particles');
  assert.ok(
    surgeDrums.impactFrames[0].burstRadius > calmBass.impactFrames[0].burstRadius,
    'surge drum hits should make larger impact frames',
  );
  assert.ok(surgeDrums.screenImpact > calmBass.screenImpact, 'scene/personality should affect ring impact energy');
});
