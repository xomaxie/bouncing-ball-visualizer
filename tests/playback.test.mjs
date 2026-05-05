import test from 'node:test';
import assert from 'node:assert/strict';
import { planTrack } from '../src/solver.js';
import { simulatePosition } from '../src/physics.js';
import { advancePlayback, createPlaybackState, hitPlaybackSegment } from '../src/playback.js';

const arena = { cx: 320, cy: 260, radius: 210 };

test('advancePlayback keeps an active launched ball on its planned trajectory across frame boundaries', () => {
  const notes = [{ time: 1.0, duration: 0.2, midi: 60, velocity: 0.7 }];
  const planned = planTrack({ id: 0, name: 'single note', notes }, arena, {
    gravityY: 160,
    minFlightTime: 0.28,
    preferredFlightTime: 0.82,
    recoveryTime: 0.06,
    maxSpeed: 1550,
  });
  const plan = {
    tracks: [planned],
    events: planned.segments,
    duration: planned.last,
    options: { ballRadius: 8, gravityY: 160 },
  };
  const segment = plan.events[0];
  const sim = createPlaybackState(plan, arena);

  advancePlayback(sim, plan, arena, segment.launchTime + 0.013);
  const ball = sim.balls.get(segment.ballId);
  const expected = simulatePosition(segment.start, segment.velocity, sim.time - segment.launchTime, { x: 0, y: plan.options.gravityY });

  assert.ok(sim.segmentStates.get(segment.id).launched, 'segment should have launched while crossing the launch boundary');
  assert.ok(!sim.segmentStates.get(segment.id).hit, 'segment should still be in flight');
  assert.ok(Math.hypot(ball.x - expected.x, ball.y - expected.y) < 1e-6, `ball/path mismatch: ball=(${ball.x}, ${ball.y}) expected=(${expected.x}, ${expected.y})`);
});

test('advancePlayback uses per-segment adaptive gravity for scheduled note flights', () => {
  const segment = {
    id: 'adaptive:0',
    ballId: 'adaptive-ball',
    trackId: 0,
    trackName: 'adaptive',
    target: { x: 410, y: 250 },
    centerTarget: { x: 402, y: 250 },
    start: { x: 160, y: 180 },
    launchTime: 0,
    arrivalTime: 1,
    duration: 1,
    velocity: { x: 242, y: -90 },
    gravityY: 320,
    wallColor: '#fff',
    note: { time: 1, midi: 60, velocity: 0.9 },
  };
  const plan = {
    tracks: [{ id: 0, color: '#52d6ff', balls: [{ id: 'adaptive-ball', events: [segment] }], segments: [segment] }],
    events: [segment],
    duration: 1,
    options: { ballRadius: 8, gravityY: 0 },
  };
  const sim = createPlaybackState(plan, arena);

  advancePlayback(sim, plan, arena, 0.5);
  const ball = sim.balls.get(segment.ballId);
  const expected = simulatePosition(segment.start, segment.velocity, 0.5, { x: 0, y: segment.gravityY });

  assert.ok(sim.segmentStates.get(segment.id).launched);
  assert.ok(Math.hypot(ball.x - expected.x, ball.y - expected.y) < 1e-6);
});

test('advancePlayback retires one-shot helper balls on their next natural bounce after the final wall hit', () => {
  const notes = [{ time: 1.0, duration: 0.2, midi: 38, velocity: 0.7 }];
  const planned = planTrack({ id: 0, name: 'single helper', notes }, arena, {
    gravityY: 160,
    minFlightTime: 0.28,
    preferredFlightTime: 0.32,
    maxSpeed: 1550,
  });
  const plan = {
    tracks: [planned],
    events: planned.segments,
    duration: planned.last,
    options: { ballRadius: 8, gravityY: 160, retireAfter: 0.2 },
  };
  const segment = plan.events[0];
  const sim = createPlaybackState(plan, arena);

  while (sim.time < segment.arrivalTime + 0.25 - 1e-9) {
    advancePlayback(sim, plan, arena, Math.min(1 / 60, segment.arrivalTime + 0.25 - sim.time));
  }

  const ball = sim.balls.get(segment.ballId);

  assert.equal(sim.segmentStates.get(segment.id).hit, true, 'segment should have hit before retirement');
  assert.equal(ball.spawned, true, 'final-use helper ball should remain visible through the old timer window');
  assert.equal(ball.retired, false, 'final-use helper ball should not retire before a later natural bounce');

  let postHitCollisions = 0;
  while (sim.time < segment.arrivalTime + 4 && !ball.retired) {
    advancePlayback(sim, plan, arena, 1 / 120, {
      onCollision: () => {
        if (sim.time > segment.arrivalTime + 1e-6) postHitCollisions += 1;
      },
    });
  }

  assert.ok(postHitCollisions > 0, 'test should observe a natural bounce after the final note hit');
  assert.equal(ball.spawned, false, 'final-use helper ball should be hidden on that next natural bounce');
  assert.equal(ball.retired, true, 'final-use helper ball should be marked retired after that bounce');
});

test('hitPlaybackSegment recolors a ball to the rainbow wall color it impacts', () => {
  const segment = {
    id: 'impact:0',
    ballId: 'impact-ball',
    target: { x: arena.cx + arena.radius, y: arena.cy },
    centerTarget: { x: arena.cx + arena.radius - 8, y: arena.cy },
    duration: 0.5,
    velocity: { x: 40, y: 0 },
    wallColor: 'hsla(292, 92%, 56%, 1)',
  };
  const plan = {
    tracks: [{ id: 0, color: '#52d6ff', balls: [{ id: 'impact-ball', events: [segment] }], segments: [segment] }],
    events: [segment],
    duration: 1,
    options: { ballRadius: 8, gravityY: 0 },
  };
  const sim = createPlaybackState(plan, arena);
  const ball = sim.balls.get(segment.ballId);
  ball.spawned = true;
  ball.color = '#52d6ff';

  hitPlaybackSegment(sim, plan, arena, segment);

  assert.equal(ball.color, segment.wallColor);
});
