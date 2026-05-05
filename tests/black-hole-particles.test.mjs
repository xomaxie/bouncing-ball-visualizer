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

function visibleCount(particles, threshold = 0.025) {
  return particles.filter((particle) => Number(particle.alpha || 0) > threshold).length;
}

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
  assert.ok(after.every((particle) => Number.isFinite(particle.alpha) && particle.alpha >= 0 && particle.alpha <= 1));
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

  assert.ok(visibleCount(calm) < visibleCount(surge), `expected high-energy display to show more visible particles, calm=${visibleCount(calm)} surge=${visibleCount(surge)}`);
  assert.ok(visibleCount(calm) <= 44, `calm sections should leave the black hole sparse enough to notice energy changes, got ${visibleCount(calm)}`);
  assert.ok(visibleCount(surge) >= 88, `expected surge to use most of the particle system, got ${visibleCount(surge)}`);
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

  assert.ok(visibleCount(punched) >= visibleCount(steady) * 1.8, `impact pulse should densify the black hole, steady=${visibleCount(steady)} punched=${visibleCount(punched)}`);
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

  assert.ok(visibleCount(withBeatPulse) >= visibleCount(rollingHigh) + 14, `beat pulses should add visible density even during high-energy sections, high=${visibleCount(rollingHigh)} pulse=${visibleCount(withBeatPulse)}`);
  assert.ok(maxDistanceFromCenter(withBeatPulse) > maxDistanceFromCenter(rollingHigh) * 1.18, 'beat pulses should visibly expand the black hole over the rolling high-energy baseline');
});

test('black hole particle snapshots expose tiny accretion glints without sprite dots', async () => {
  const { createBlackHoleParticleSystem, blackHoleParticleSnapshots } = await loadParticleModule();
  const system = createBlackHoleParticleSystem(blackHole, { count: 32, seed: 'curved-streak-test' });
  const snapshots = blackHoleParticleSnapshots(system, blackHole, { energy: 0.72, intensity: 0.6, pulse: 0.4 });

  assert.ok(snapshots.length > 0, 'expected visible particle glints');
  for (const particle of snapshots) {
    assert.equal(particle.renderMode, 'micro-streak');
    assert.equal(particle.spriteRadius, 0, 'black-hole particles should be rendered as strokes, not dot sprites');
    assert.ok(Number.isFinite(particle.controlX), 'expected a finite bezier control point x');
    assert.ok(Number.isFinite(particle.controlY), 'expected a finite bezier control point y');

    const chordX = particle.x - particle.tailX;
    const chordY = particle.y - particle.tailY;
    const chordLength = Math.hypot(chordX, chordY);
    assert.ok(chordLength < 3.4, `accretion glints should stay short instead of becoming microscope worms, got ${chordLength}`);
    assert.ok(particle.size < 1.05, `accretion glints should stay thin, got ${particle.size}`);
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

  assert.ok(visibleCount(calm) <= 20, `calm sections should not overfill the disc with light particles, got ${visibleCount(calm)}`);
  assert.ok(visibleCount(surge) >= 52, `high-energy dominant-color sections should emit substantial light particles, got ${visibleCount(surge)}`);
  assert.ok(visibleCount(surge) > visibleCount(calm) * 3, 'energy should strongly increase the emitted light particle count');
  assert.ok(surge.every((particle) => particle.color === '#ff44aa'), 'disc light particles should use the current dominant note color');
  assert.ok(surge.every((particle) => particle.renderMode === 'photon-dust'));
  assert.ok(surge.every((particle) => particle.spriteRadius === 0), 'disc light should render as light motes/streaks, not old black-hole sprites');
  assert.ok(surge.every((particle) => Number.isFinite(particle.x) && Number.isFinite(particle.y)));
  assert.ok(
    Math.max(...surge.filter((particle) => particle.alpha > 0.025).map((particle) => particle.glowRadius)) > Math.max(...calm.filter((particle) => particle.alpha > 0.025).map((particle) => particle.glowRadius)) * 1.55,
    'high energy should create larger light emission halos',
  );
});

test('black hole disc uses a high-count field of smaller light particles', async () => {
  const { createBlackHoleParticleSystem, blackHoleLightParticleSnapshots } = await loadParticleModule();
  const system = createBlackHoleParticleSystem(blackHole, { count: 1120, seed: 'fine-light-field-test' });

  assert.equal(system.particles.length, 1120, 'the lightfield should support a dense photon-dust cloud instead of a small clamped swarm');

  const surge = blackHoleLightParticleSnapshots(system, blackHole, { energy: 0.91, intensity: 0.78, pulse: 0.72 }, {
    color: '#54c7ff',
    colorEnergy: 1,
  });
  const visible = surge.filter((particle) => particle.alpha > 0.018);
  const maxLineWidth = Math.max(...visible.map((particle) => particle.lineWidth));
  const averageLineWidth = visible.reduce((sum, particle) => sum + particle.lineWidth, 0) / visible.length;
  const maxGlowRadius = Math.max(...visible.map((particle) => particle.glowRadius));
  const segmentLengths = visible.map((particle) => Math.hypot(particle.x - particle.tailX, particle.y - particle.tailY));
  const averageSegmentLength = segmentLengths.reduce((sum, length) => sum + length, 0) / segmentLengths.length;
  const maxSegmentLength = Math.max(...segmentLengths);
  const maxPointRadius = Math.max(...visible.map((particle) => particle.pointRadius));

  assert.ok(visible.length >= 760, `high-energy sections should show a dense fine-grain field, got ${visible.length}`);
  assert.ok(surge.every((particle) => particle.renderMode === 'photon-dust'), 'disc light should render as photon dust, not worm-like curved streaks');
  assert.ok(averageLineWidth < 0.18, `light particles should be hairline-small on average, got ${averageLineWidth}`);
  assert.ok(maxLineWidth < 0.32, `no individual light particle should read like a parasite-sized worm, got ${maxLineWidth}`);
  assert.ok(averageSegmentLength < 1.15, `motion glints should be tiny, not worm-like streaks, got avg ${averageSegmentLength}`);
  assert.ok(maxSegmentLength < 2.8, `no light particle should leave a long worm trail, got ${maxSegmentLength}`);
  assert.ok(maxGlowRadius < 2.6, `individual halos should stay like fine dust, got ${maxGlowRadius}`);
  assert.ok(maxPointRadius <= 0.82, `individual light points should stay tiny, got ${maxPointRadius}`);
});


test('high-energy photon dust has enough luminous footprint to read as particles', async () => {
  const { createBlackHoleParticleSystem, blackHoleLightParticleSnapshots } = await loadParticleModule();
  const system = createBlackHoleParticleSystem(blackHole, { count: 1120, seed: 'luminous-footprint-test' });

  const surge = blackHoleLightParticleSnapshots(system, blackHole, { energy: 0.9, intensity: 0.76, pulse: 0.62 }, {
    color: '#ff66cc',
    colorEnergy: 0.94,
  });
  const visible = surge.filter((particle) => particle.alpha > 0.045);
  const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const segmentLengths = visible.map((particle) => Math.hypot(particle.x - particle.tailX, particle.y - particle.tailY));

  assert.ok(visible.length >= 850, `high-energy sections should keep a dense visible dust cloud, got ${visible.length}`);
  assert.ok(average(visible.map((particle) => particle.alpha)) >= 0.24, `photon dust alpha should be readable, got ${average(visible.map((particle) => particle.alpha))}`);
  assert.ok(average(visible.map((particle) => particle.pointRadius)) >= 0.58, `photon dust point radius should not be subpixel-invisible, got ${average(visible.map((particle) => particle.pointRadius))}`);
  assert.ok(average(visible.map((particle) => particle.glowRadius)) >= 1.75, `photon dust glow should have a visible luminous footprint, got ${average(visible.map((particle) => particle.glowRadius))}`);
  assert.ok(Math.max(...visible.map((particle) => particle.pointRadius)) <= 1.25, 'individual points should stay small enough to avoid sprite blobs');
  assert.ok(Math.max(...segmentLengths) < 0.7, `photon dust should remain dot-like instead of wormy, got segment ${Math.max(...segmentLengths)}`);
});


test('black hole particle snapshots keep stable identities and fade visibility instead of popping counts', async () => {
  const { createBlackHoleParticleSystem, blackHoleParticleSnapshots, blackHoleLightParticleSnapshots } = await loadParticleModule();
  const system = createBlackHoleParticleSystem(blackHole, { count: 64, seed: 'soft-visibility-test' });

  const calm = blackHoleParticleSnapshots(system, blackHole, { energy: 0.18, intensity: 0.04, pulse: 0.02 });
  const surge = blackHoleParticleSnapshots(system, blackHole, { energy: 0.92, intensity: 0.82, pulse: 0.74 });
  const calmLights = blackHoleLightParticleSnapshots(system, blackHole, { energy: 0.18, intensity: 0.04, pulse: 0.02 }, { color: '#44ccff', colorEnergy: 0.12 });
  const surgeLights = blackHoleLightParticleSnapshots(system, blackHole, { energy: 0.92, intensity: 0.82, pulse: 0.74 }, { color: '#ff5588', colorEnergy: 1 });

  assert.equal(calm.length, 64, 'accretion snapshots should keep all particle identities stable so density changes do not pop');
  assert.equal(surge.length, 64, 'surge snapshots should fade particles in, not append a different count');
  assert.equal(calmLights.length, 64, 'disc light snapshots should keep all emitter identities stable');
  assert.equal(surgeLights.length, 64, 'disc light snapshots should keep all emitter identities stable');

  const visible = (particles) => particles.filter((particle) => particle.alpha > 0.025).length;
  assert.ok(visible(surge) > visible(calm) * 1.9, 'energy should still increase visible accretion density through alpha');
  assert.ok(visible(surgeLights) > visible(calmLights) * 2.6, 'energy should still increase visible light-particle density through alpha');
  assert.deepEqual(
    surge.slice(0, 8).map((particle) => particle.id),
    calm.slice(0, 8).map((particle) => particle.id),
    'the same particles should fade between energy states instead of swapping identities',
  );
});
