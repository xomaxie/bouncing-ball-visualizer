import test from 'node:test';
import assert from 'node:assert/strict';
import { stepBallInCircle, createBall, reflectVelocity, PLAYBACK_PHYSICS_OPTIONS } from '../src/physics.js';

const arena = { cx: 0, cy: 0, radius: 100 };

test('stepBallInCircle reflects an outward-moving ball against the circular boundary', () => {
  const ball = createBall({ x: 92, y: 0, vx: 80, vy: 0, radius: 5 });
  const collisions = [];

  stepBallInCircle(ball, 0.2, arena, { x: 0, y: 0 }, (hit) => collisions.push(hit));

  assert.ok(collisions.length >= 1, 'expected a wall collision');
  assert.ok(ball.x <= 95.000001);
  assert.ok(ball.vx < 0, `expected reflected x velocity, got ${ball.vx}`);
});

test('reflectVelocity preserves tangential velocity and reverses normal velocity with restitution', () => {
  const reflected = reflectVelocity({ x: 10, y: 4 }, { x: 1, y: 0 }, 0.8, 1);
  assert.equal(reflected.x, -8);
  assert.equal(reflected.y, 4);
});

test('reflectVelocity normalizes collision normals before applying restitution', () => {
  const unitNormal = reflectVelocity({ x: 10, y: 4 }, { x: 1, y: 0 }, 0.8, 1);
  const scaledNormal = reflectVelocity({ x: 10, y: 4 }, { x: 2, y: 0 }, 0.8, 1);

  assert.deepEqual(scaledNormal, unitNormal);
});

test('stepBallInCircle uses exact constant-acceleration displacement for planned ballistic motion', () => {
  const ball = createBall({ x: 0, y: 0, vx: 12, vy: -4, radius: 2 });

  stepBallInCircle(ball, 0.5, arena, { x: 0, y: 20 });

  assert.ok(Math.abs(ball.x - 6) < 1e-9, `expected x=6, got ${ball.x}`);
  assert.ok(Math.abs(ball.y - 0.5) < 1e-9, `expected y=0.5, got ${ball.y}`);
  assert.ok(Math.abs(ball.vy - 6) < 1e-9, `expected vy=6, got ${ball.vy}`);
});

test('planned playback physics does not add drag that the ballistic solver did not solve for', () => {
  assert.equal(PLAYBACK_PHYSICS_OPTIONS.drag, 0);
});

test('trajectoryPathSamples starts active paths at the planned in-flight position', async () => {
  const { trajectoryPathSamples } = await import('../src/physics.js');
  const gravity = { x: 0, y: 160 };
  const segment = {
    start: { x: 100, y: 120 },
    centerTarget: { x: 260, y: 210 },
    launchTime: 0.5,
    arrivalTime: 1.5,
    duration: 1,
    velocity: { x: 160, y: 10 },
  };

  const samples = trajectoryPathSamples(segment, 1.0, gravity, 10);

  assert.ok(Math.abs(samples[0].x - 180) < 1e-9);
  assert.ok(Math.abs(samples[0].y - 145) < 1e-9);
  assert.ok(Math.abs(samples.at(-1).x - segment.centerTarget.x) < 1e-9);
  assert.ok(Math.abs(samples.at(-1).y - segment.centerTarget.y) < 1e-9);
});
