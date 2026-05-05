import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blackHoleAccelerationAt,
  createBlackHoleOrbit,
  fieldPathSamples,
  sampleBlackHoleOrbit,
  stepBallInCircle,
  createBall,
  reflectVelocity,
  PLAYBACK_PHYSICS_OPTIONS,
} from '../src/physics.js';

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

test('blackHoleAccelerationAt pulls objects toward the black hole with stronger nearby force', () => {
  const blackHole = { enabled: true, x: 0, y: 0, strength: 900000, softeningRadius: 35 };
  const far = blackHoleAccelerationAt({ x: 180, y: 0 }, blackHole);
  const near = blackHoleAccelerationAt({ x: 60, y: 0 }, blackHole);

  assert.ok(far.x < 0, `far acceleration should pull left toward the well, got ${far.x}`);
  assert.ok(near.x < 0, `near acceleration should pull left toward the well, got ${near.x}`);
  assert.ok(Math.abs(near.x) > Math.abs(far.x), 'black-hole acceleration should be stronger near the well');
});

test('fieldPathSamples bends a flight around a black hole using the real acceleration field', () => {
  const start = { x: -180, y: -80 };
  const velocity = { x: 340, y: 120 };
  const gravity = {
    x: 0,
    y: 0,
    blackHole: { enabled: true, x: 0, y: 0, strength: 2000000, softeningRadius: 55, eventHorizonRadius: 12 },
  };
  const samples = fieldPathSamples(start, velocity, 1.0, gravity, 40);
  const midway = samples[Math.floor(samples.length / 2)];
  const linearMidway = {
    x: start.x + velocity.x * 0.5,
    y: start.y + velocity.y * 0.5,
  };

  assert.ok(
    Math.hypot(midway.x - linearMidway.x, midway.y - linearMidway.y) > 12,
    'black-hole field should bend the path rather than using a straight fake trajectory',
  );
});


test('stepBallInCircle reports black-hole event-horizon captures as destruction events', () => {
  const ball = createBall({ x: -16, y: 0, vx: 90, vy: 0, radius: 3 });
  const captures = [];
  const blackHole = { enabled: true, x: 0, y: 0, strength: 0, softeningRadius: 20, eventHorizonRadius: 8 };

  stepBallInCircle(ball, 0.3, arena, { x: 0, y: 0, blackHole }, () => {}, {
    ...PLAYBACK_PHYSICS_OPTIONS,
    onBlackHoleCapture: (capture) => captures.push(capture),
  });

  assert.equal(captures.length, 1, 'crossing the event horizon should emit one capture event');
  assert.equal(captures[0].ball, ball);
  assert.ok(captures[0].distance <= blackHole.eventHorizonRadius + ball.radius + 1e-6);
  assert.equal(ball.blackHoleCaptured, true, 'captured ball should be marked so playback can destroy it');
});

test('captured black-hole balls remain destroyed during later physics prediction steps', () => {
  const ball = createBall({ x: -16, y: 0, vx: 90, vy: 0, radius: 3 });
  const blackHole = { enabled: true, x: 0, y: 0, strength: 1200000, softeningRadius: 20, eventHorizonRadius: 8 };

  stepBallInCircle(ball, 0.3, arena, { x: 0, y: 0, blackHole }, () => {}, PLAYBACK_PHYSICS_OPTIONS);
  assert.equal(ball.blackHoleCaptured, true, 'setup should capture the ball');
  const capturedPosition = { x: ball.x, y: ball.y };

  stepBallInCircle(ball, 0.5, arena, { x: 0, y: 0, blackHole }, () => {}, PLAYBACK_PHYSICS_OPTIONS);

  assert.equal(ball.blackHoleCaptured, true, 'capture flag should remain set');
  assert.equal(ball.x, capturedPosition.x, 'captured balls should not drift back out of the event horizon');
  assert.equal(ball.y, capturedPosition.y, 'captured balls should not drift back out of the event horizon');
  assert.equal(ball.vx, 0);
  assert.equal(ball.vy, 0);
});

test('black-hole waiting orbits start in a wider faint storage band', () => {
  const blackHole = { enabled: true, x: 0, y: 0, radius: 12, strength: 0, softeningRadius: 34, eventHorizonRadius: 10 };
  const ball = createBall({ id: 'waiting-band', x: 1, y: 0, radius: 5 });

  const orbit = createBlackHoleOrbit(ball, blackHole, 2);
  const first = sampleBlackHoleOrbit(orbit, blackHole, 2);

  assert.ok(orbit.initialRadius >= 56, `waiting orbit should be projected away from the event horizon; got ${orbit.initialRadius}`);
  assert.ok(first.radius >= 56, `sampled orbit should begin in the wider storage band; got ${first.radius}`);
  assert.ok(orbit.visualAlpha <= 0.30, `waiting orbit should render subdued; got ${orbit.visualAlpha}`);
  assert.ok(orbit.lightAlpha <= 0.24, `waiting orbit should emit less light; got ${orbit.lightAlpha}`);
});

test('wall contacts inject enough inward bounce to avoid side-wall dribbling', () => {
  const ball = createBall({ x: 92, y: 0, vx: 0, vy: 42, radius: 8 });
  let collisions = 0;
  let deepestInset = 0;

  for (let step = 0; step < 120; step += 1) {
    stepBallInCircle(ball, 1 / 120, arena, { x: 0, y: 160 }, () => {
      collisions += 1;
    }, PLAYBACK_PHYSICS_OPTIONS);
    deepestInset = Math.max(deepestInset, (arena.radius - ball.radius) - Math.hypot(ball.x, ball.y));
  }

  assert.ok(
    deepestInset > 10,
    `ball should visibly detach from the side wall instead of remaining pinned; deepest inset=${deepestInset.toFixed(2)}px`,
  );
  assert.ok(
    collisions < 45,
    `ball should not micro-collide down the wall every frame; collisions=${collisions}`,
  );
});
