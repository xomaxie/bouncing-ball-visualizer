import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseMidiFile } from '../src/midi.js';
import { planTrack } from '../src/solver.js';
import { fieldPathSamples, sampleBlackHoleOrbit, simulatePosition } from '../src/physics.js';
import { advancePlayback, createPlaybackState, hitPlaybackSegment } from '../src/playback.js';

const arena = { cx: 320, cy: 260, radius: 210 };

async function loadBachSampleTracks() {
  const data = await readFile(new URL('../assets/midi/bach-bwv846-guitar-duo.mid', import.meta.url));
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return parseMidiFile(buffer).tracks;
}

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

test('advancePlayback resolves a note hit before redirecting the same ball at the same timestamp', () => {
  const first = {
    id: 'same-time:0',
    ballId: 'same-time-ball',
    trackId: 0,
    trackName: 'same-time ordering',
    target: { x: arena.cx + arena.radius, y: arena.cy },
    centerTarget: { x: arena.cx + arena.radius - 8, y: arena.cy },
    start: { x: arena.cx - arena.radius + 8, y: arena.cy },
    launchTime: 0,
    arrivalTime: 1,
    duration: 1,
    velocity: { x: (arena.radius - 8) * 2, y: 0 },
    gravityY: 0,
    wallColor: '#fff',
    note: { time: 1, midi: 60, velocity: 0.8 },
  };
  const second = {
    id: 'same-time:1',
    ballId: 'same-time-ball',
    trackId: 0,
    trackName: 'same-time ordering',
    target: { x: arena.cx, y: arena.cy - arena.radius },
    centerTarget: { x: arena.cx, y: arena.cy - arena.radius + 8 },
    start: { x: arena.cx + arena.radius - 8, y: arena.cy },
    launchTime: 1,
    arrivalTime: 1.5,
    duration: 0.5,
    velocity: { x: -384, y: -384 },
    gravityY: 0,
    wallColor: '#fff',
    note: { time: 1.5, midi: 72, velocity: 0.8 },
  };
  const plan = {
    tracks: [{ id: 0, color: '#52d6ff', balls: [{ id: 'same-time-ball', events: [first, second] }], segments: [first, second] }],
    events: [first, second],
    duration: 1.5,
    options: { ballRadius: 8, gravityY: 0 },
  };
  const sim = createPlaybackState(plan, arena);
  const hitIds = [];
  const missIds = [];
  const launchIds = [];

  advancePlayback(sim, plan, arena, 1, {
    onHit: ({ segment }) => hitIds.push(segment.id),
    onMiss: ({ segment }) => missIds.push(segment.id),
    onLaunch: ({ segment }) => launchIds.push(segment.id),
  });

  assert.deepEqual(hitIds, ['same-time:0'], 'the arriving note should resolve before the next same-ball launch');
  assert.deepEqual(missIds, [], 'same-timestamp redirect should not cause a false missed note');
  assert.deepEqual(launchIds, ['same-time:0', 'same-time:1'], 'the next note should still launch at the shared timestamp');
  assert.equal(sim.balls.get('same-time-ball').armedSegmentId, 'same-time:1');
});

test('advancePlayback uses the same black-hole field that the solver planned against', () => {
  const blackHole = { enabled: true, x: arena.cx, y: arena.cy, strength: 2000000, softeningRadius: 58, eventHorizonRadius: 16 };
  const segment = {
    id: 'black-hole:0',
    ballId: 'black-hole-ball',
    trackId: 0,
    trackName: 'gravity well',
    target: { x: 470, y: 290 },
    centerTarget: { x: 462, y: 289 },
    start: { x: 145, y: 190 },
    launchTime: 0,
    arrivalTime: 1,
    duration: 1,
    velocity: { x: 320, y: 14 },
    gravityY: 0,
    blackHole,
    wallColor: '#fff',
    note: { time: 1, midi: 62, velocity: 0.8 },
  };
  const plan = {
    tracks: [{ id: 0, color: '#52d6ff', balls: [{ id: 'black-hole-ball', events: [segment] }], segments: [segment] }],
    events: [segment],
    duration: 1,
    options: { ballRadius: 8, gravityY: 0, blackHole },
    blackHole,
  };
  const sim = createPlaybackState(plan, arena);

  advancePlayback(sim, plan, arena, 0.5);
  const ball = sim.balls.get(segment.ballId);
  const expected = fieldPathSamples(segment.start, segment.velocity, 0.5, { x: 0, y: 0, blackHole }, 40).at(-1);

  assert.ok(sim.segmentStates.get(segment.id).launched);
  assert.ok(Math.hypot(ball.x - expected.x, ball.y - expected.y) < 0.75, `black-hole playback diverged from planned field path: ball=(${ball.x}, ${ball.y}) expected=(${expected.x}, ${expected.y})`);
});

test('planned black-hole flights do not bounce off unplayed walls before their scheduled note hit', async () => {
  const localArena = { cx: 640, cy: 410, radius: Math.min(1280, 820) * 0.39 };
  const blackHole = {
    enabled: true,
    offsetX: 0,
    offsetY: 0,
    radius: Math.max(7, localArena.radius * 0.043),
    strength: localArena.radius * localArena.radius * 92,
    softeningRadius: Math.max(24, localArena.radius * 0.115),
    eventHorizonRadius: Math.max(8, localArena.radius * 0.045),
  };
  const tracks = await loadBachSampleTracks();
  const { planSong } = await import('../src/solver.js');
  const plannedSong = planSong(tracks, localArena, {
    gravityY: 160,
    maxSpeed: 1550,
    minFlightTime: 0.28,
    preferredFlightTime: 0.82,
    recoveryTime: 0.06,
    energyAdaptive: true,
    energyThreshold: 0.52,
    pathSamples: 14,
    fieldStep: 1 / 100,
    fieldMaxSteps: 240,
    blackHoleSolveIterations: 7,
    blackHoleSolveTolerancePx: 3.75,
    largeTrackReusableCandidateLimit: 4,
    largeTrackRecycleFallbackCandidateLimit: 12,
    blackHole,
  });
  const sim = createPlaybackState(plannedSong, localArena);
  let hits = 0;
  const collisions = [];

  while (sim.time < 2 && hits < 5) {
    advancePlayback(sim, plannedSong, localArena, 1 / 120, {
      onHit: () => { hits += 1; },
      onCollision: (hit) => {
        collisions.push({
          time: sim.time,
          ballId: hit.ball.id,
          armedSegmentId: hit.ball.armedSegmentId,
        });
      },
    });
  }

  assert.equal(hits, 5, 'test should exercise the first five scheduled Bach note hits');
  assert.deepEqual(collisions, [], `scheduled flights should not produce unplayed wall collisions: ${JSON.stringify(collisions)}`);
});

test('advancePlayback retires one-shot helper balls immediately after their final note when no black-hole storage exists', () => {
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
  assert.equal(ball.spawned, false, 'final-use helper ball should not stay around to make an unplayed wall bounce');
  assert.equal(ball.retired, true, 'final-use helper ball should be marked retired immediately after the final note');
  assert.equal(ball.retireOnNextCollision, false, 'retirement should not be armed through a later non-note wall collision');
});

test('final-use balls enter black-hole waiting orbit immediately after the note hit instead of bouncing off an unplayed wall', () => {
  const blackHole = { enabled: true, x: arena.cx, y: arena.cy, radius: 12, strength: 0, softeningRadius: 40, eventHorizonRadius: 14 };
  const segment = {
    id: 'no-unplayed-wall:0',
    ballId: 'no-unplayed-wall-ball',
    trackId: 0,
    trackName: 'no unplayed walls',
    target: { x: arena.cx + arena.radius, y: arena.cy },
    centerTarget: { x: arena.cx + arena.radius - 8, y: arena.cy },
    start: { x: arena.cx + arena.radius - 8, y: arena.cy },
    launchTime: 0,
    arrivalTime: 0,
    duration: 0,
    velocity: { x: 360, y: -80 },
    gravityY: 0,
    wallColor: '#fff',
    note: { time: 0, midi: 60, velocity: 0.8 },
  };
  const plan = {
    tracks: [{ id: 0, color: '#52d6ff', balls: [{ id: 'no-unplayed-wall-ball', events: [segment] }], segments: [segment] }],
    events: [segment],
    duration: 1,
    options: { ballRadius: 8, gravityY: 0, blackHole },
    blackHole,
  };
  const sim = createPlaybackState(plan, arena);
  let unscheduledWallCollisions = 0;

  advancePlayback(sim, plan, arena, 0.001, {
    onCollision: () => { unscheduledWallCollisions += 1; },
  });
  const ball = sim.balls.get(segment.ballId);

  assert.equal(sim.segmentStates.get(segment.id).hit, true, 'the scheduled note wall hit should still happen');
  assert.equal(unscheduledWallCollisions, 0, 'parking should not require a later non-note wall collision');
  assert.equal(ball.spawned, true, 'the parked ball should stay visible as waiting-room storage');
  assert.equal(ball.retired, false, 'the parked ball should not despawn immediately');
  assert.equal(ball.blackHoleOrbit?.active, true, 'final-use ball should immediately enter the black-hole waiting orbit');
  assert.equal(ball.retireOnNextCollision, false, 'post-hit waiting-room parking should not arm an unplayed wall bounce');
});



test('final-use balls park in a decaying black-hole orbit immediately after the note hit before being destroyed', () => {
  const blackHole = { enabled: true, x: arena.cx, y: arena.cy, radius: 12, strength: 0, softeningRadius: 40, eventHorizonRadius: 14 };
  const segment = {
    id: 'orbit:0',
    ballId: 'orbit-ball',
    trackId: 0,
    trackName: 'orbit test',
    target: { x: arena.cx + arena.radius, y: arena.cy },
    centerTarget: { x: arena.cx + arena.radius - 8, y: arena.cy },
    start: { x: arena.cx + arena.radius - 8, y: arena.cy },
    launchTime: 0,
    arrivalTime: 0,
    duration: 0,
    velocity: { x: 360, y: -80 },
    gravityY: 0,
    wallColor: '#fff',
    note: { time: 0, midi: 60, velocity: 0.8 },
  };
  const plan = {
    tracks: [{ id: 0, color: '#52d6ff', balls: [{ id: 'orbit-ball', events: [segment] }], segments: [segment] }],
    events: [segment],
    duration: 1,
    options: { ballRadius: 8, gravityY: 0, blackHole },
    blackHole,
  };
  const sim = createPlaybackState(plan, arena);

  advancePlayback(sim, plan, arena, 0.001);
  const ball = sim.balls.get(segment.ballId);
  assert.equal(ball.retireOnNextCollision, false, 'final note hit should not arm an unplayed wall bounce');

  assert.equal(ball.spawned, true, 'parked ball should remain visible while orbiting the black hole');
  assert.equal(ball.retired, false, 'parked ball should not immediately despawn');
  assert.equal(ball.blackHoleOrbit.active, true, 'post-final-bounce ball should enter the black-hole waiting room');
  const firstRadius = Math.hypot(ball.x - blackHole.x, ball.y - blackHole.y);
  assert.ok(firstRadius > blackHole.eventHorizonRadius + ball.radius, 'orbit should start outside the destructive event horizon');

  advancePlayback(sim, plan, arena, 0.75);
  const laterRadius = Math.hypot(ball.x - blackHole.x, ball.y - blackHole.y);
  assert.ok(laterRadius < firstRadius, `orbit should decay inward over time: ${laterRadius} vs ${firstRadius}`);

  while (sim.time < 16 && !ball.retired) {
    advancePlayback(sim, plan, arena, 1 / 30);
  }

  assert.equal(ball.spawned, false, 'orbiting ball should finally disappear after falling into the black hole');
  assert.equal(ball.retired, true);
  assert.equal(ball.blackHoleDestroyed, true, 'destruction should be attributed to black-hole capture');
});


test('final-use balls that fall into the black hole enter the waiting orbit instead of vanishing immediately', () => {
  const localArena = { cx: 0, cy: 0, radius: 100 };
  const blackHole = { enabled: true, x: 0, y: 0, radius: 12, strength: 0, softeningRadius: 30, eventHorizonRadius: 10 };
  const segment = {
    id: 'capture-orbit:0',
    ballId: 'capture-orbit-ball',
    trackId: 0,
    trackName: 'capture orbit test',
    target: { x: -localArena.radius, y: 0 },
    centerTarget: { x: -localArena.radius + 8, y: 0 },
    start: { x: -localArena.radius + 8, y: 0 },
    launchTime: 0,
    arrivalTime: 0,
    duration: 0,
    velocity: { x: -300, y: 0 },
    arrivalVelocity: { x: -300, y: 0 },
    gravityY: 0,
    wallColor: '#fff',
    note: { time: 0, midi: 60, velocity: 0.8 },
  };
  const plan = {
    tracks: [{ id: 0, color: '#52d6ff', balls: [{ id: 'capture-orbit-ball', events: [segment] }], segments: [segment] }],
    events: [segment],
    duration: 1,
    options: { ballRadius: 8, gravityY: 0, blackHole },
    blackHole,
  };
  const sim = createPlaybackState(plan, localArena);
  const ball = sim.balls.get(segment.ballId);
  let orbitEvents = 0;
  let captureEvents = 0;

  advancePlayback(sim, plan, localArena, 0.001, {
    onBlackHoleOrbit: () => { orbitEvents += 1; },
    onBlackHoleCapture: () => { captureEvents += 1; },
  });
  while (sim.time < 1 && !ball.blackHoleOrbit && !ball.retired) {
    advancePlayback(sim, plan, localArena, 1 / 120, {
      onBlackHoleOrbit: () => { orbitEvents += 1; },
      onBlackHoleCapture: () => { captureEvents += 1; },
    });
  }

  assert.equal(ball.spawned, true, 'waiting ball should remain visible after black-hole capture parking');
  assert.equal(ball.retired, false, 'waiting ball should not be destroyed immediately at the event horizon');
  assert.equal(ball.blackHoleCaptured, false, 'parking into orbit should clear the terminal capture flag');
  assert.equal(ball.blackHoleOrbit.active, true, 'capture should become a decaying waiting-room orbit');
  assert.equal(orbitEvents, 1);
  assert.equal(captureEvents, 0);
});



test('advancePlayback can redirect a parked black-hole orbit ball into a later scheduled note', () => {
  const blackHole = { enabled: true, x: arena.cx, y: arena.cy, radius: 12, strength: 0, softeningRadius: 40, eventHorizonRadius: 14 };
  const first = {
    id: 'orbit-reuse:0',
    ballId: 'orbit-reuse-ball',
    trackId: 0,
    trackName: 'orbit reuse',
    target: { x: arena.cx + arena.radius, y: arena.cy },
    centerTarget: { x: arena.cx + arena.radius - 8, y: arena.cy },
    start: { x: arena.cx + arena.radius - 8, y: arena.cy },
    launchTime: 0,
    arrivalTime: 0,
    duration: 0,
    velocity: { x: 360, y: -80 },
    gravityY: 0,
    wallColor: '#fff',
    parkInBlackHoleAfterBounce: true,
    note: { time: 0, midi: 60, velocity: 0.8 },
  };
  const launchTime = 1.55;
  const second = {
    id: 'orbit-reuse:1',
    ballId: 'orbit-reuse-ball',
    trackId: 0,
    trackName: 'orbit reuse',
    target: { x: arena.cx, y: arena.cy - arena.radius },
    centerTarget: { x: arena.cx, y: arena.cy - arena.radius + 8 },
    start: { x: arena.cx, y: arena.cy },
    launchTime,
    arrivalTime: launchTime + 0.5,
    duration: 0.5,
    velocity: { x: 0, y: -320 },
    gravityY: 0,
    wallColor: '#fff',
    spawnSource: 'black-hole-orbit',
    note: { time: launchTime + 0.5, midi: 72, velocity: 0.8 },
  };
  const plan = {
    tracks: [{ id: 0, color: '#52d6ff', balls: [{ id: 'orbit-reuse-ball', events: [first, second] }], segments: [first, second] }],
    events: [first, second],
    duration: 2.2,
    options: { ballRadius: 8, gravityY: 0, blackHole },
    blackHole,
  };
  const sim = createPlaybackState(plan, arena);
  const launches = [];
  let observedOrbit = false;

  while (sim.time < second.launchTime - 1e-9) {
    advancePlayback(sim, plan, arena, Math.min(1 / 120, second.launchTime - sim.time), {
      onLaunch: (launch) => launches.push(launch),
      onBlackHoleOrbit: ({ ball }) => {
        observedOrbit = true;
        const orbitLaunch = sampleBlackHoleOrbit(ball.blackHoleOrbit, blackHole, second.launchTime);
        second.start = { x: orbitLaunch.x, y: orbitLaunch.y };
      },
    });
  }

  const secondLaunch = launches.find((launch) => launch.segment.id === second.id);
  const ball = sim.balls.get(second.ballId);

  assert.equal(observedOrbit, true, 'the first segment should park the ball in the waiting orbit before the later launch');
  assert.ok(secondLaunch, 'the orbit-sourced segment should launch');
  assert.equal(secondLaunch.previous.orbiting, true, 'the ball should be redirected while it is in the black-hole waiting orbit');
  assert.ok(secondLaunch.jumpDistance <= 3, `orbit redirect should not teleport; jump=${secondLaunch.jumpDistance}`);
  assert.equal(ball.blackHoleOrbit, null, 'launching the later note should remove the ball from waiting orbit');
  assert.equal(ball.armedSegmentId, second.id);
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


test('advancePlayback does not emit a note impact after the assigned ball is destroyed by the black hole before arrival', () => {
  const blackHole = {
    enabled: true,
    x: arena.cx,
    y: arena.cy,
    radius: 18,
    strength: 0,
    softeningRadius: 40,
    eventHorizonRadius: 28,
  };
  const segment = {
    id: 'captured-before-note:0',
    ballId: 'captured-before-note-ball',
    trackId: 0,
    trackName: 'capture miss',
    target: { x: arena.cx + arena.radius, y: arena.cy },
    centerTarget: { x: arena.cx + arena.radius - 8, y: arena.cy },
    start: { x: arena.cx - arena.radius + 8, y: arena.cy },
    launchTime: 0,
    arrivalTime: 1,
    duration: 1,
    velocity: { x: (arena.radius - 8) * 2, y: 0 },
    gravityY: 0,
    blackHole,
    wallColor: '#fff',
    note: { time: 1, duration: 0.12, midi: 60, velocity: 0.8 },
  };
  const plan = {
    tracks: [{ id: 0, color: '#52d6ff', balls: [{ id: 'captured-before-note-ball', events: [segment] }], segments: [segment] }],
    events: [segment],
    duration: 1.2,
    options: { ballRadius: 8, gravityY: 0, blackHole },
    blackHole,
  };
  const sim = createPlaybackState(plan, arena);
  let hits = 0;
  let captures = 0;
  let misses = 0;

  while (sim.time < segment.arrivalTime + 0.01 - 1e-9) {
    advancePlayback(sim, plan, arena, Math.min(1 / 60, segment.arrivalTime + 0.01 - sim.time), {
      onHit: () => { hits += 1; },
      onBlackHoleCapture: () => { captures += 1; },
      onMiss: () => { misses += 1; },
    });
  }

  assert.ok(captures >= 1, 'test setup should destroy the ball before the scheduled note time');
  assert.equal(misses, 1, 'the missed scheduled note should be recorded once and not retried every frame');
  assert.equal(sim.segmentStates.get(segment.id).missed, true, 'the scheduled note should be marked missed instead of hit');
  assert.equal(hits, 0, 'a scheduled explosion/audio note should not fire when no assigned ball reaches the wall target');
});
