import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createEnergyProfile,
  dynamicSolverOptionsForEnergy,
  energyAtTime,
} from '../src/energy.js';
import { planSong } from '../src/solver.js';

const arena = { cx: 320, cy: 260, radius: 210 };

test('createEnergyProfile detects louder denser song sections as higher energy', () => {
  const tracks = [{
    id: 0,
    name: 'energy contrast',
    notes: [
      { time: 0.5, duration: 0.2, midi: 48, velocity: 0.22 },
      { time: 1.8, duration: 0.2, midi: 50, velocity: 0.24 },
      ...Array.from({ length: 18 }, (_, index) => ({
        time: 5 + index * 0.085,
        duration: 0.12,
        midi: 58 + (index % 12),
        velocity: 0.86,
      })),
    ],
  }];

  const profile = createEnergyProfile(tracks, { windowSeconds: 1.2, hopSeconds: 0.2 });

  assert.ok(energyAtTime(profile, 5.6).energy > energyAtTime(profile, 0.6).energy + 0.45);
  assert.equal(energyAtTime(profile, 5.6).level, 'high');
  assert.equal(energyAtTime(profile, 0.6).level, 'low');
});

test('dynamicSolverOptionsForEnergy alters physics only after the energy threshold', () => {
  const base = {
    gravityY: 160,
    maxSpeed: 1550,
    minFlightTime: 0.28,
    preferredFlightTime: 0.82,
    recoveryTime: 0.06,
  };

  const calm = dynamicSolverOptionsForEnergy(base, { energy: 0.28 });
  const intense = dynamicSolverOptionsForEnergy(base, { energy: 0.92 });

  assert.equal(calm.gravityY, base.gravityY, 'low energy should preserve normal gravity');
  assert.equal(calm.maxSpeed, base.maxSpeed, 'low energy should preserve normal speed limit');
  assert.ok(intense.gravityY > base.gravityY, 'high energy should strengthen gravity');
  assert.ok(intense.maxSpeed > base.maxSpeed, 'high energy should allow faster launches');
  assert.ok(intense.minFlightTime < base.minFlightTime, 'high energy should allow tighter note gaps');
  assert.ok(intense.recoveryTime < base.recoveryTime, 'high energy should shorten reuse recovery');
});

test('planSong annotates note segments with adaptive energy physics when enabled', () => {
  const tracks = [{
    id: 0,
    name: 'adaptive plan',
    notes: [
      { time: 0.5, duration: 0.2, midi: 48, velocity: 0.2 },
      ...Array.from({ length: 14 }, (_, index) => ({
        time: 3 + index * 0.08,
        duration: 0.1,
        midi: 56 + (index % 10),
        velocity: 0.95,
      })),
    ],
  }];

  const plan = planSong(tracks, arena, {
    gravityY: 160,
    maxSpeed: 1550,
    minFlightTime: 0.28,
    preferredFlightTime: 0.82,
    recoveryTime: 0.06,
    energyAdaptive: true,
  });

  const quiet = plan.events.find((segment) => segment.note.time < 1);
  const loud = plan.events.find((segment) => segment.note.time > 3.4);

  assert.ok(plan.energyProfile?.samples?.length > 0, 'adaptive plans should expose their energy profile');
  assert.equal(quiet.energyLevel, 'low');
  assert.equal(quiet.gravityY, 160);
  assert.equal(loud.energyLevel, 'high');
  assert.ok(loud.energy > quiet.energy + 0.45);
  assert.ok(loud.gravityY > quiet.gravityY);
  assert.ok(loud.speedLimit > 1550);
});

test('sceneModeForEnergy maps rolling energy into visual scene modes with multipliers', async () => {
  const { sceneModeForEnergy } = await import('../src/energy.js');

  const calm = sceneModeForEnergy({ energy: 0.18, intensity: 0, level: 'low' });
  const drive = sceneModeForEnergy({ energy: 0.48, intensity: 0.12, level: 'medium' });
  const surge = sceneModeForEnergy({ energy: 0.88, intensity: 0.78, level: 'high' });

  assert.equal(calm.name, 'calm');
  assert.equal(drive.name, 'drive');
  assert.equal(surge.name, 'surge');
  assert.ok(calm.lightMultiplier < drive.lightMultiplier);
  assert.ok(surge.particleMultiplier > drive.particleMultiplier);
  assert.ok(surge.wallRippleMultiplier > calm.wallRippleMultiplier);
});
