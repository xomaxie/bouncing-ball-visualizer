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
  assert.ok(surge.length >= 88, `expected surge to use most of the particle system, got ${surge.length}`);
  assert.ok(maxDistanceFromCenter(surge) > maxDistanceFromCenter(calm) * 1.16, 'high energy should make the accretion field visibly larger');
});
