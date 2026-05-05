import test from 'node:test';
import assert from 'node:assert/strict';

async function loadParticleModule() {
  try {
    return await import('../src/black-hole-particles.js');
  } catch (error) {
    assert.fail(`expected a black-hole particle system module, got import error: ${error.message}`);
  }
}

const blackHole = {
  enabled: true,
  x: 320,
  y: 260,
  radius: 13,
  eventHorizonRadius: 14,
};

test('black hole visual is a deterministic orbiting particle system', async () => {
  const { createBlackHoleParticleSystem, advanceBlackHoleParticles, blackHoleParticleSnapshots } = await loadParticleModule();
  const system = createBlackHoleParticleSystem(blackHole, { count: 48, seed: 'unit-test' });

  assert.equal(system.particles.length, 48);
  assert.ok(system.particles.every((particle) => particle.orbitRadius > blackHole.eventHorizonRadius), 'particles should orbit outside the event horizon');

  const before = blackHoleParticleSnapshots(system, blackHole);
  advanceBlackHoleParticles(system, 0.5, { intensity: 0.8 });
  const after = blackHoleParticleSnapshots(system, blackHole);

  assert.notDeepEqual(
    after.map((particle) => [Number(particle.x.toFixed(2)), Number(particle.y.toFixed(2))]).slice(0, 12),
    before.map((particle) => [Number(particle.x.toFixed(2)), Number(particle.y.toFixed(2))]).slice(0, 12),
    'particles should visibly orbit instead of drawing a static black-hole image',
  );
  assert.ok(after.every((particle) => Number.isFinite(particle.alpha) && particle.alpha > 0 && particle.alpha <= 1));
});

test('black hole particles reset instead of falling through the event horizon', async () => {
  const { createBlackHoleParticleSystem, advanceBlackHoleParticles } = await loadParticleModule();
  const system = createBlackHoleParticleSystem(blackHole, { count: 16, seed: 'reset-test' });
  const innerLimit = blackHole.eventHorizonRadius * 1.12;

  for (const particle of system.particles) particle.orbitRadius = innerLimit * 0.8;
  advanceBlackHoleParticles(system, 0.2, { intensity: 1 });

  assert.ok(
    system.particles.every((particle) => particle.orbitRadius >= innerLimit),
    'particles that cross the horizon should respawn into the accretion stream',
  );
});

test('black hole accretion display grows denser and wider with song energy', async () => {
  const { createBlackHoleParticleSystem, blackHoleParticleSnapshots } = await loadParticleModule();
  const system = createBlackHoleParticleSystem(blackHole, { count: 96, seed: 'energy-density-test' });

  const calm = blackHoleParticleSnapshots(system, blackHole, { energy: 0.14, intensity: 0, level: 'low' });
  const surge = blackHoleParticleSnapshots(system, blackHole, { energy: 0.94, intensity: 0.9, level: 'high' });

  const maxDistanceFromCenter = (particles) => Math.max(
    0,
    ...particles.map((particle) => Math.hypot(particle.x - blackHole.x, particle.y - blackHole.y)),
  );

  assert.ok(calm.length < surge.length, `expected high-energy display to show more particles, calm=${calm.length} surge=${surge.length}`);
  assert.ok(calm.length <= 44, `calm sections should leave the black hole sparse enough to notice energy changes, got ${calm.length}`);
  assert.ok(surge.length >= 88, `expected surge to use most of the particle system, got ${surge.length}`);
  assert.ok(
    maxDistanceFromCenter(surge) > maxDistanceFromCenter(calm) * 1.65,
    'high energy should make the accretion field dramatically larger, not just subtly wider',
  );
});

test('recent impacts can punch up the black hole even when rolling section energy is flat', async () => {
  const { createBlackHoleParticleSystem, blackHoleParticleSnapshots } = await loadParticleModule();
  const system = createBlackHoleParticleSystem(blackHole, { count: 96, seed: 'impact-pulse-test' });

  const steady = blackHoleParticleSnapshots(system, blackHole, { energy: 0.48, intensity: 0, level: 'medium', pulse: 0 });
  const punched = blackHoleParticleSnapshots(system, blackHole, { energy: 0.48, intensity: 0, level: 'medium', pulse: 0.92 });

  const averageAlpha = (particles) => particles.reduce((sum, particle) => sum + particle.alpha, 0) / particles.length;
  const maxDistanceFromCenter = (particles) => Math.max(
    0,
    ...particles.map((particle) => Math.hypot(particle.x - blackHole.x, particle.y - blackHole.y)),
  );

  assert.ok(punched.length >= steady.length * 1.8, `impact pulse should densify the black hole, steady=${steady.length} punched=${punched.length}`);
  assert.ok(maxDistanceFromCenter(punched) > maxDistanceFromCenter(steady) * 1.45, 'impact pulse should visibly expand the accretion field');
  assert.ok(averageAlpha(punched) > averageAlpha(steady) * 1.35, 'impact pulse should make the particle field visibly brighter');
});

test('moderate impact pulses still read over already-high section energy', async () => {
  const { createBlackHoleParticleSystem, blackHoleParticleSnapshots } = await loadParticleModule();
  const system = createBlackHoleParticleSystem(blackHole, { count: 96, seed: 'high-energy-pulse-test' });

  const rollingHigh = blackHoleParticleSnapshots(system, blackHole, { energy: 0.82, intensity: 0.62, level: 'high', pulse: 0 });
  const withBeatPulse = blackHoleParticleSnapshots(system, blackHole, { energy: 0.82, intensity: 0.62, level: 'high', pulse: 0.38 });
  const maxDistanceFromCenter = (particles) => Math.max(
    0,
    ...particles.map((particle) => Math.hypot(particle.x - blackHole.x, particle.y - blackHole.y)),
  );

  assert.ok(withBeatPulse.length >= rollingHigh.length + 16, `beat pulses should add visible density even during high-energy sections, high=${rollingHigh.length} pulse=${withBeatPulse.length}`);
  assert.ok(maxDistanceFromCenter(withBeatPulse) > maxDistanceFromCenter(rollingHigh) * 1.18, 'beat pulses should visibly expand the black hole over the rolling high-energy baseline');
});

test('black hole particle snapshots expose curved streaks without sprite dots', async () => {
  const { createBlackHoleParticleSystem, blackHoleParticleSnapshots } = await loadParticleModule();
  const system = createBlackHoleParticleSystem(blackHole, { count: 32, seed: 'curved-streak-test' });
  const snapshots = blackHoleParticleSnapshots(system, blackHole, { energy: 0.72, intensity: 0.6, pulse: 0.4 });

  assert.ok(snapshots.length > 0, 'expected visible particle streaks');
  for (const particle of snapshots) {
    assert.equal(particle.renderMode, 'curved-streak');
    assert.equal(particle.spriteRadius, 0, 'black-hole particles should be rendered as strokes, not dot sprites');
    assert.ok(Number.isFinite(particle.controlX), 'expected a finite bezier control point x');
    assert.ok(Number.isFinite(particle.controlY), 'expected a finite bezier control point y');

    const chordX = particle.x - particle.tailX;
    const chordY = particle.y - particle.tailY;
    const controlX = particle.controlX - particle.tailX;
    const controlY = particle.controlY - particle.tailY;
    const cross = Math.abs(chordX * controlY - chordY * controlX);
    assert.ok(cross > 0.35, 'curve control point should bend the streak instead of falling on a straight line');
  }
});

test('black hole disc emits substantial light particles tinted by the current dominant note color', async () => {
  const { createBlackHoleParticleSystem, blackHoleLightParticleSnapshots } = await loadParticleModule();
  const system = createBlackHoleParticleSystem(blackHole, { count: 96, seed: 'dominant-light-test' });

  const calm = blackHoleLightParticleSnapshots(system, blackHole, { energy: 0.18, intensity: 0.05, pulse: 0 }, {
    color: '#33aaff',
    colorEnergy: 0.2,
  });
  const surge = blackHoleLightParticleSnapshots(system, blackHole, { energy: 0.88, intensity: 0.72, pulse: 0.66 }, {
    color: '#ff44aa',
    colorEnergy: 0.95,
  });

  assert.ok(calm.length <= 18, `calm sections should not overfill the disc with light particles, got ${calm.length}`);
  assert.ok(surge.length >= 52, `high-energy dominant-color sections should emit substantial light particles, got ${surge.length}`);
  assert.ok(surge.length > calm.length * 3, 'energy should strongly increase the emitted light particle count');
  assert.ok(surge.every((particle) => particle.color === '#ff44aa'), 'disc light particles should use the current dominant note color');
  assert.ok(surge.every((particle) => particle.renderMode === 'disc-light-particle'));
  assert.ok(surge.every((particle) => particle.spriteRadius === 0), 'disc light should render as light motes/streaks, not old black-hole sprites');
  assert.ok(surge.every((particle) => Number.isFinite(particle.x) && Number.isFinite(particle.y)));
  assert.ok(
    Math.max(...surge.map((particle) => particle.glowRadius)) > Math.max(...calm.map((particle) => particle.glowRadius)) * 1.55,
    'high energy should create larger light emission halos',
  );
});
