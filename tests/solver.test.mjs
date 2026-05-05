import test from 'node:test';
import assert from 'node:assert/strict';
import { pitchToWallTarget, wallColorForTarget } from '../src/music.js';
import { planFlight, planSong, planTrack, pathFitsArena } from '../src/solver.js';
import { fieldPathSamples, simulatePosition } from '../src/physics.js';
import { advancePlayback, createPlaybackState } from '../src/playback.js';

const arena = { cx: 320, cy: 260, radius: 210 };

test('pitchToWallTarget maps low MIDI notes lower on the circular wall than high notes', () => {
  const low = pitchToWallTarget(36, arena, 0);
  const high = pitchToWallTarget(84, arena, 0);

  assert.ok(low.y > arena.cy + arena.radius * 0.72, `low note should be near bottom, got y=${low.y}`);
  assert.ok(high.y < arena.cy - arena.radius * 0.72, `high note should be near top, got y=${high.y}`);
  assert.ok(Math.abs(Math.hypot(low.x - arena.cx, low.y - arena.cy) - arena.radius) < 1e-6);
  assert.ok(Math.abs(Math.hypot(high.x - arena.cx, high.y - arena.cy) - arena.radius) < 1e-6);
});

test('pitchToWallTarget keeps every lane target on the circular wall', () => {
  for (const midi of [40, 48, 55, 60, 67, 72, 80]) {
    for (const lanePhase of [0, 0.37, 1, 1.74, 2, 2.91, 3]) {
      const target = pitchToWallTarget(midi, arena, lanePhase);
      const distance = Math.hypot(target.x - arena.cx, target.y - arena.cy);
      assert.ok(Math.abs(distance - arena.radius) < 1e-6, `${target.name} lane ${lanePhase} distance ${distance}`);
    }
  }
});


test('planSong adapts pitch wall range to the song octave coverage', () => {
  const tracks = [{
    id: 0,
    name: 'doom low melody',
    notes: [
      { time: 0.5, duration: 0.12, midi: 28, velocity: 0.8 },
      { time: 1.2, duration: 0.12, midi: 35, velocity: 0.8 },
      { time: 1.9, duration: 0.12, midi: 47, velocity: 0.8 },
      { time: 2.6, duration: 0.12, midi: 59, velocity: 0.8 },
      { time: 3.3, duration: 0.12, midi: 75, velocity: 0.8 },
    ],
  }];

  const planned = planSong(tracks, arena, { gravityY: 160, maxSpeed: 2200 });
  const low = planned.events.find((segment) => segment.note.midi === 28);
  const high = planned.events.find((segment) => segment.note.midi === 75);

  assert.equal(planned.pitchRange.source, 'adaptive');
  assert.ok(planned.options.minMidi <= 28, `expected lower octave coverage to include E1, got ${planned.options.minMidi}`);
  assert.ok(planned.options.maxMidi >= 75, `expected upper coverage to include D♯5, got ${planned.options.maxMidi}`);
  assert.ok(planned.options.maxMidi < 84, `expected not to waste the old fixed C6 ceiling, got ${planned.options.maxMidi}`);
  assert.ok(low.target.unit > 0, `E1 should no longer be clamped to the absolute bottom, got unit=${low.target.unit}`);
  assert.ok(high.target.unit < 1, `D♯5 should keep top padding instead of being clamped, got unit=${high.target.unit}`);
});


test('planSong adaptive pitch range covers percussion note rows instead of clamping them', () => {
  const tracks = [
    {
      id: 0,
      name: 'low melody',
      notes: [
        { time: 0.5, duration: 0.12, midi: 28, velocity: 0.8 },
        { time: 1.2, duration: 0.12, midi: 41, velocity: 0.8 },
        { time: 2.0, duration: 0.12, midi: 53, velocity: 0.8 },
      ],
    },
    {
      id: 1,
      name: 'percussion hits',
      channel: 9,
      isDrum: true,
      notes: [
        { time: 0.8, duration: 0.08, midi: 36, velocity: 0.9, channel: 9, isDrum: true },
        { time: 1.6, duration: 0.08, midi: 75, velocity: 0.9, channel: 9, isDrum: true },
      ],
    },
  ];

  const planned = planSong(tracks, arena, { gravityY: 160, maxSpeed: 2200 });
  const highPercussion = planned.events.find((segment) => segment.note.midi === 75);

  assert.ok(planned.options.maxMidi >= 75, `expected adaptive range to include high percussion rows, got ${planned.options.maxMidi}`);
  assert.ok(highPercussion.target.unit < 1, `high percussion should not clamp to the absolute top, got unit=${highPercussion.target.unit}`);
});

test('planTrack annotates each note hit with the rainbow wall color at the impact point', () => {
  const planned = planTrack({
    id: 0,
    name: 'wall color check',
    notes: [
      { time: 1.0, duration: 0.2, midi: 40, velocity: 0.7 },
      { time: 2.0, duration: 0.2, midi: 72, velocity: 0.7 },
    ],
  }, arena, { gravityY: 160 });

  for (const segment of planned.segments) {
    assert.equal(segment.wallColor, wallColorForTarget(segment.target, arena));
  }
});


test('planTrack reuses one ball for sparse notes but allocates extra balls for dense notes', () => {
  const sparse = [
    { time: 1.0, duration: 0.2, midi: 48, velocity: 0.7 },
    { time: 3.0, duration: 0.2, midi: 55, velocity: 0.7 },
    { time: 5.0, duration: 0.2, midi: 62, velocity: 0.7 },
  ];
  const dense = [
    { time: 1.0, duration: 0.2, midi: 48, velocity: 0.7 },
    { time: 1.16, duration: 0.2, midi: 55, velocity: 0.7 },
    { time: 1.32, duration: 0.2, midi: 62, velocity: 0.7 },
  ];

  const opts = { minFlightTime: 0.34, recoveryTime: 0.08, preferredFlightTime: 0.9, maxSpeed: 1400, gravityY: 0 };
  const sparsePlan = planTrack({ id: 0, name: 'sparse', notes: sparse }, arena, opts);
  const densePlan = planTrack({ id: 0, name: 'dense', notes: dense }, arena, opts);

  assert.equal(sparsePlan.ballCount, 1);
  assert.ok(densePlan.ballCount > sparsePlan.ballCount, `expected dense track to need more balls, got ${densePlan.ballCount}`);
});

test('planTrack avoids assigning same-hemisphere wall hits to a reused ball', () => {
  const notes = Array.from({ length: 8 }, (_, index) => ({
    time: index * 0.22,
    duration: 0.1,
    midi: 60,
    velocity: 0.7,
  }));
  const opts = { minFlightTime: 0.28, recoveryTime: 0.06, preferredFlightTime: 0.4, maxSpeed: 1550, gravityY: 0 };
  const planned = planTrack({ id: 0, name: 'dense repeated pitch', notes }, arena, opts);

  assert.equal(planned.ballCount, 2, 'cadence should still only need two alternating balls');
  for (const ball of planned.balls) {
    for (let index = 1; index < ball.events.length; index += 1) {
      const previous = ball.events[index - 1].target;
      const next = ball.events[index].target;
      const previousNormal = { x: (previous.x - arena.cx) / arena.radius, y: (previous.y - arena.cy) / arena.radius };
      const nextNormal = { x: (next.x - arena.cx) / arena.radius, y: (next.y - arena.cy) / arena.radius };
      const dot = previousNormal.x * nextNormal.x + previousNormal.y * nextNormal.y;
      assert.ok(dot <= 0, `${ball.id} reused same hemisphere: dot=${dot}`);
    }
  }
});

function measureReusedBallLaunchJumps(planned, localArena, options = {}) {
  const jumps = [];
  const plan = {
    tracks: [planned],
    events: planned.segments,
    duration: planned.last,
    options: { ballRadius: options.ballRadius ?? 8, gravityY: options.gravityY || 0 },
  };
  const sim = createPlaybackState(plan, localArena);
  const eventTimes = [...new Set(planned.segments.flatMap((segment) => [segment.launchTime, segment.arrivalTime]).map((time) => Number(time.toFixed(9))))].sort((a, b) => a - b);

  for (const eventTime of eventTimes) {
    advancePlayback(sim, plan, localArena, eventTime - sim.time, {
      onLaunch: (launch) => {
        if (launch.previous.spawned) jumps.push(launch.jumpDistance);
      },
    });
  }
  return jumps;
}

test('planTrack reuses balls only from their predicted physical launch state', () => {
  const notes = [
    { time: 1.0, duration: 0.2, midi: 48, velocity: 0.7 },
    { time: 3.0, duration: 0.2, midi: 72, velocity: 0.7 },
    { time: 5.0, duration: 0.2, midi: 50, velocity: 0.7 },
  ];
  const opts = { minFlightTime: 0.28, recoveryTime: 0.06, preferredFlightTime: 0.82, maxSpeed: 1550, gravityY: 160 };
  const planned = planTrack({ id: 0, name: 'reuse without teleporting', notes }, arena, opts);
  const jumps = measureReusedBallLaunchJumps(planned, arena, { ...opts, ballRadius: planned.balls[0]?.events[0]?.radius ?? 8 });
  const worstJump = Math.max(0, ...jumps);

  assert.ok(worstJump <= 8, `reused ball launches should not visibly teleport; worst jump was ${worstJump.toFixed(2)}px`);
});

test('planTrack only retargets reused balls from wall contact points', () => {
  const notes = [
    { time: 1.0, duration: 0.2, midi: 48, velocity: 0.7 },
    { time: 3.0, duration: 0.2, midi: 72, velocity: 0.7 },
    { time: 5.0, duration: 0.2, midi: 50, velocity: 0.7 },
  ];
  const opts = { minFlightTime: 0.28, recoveryTime: 0.06, preferredFlightTime: 0.82, maxSpeed: 1550, gravityY: 160, ballRadius: 8 };
  const planned = planTrack({ id: 0, name: 'wall-only retargets', notes }, arena, opts);

  for (const ball of planned.balls) {
    for (let index = 1; index < ball.events.length; index += 1) {
      const segment = ball.events[index];
      const centerDistance = Math.hypot(segment.start.x - arena.cx, segment.start.y - arena.cy);
      const expectedLaunchRadius = arena.radius - opts.ballRadius;
      assert.ok(
        Math.abs(centerDistance - expectedLaunchRadius) <= 1,
        `${ball.id} changed course away from a wall bounce before ${segment.id}; launch radius=${centerDistance.toFixed(2)} expected=${expectedLaunchRadius.toFixed(2)}`,
      );
    }
  }
});

test('planFlight computes a launch velocity that reaches the target at the requested time', () => {
  const start = { x: 10, y: 20 };
  const target = { x: 250, y: 160 };
  const flight = planFlight(start, target, 0.25, 1.45, { gravityY: 180, maxSpeed: 1000 });

  assert.equal(flight.feasible, true);
  const arrived = simulatePosition(start, flight.velocity, flight.duration, { x: 0, y: 180 });
  assert.ok(Math.abs(arrived.x - target.x) < 1e-9);
  assert.ok(Math.abs(arrived.y - target.y) < 1e-9);
});

test('planFlight solves a real black-hole assisted maneuver that reaches the target', () => {
  const blackHole = {
    enabled: true,
    x: arena.cx,
    y: arena.cy,
    strength: 2000000,
    softeningRadius: 58,
    eventHorizonRadius: 16,
  };
  const start = { x: arena.cx - 180, y: arena.cy - 76 };
  const target = { x: arena.cx + 175, y: arena.cy + 42 };
  const flight = planFlight(start, target, 0, 1.18, {
    gravityY: 0,
    maxSpeed: 1400,
    blackHole,
    fieldStep: 1 / 300,
  });
  const samples = fieldPathSamples(start, flight.velocity, flight.duration, { x: 0, y: 0, blackHole }, 90);
  const arrived = samples.at(-1);
  const linearMidway = {
    x: start.x + (target.x - start.x) * 0.5,
    y: start.y + (target.y - start.y) * 0.5,
  };
  const actualMidway = samples[Math.floor(samples.length / 2)];

  assert.equal(flight.feasible, true, flight.reason);
  assert.equal(flight.field, 'black-hole');
  assert.ok(Math.hypot(arrived.x - target.x, arrived.y - target.y) <= 2.5, `missed target by ${Math.hypot(arrived.x - target.x, arrived.y - target.y).toFixed(2)}px`);
  assert.ok(
    Math.hypot(actualMidway.x - linearMidway.x, actualMidway.y - linearMidway.y) > 8,
    'flight should be a visibly curved black-hole maneuver, not a straight ballistic fake',
  );
});

test('planSong places the black-hole gravity well dead center by default', () => {
  const plan = planSong([{
    id: 0,
    name: 'centered well',
    notes: [{ time: 0.5, duration: 0.12, midi: 60, velocity: 0.7 }],
  }], arena, {
    gravityY: 160,
    blackHole: {
      enabled: true,
      radius: 12,
      strength: 1500000,
      softeningRadius: 50,
      eventHorizonRadius: 14,
    },
  });

  assert.equal(plan.blackHole.x, arena.cx);
  assert.equal(plan.blackHole.y, arena.cy);
});


test('pathFitsArena rejects paths where the ball center leaves the circle before the scheduled wall hit', () => {
  const localArena = { cx: 0, cy: 0, radius: 100 };
  const options = { ballRadius: 8, gravityY: 0, pathSamples: 8 };
  const start = { x: 93, y: 0 };
  const duration = 1;
  const velocity = { x: 0, y: 0 };

  assert.equal(pathFitsArena(start, velocity, duration, localArena, options), false);
});

test('pathFitsArena rejects black-hole paths that cross the event horizon', () => {
  const localArena = { cx: 0, cy: 0, radius: 140 };
  const options = {
    ballRadius: 5,
    gravityY: 0,
    pathSamples: 40,
    blackHole: { enabled: true, x: 0, y: 0, strength: 0, softeningRadius: 30, eventHorizonRadius: 20 },
  };

  assert.equal(pathFitsArena({ x: -100, y: 0 }, { x: 200, y: 0 }, 1, localArena, options), false);
});


test('planTrack spawns zero-time notes at the wall contact point without a visible pre-hit jump', () => {
  const track = { id: 0, name: 'instant', notes: [{ time: 0, duration: 0.25, midi: 60, velocity: 0.7 }] };
  const planned = planTrack(track, arena, { gravityY: 160 });
  const segment = planned.segments[0];

  assert.equal(segment.duration, 0);
  assert.ok(Math.abs(segment.start.x - segment.centerTarget.x) < 1e-9);
  assert.ok(Math.abs(segment.start.y - segment.centerTarget.y) < 1e-9);
});





test('planTrack redirects waiting-room black-hole orbit balls before spawning new helpers', () => {
  const blackHole = { enabled: true, x: arena.cx, y: arena.cy, radius: 12, strength: 0, softeningRadius: 40, eventHorizonRadius: 16 };
  const notes = [
    { time: 0.0, duration: 0.08, midi: 24, velocity: 0.76 },
    { time: 2.5, duration: 0.08, midi: 24, velocity: 0.76 },
  ];

  const planned = planTrack({ id: 0, name: 'waiting-room redirect', notes }, arena, {
    gravityY: 160,
    minFlightTime: 0.28,
    preferredFlightTime: 0.82,
    spawnPreferredFlightTime: 0.32,
    maxSpeed: 1550,
    blackHole,
    fieldStep: 1 / 240,
    pathSamples: 30,
    largeTrackNoteThreshold: 9999,
  });

  const redirected = planned.segments.find((segment) => segment.spawnSource === 'black-hole-orbit');

  assert.equal(planned.ballCount, 1, `expected the idle first ball to be redirected from black-hole orbit instead of spawning a second helper; got ${planned.ballCount}`);
  assert.ok(redirected, 'later note should reuse the waiting-room orbit instead of creating a fresh black-hole helper');
  assert.equal(redirected.ballId, planned.segments[0].ballId, 'the redirected note should use the original ball');
  assert.equal(planned.segments[0].parkInBlackHoleAfterBounce, true, 'previous segment should be marked to enter the black-hole waiting room');

  const distanceFromHole = Math.hypot(redirected.start.x - blackHole.x, redirected.start.y - blackHole.y);
  assert.ok(
    distanceFromHole > blackHole.eventHorizonRadius + redirected.ballRadius,
    `redirect launch should start outside the event horizon, distance=${distanceFromHole}`,
  );
});

test('planTrack does not redirect balls that were destroyed by crossing the black hole', () => {
  const blackHole = { enabled: true, x: arena.cx, y: arena.cy, radius: 12, strength: 0, softeningRadius: 40, eventHorizonRadius: 16 };
  const notes = [
    { time: 0.8, duration: 0.08, midi: 32, velocity: 0.76 },
    { time: 2.5, duration: 0.08, midi: 36, velocity: 0.76 },
  ];

  const planned = planTrack({ id: 0, name: 'black-hole capture is terminal', notes }, arena, {
    gravityY: 160,
    minFlightTime: 0.28,
    preferredFlightTime: 0.82,
    spawnPreferredFlightTime: 0.32,
    maxSpeed: 1550,
    wallLaunchTolerance: -1,
    maxWallLaunchContacts: 0,
    blackHole,
    fieldStep: 1 / 240,
    pathSamples: 30,
  });

  assert.notEqual(
    planned.segments[1].spawnSource,
    'black-hole-orbit',
    'a ball whose idle path crosses the event horizon should be destroyed, not parked and redirected',
  );
  assert.notEqual(
    planned.segments[1].ballId,
    planned.segments[0].ballId,
    'the second note should use a new helper because the first ball fell into the black hole',
  );
});

test('planTrack aggressively drains existing black-hole orbit balls for dense later bursts', () => {
  const blackHole = { enabled: true, x: arena.cx, y: arena.cy, radius: 12, strength: 0, softeningRadius: 40, eventHorizonRadius: 16 };
  const initialBurst = Array.from({ length: 18 }, (_, index) => ({
    time: 0,
    duration: 0.08,
    midi: 32 + (index % 9) * 4,
    velocity: 0.76,
  }));
  const laterBurst = Array.from({ length: 14 }, (_, index) => ({
    time: 2.5 + index * 0.08,
    duration: 0.08,
    midi: 36 + (index % 7) * 5,
    velocity: 0.8,
  }));

  const planned = planTrack({ id: 0, name: 'orbit backlog should drain', notes: [...initialBurst, ...laterBurst] }, arena, {
    gravityY: 160,
    minFlightTime: 0.28,
    preferredFlightTime: 0.82,
    spawnPreferredFlightTime: 0.32,
    maxSpeed: 1550,
    reusableCandidateLimit: 1,
    blackHole,
    fieldStep: 1 / 240,
    pathSamples: 30,
    largeTrackNoteThreshold: 9999,
  });

  const orbitSegments = planned.segments.filter((segment) => segment.spawnSource === 'black-hole-orbit');
  const reusedFromExistingBacklog = planned.segments.filter((segment) => segment.note.time >= laterBurst[0].time && ['reuse', 'black-hole-orbit'].includes(segment.spawnSource));
  const spawnedAfterOrbitBacklog = planned.segments.filter((segment) => segment.note.time >= laterBurst[0].time && !['reuse', 'black-hole-orbit'].includes(segment.spawnSource));

  assert.ok(
    reusedFromExistingBacklog.length >= laterBurst.length - 3,
    `expected dense later burst to drain waiting-room/reusable balls before spawning; reused=${reusedFromExistingBacklog.length}/${laterBurst.length}, orbit redirects=${orbitSegments.length}`,
  );
  assert.ok(
    planned.ballCount <= initialBurst.length + 3,
    `expected planner to reuse the ${initialBurst.length} waiting balls instead of spawning new ones; got ${planned.ballCount}`,
  );
  assert.ok(
    spawnedAfterOrbitBacklog.length <= 3,
    `expected at most three new helpers while orbit backlog exists; spawned later=${spawnedAfterOrbitBacklog.length}`,
  );
});

test('newly allocated helper balls originate from the black-hole rim when the well is enabled', () => {
  const blackHole = { enabled: true, x: arena.cx, y: arena.cy, radius: 12, strength: 0, softeningRadius: 40, eventHorizonRadius: 16 };
  const notes = Array.from({ length: 10 }, (_, index) => ({
    time: 2 + index * 0.035,
    duration: 0.08,
    midi: 48 + (index % 5) * 3,
    velocity: 0.7,
  }));

  const planned = planTrack({ id: 0, name: 'black-hole source helpers', notes }, arena, {
    gravityY: 160,
    minFlightTime: 0.28,
    preferredFlightTime: 0.82,
    spawnPreferredFlightTime: 0.34,
    maxSpeed: 1550,
    blackHole,
    fieldStep: 1 / 240,
    pathSamples: 30,
  });

  const firstSegments = planned.balls.map((ball) => ball.events[0]).filter(Boolean);
  assert.ok(firstSegments.length >= 2, `test should force multiple helper creations; got ${firstSegments.length}`);
  for (const segment of firstSegments) {
    if (segment.duration <= 0) continue;
    const distanceFromHole = Math.hypot(segment.start.x - blackHole.x, segment.start.y - blackHole.y);
    assert.equal(segment.spawnSource, 'black-hole', `${segment.id} should explicitly originate at the black-hole emitter`);
    assert.ok(
      distanceFromHole > blackHole.eventHorizonRadius + segment.ballRadius,
      `${segment.id} should start outside the event horizon, distance ${distanceFromHole}`,
    );
    assert.ok(
      distanceFromHole <= blackHole.eventHorizonRadius + segment.ballRadius + 8,
      `${segment.id} should come from the black-hole rim, not a parked seed elsewhere; distance ${distanceFromHole}`,
    );
  }
});

test('planTrack launches newly spawned helper balls just in time instead of parking them early', () => {
  const notes = Array.from({ length: 12 }, (_, index) => ({
    time: 2 + index * 0.035,
    duration: 0.08,
    midi: 38 + (index % 2),
    velocity: 0.65,
  }));
  const planned = planTrack({ id: 0, name: 'dense low helpers', notes }, arena, {
    gravityY: 160,
    minFlightTime: 0.28,
    preferredFlightTime: 0.82,
    spawnPreferredFlightTime: 0.32,
    maxSpeed: 1550,
  });

  const firstFlightDurations = planned.balls.map((ball) => ball.events[0]?.duration ?? 0);
  const longestPrelaunch = Math.max(0, ...firstFlightDurations);

  assert.ok(planned.ballCount > 6, `test should force helper spawns; got ${planned.ballCount} balls`);
  assert.ok(
    longestPrelaunch <= 0.36,
    `spawn-only helper balls should not loiter before notes; longest prelaunch was ${longestPrelaunch.toFixed(3)}s`,
  );
});

test('planTrack caps reusable-ball scans for dense large tracks so loading stays bounded', () => {
  const notes = Array.from({ length: 80 }, (_, index) => ({
    time: 1 + index * 0.045,
    duration: 0.08,
    midi: 36 + (index % 12),
    velocity: 0.78,
  }));

  const planned = planTrack({ id: 0, name: 'dense bounded scan', notes }, arena, {
    gravityY: 160,
    minFlightTime: 0.28,
    preferredFlightTime: 0.82,
    spawnPreferredFlightTime: 0.32,
    maxSpeed: 1550,
    reusableCandidateLimit: 7,
  });

  assert.ok(planned.ballCount > 7, `test should create enough balls to exercise candidate limiting; got ${planned.ballCount}`);
  assert.ok(
    planned.planningStats.maxReusableCandidatesConsidered <= 7,
    `expected no more than 7 candidates per note, saw ${planned.planningStats.maxReusableCandidatesConsidered}`,
  );
});


test('planTrack automatically uses a tighter reusable scan cap for large MIDI-style tracks', () => {
  const notes = Array.from({ length: 320 }, (_, index) => ({
    time: 1 + index * 0.055,
    duration: 0.08,
    midi: 36 + (index % 3),
    velocity: 0.78,
  }));

  const planned = planTrack({ id: 0, name: 'large midi track', notes }, arena, {
    gravityY: 160,
    minFlightTime: 0.28,
    preferredFlightTime: 0.82,
    spawnPreferredFlightTime: 0.32,
    maxSpeed: 1550,
  });

  assert.ok(
    planned.planningStats.maxReusableCandidatesConsidered <= 8,
    `large default tracks should stay responsive by considering no more than 8 reusable balls, saw ${planned.planningStats.maxReusableCandidatesConsidered}`,
  );
});

test('large tracks keep a deeper black-hole orbit scan than the ordinary reusable scan', () => {
  const blackHole = { enabled: true, x: arena.cx, y: arena.cy, radius: 12, strength: 0, softeningRadius: 40, eventHorizonRadius: 16 };
  const initialBurst = Array.from({ length: 72 }, (_, index) => ({
    time: 0,
    duration: 0.08,
    midi: 30 + (index % 18),
    velocity: 0.72,
  }));
  const laterBurst = Array.from({ length: 180 }, (_, index) => ({
    time: 2.6 + index * 0.04,
    duration: 0.08,
    midi: 36 + (index % 12),
    velocity: 0.78,
  }));

  const planned = planTrack({ id: 0, name: 'large orbit backlog', notes: [...initialBurst, ...laterBurst] }, arena, {
    gravityY: 160,
    minFlightTime: 0.28,
    preferredFlightTime: 0.82,
    spawnPreferredFlightTime: 0.32,
    maxSpeed: 1550,
    reusableCandidateLimit: 4,
    largeTrackReusableCandidateLimit: 4,
    blackHole,
    fieldStep: 1 / 240,
    pathSamples: 18,
  });

  assert.ok(planned.notes.length >= 240, 'test should exercise the large-track candidate path');
  assert.ok(
    planned.planningStats.maxReusableCandidatesConsidered <= 4,
    `ordinary reusable scan should stay capped; saw ${planned.planningStats.maxReusableCandidatesConsidered}`,
  );
  assert.ok(
    planned.planningStats.maxOrbitReuseCandidatesConsidered >= 48,
    `black-hole waiting-room scan should look past the first few candidates; saw ${planned.planningStats.maxOrbitReuseCandidatesConsidered}`,
  );
});

test('planTrack searches older bounced balls before spawning another helper', () => {
  const notes = [
    ...Array.from({ length: 12 }, (_, index) => ({
      time: 1 + index * 0.03,
      duration: 0.08,
      midi: 36 + (index % 4) * 8,
      velocity: 0.7,
    })),
    { time: 6.0, duration: 0.08, midi: 60, velocity: 0.7 },
    { time: 6.4, duration: 0.08, midi: 40, velocity: 0.7 },
  ];

  const planned = planTrack({ id: 0, name: 'recycle old helpers', notes }, arena, {
    gravityY: 160,
    minFlightTime: 0.28,
    preferredFlightTime: 0.82,
    spawnPreferredFlightTime: 0.32,
    maxSpeed: 1550,
    reusableCandidateLimit: 2,
    largeTrackNoteThreshold: 9999,
  });

  assert.equal(
    planned.ballCount,
    12,
    `expected planner to recycle an older bounced helper instead of spawning again; got ${planned.ballCount}`,
  );
  assert.ok(
    planned.balls.some((ball) => ball.events.length >= 3),
    'test should assign later notes to an already bounced helper instead of leaving every helper one-shot',
  );
});

test('planTrack can recycle rhythm balls after an intervening wall bounce back to the same low note', () => {
  const notes = Array.from({ length: 12 }, (_, index) => ({
    time: 1 + index * 0.8,
    duration: 0.08,
    midi: 36,
    velocity: 0.78,
    program: 38,
  }));

  const planned = planTrack({ id: 0, name: 'low rhythm bass', program: 38, notes }, arena, {
    gravityY: 160,
    minFlightTime: 0.28,
    preferredFlightTime: 0.82,
    spawnPreferredFlightTime: 0.32,
    maxSpeed: 1550,
    largeTrackNoteThreshold: 9999,
  });

  assert.ok(
    planned.ballCount <= 4,
    `repeated low rhythm hits should recycle balls after natural bounces instead of spawning one per note; got ${planned.ballCount}`,
  );
  assert.ok(
    planned.balls.some((ball) => ball.events.length >= 3),
    'at least one ball should visibly carry multiple repeated low hits',
  );
});

test('planTrack re-energizes repeated low rhythm hits instead of spawning throwaway balls', () => {
  const notes = Array.from({ length: 16 }, (_, index) => ({
    time: 1 + index * 0.4,
    duration: 0.08,
    midi: 36,
    velocity: 0.86,
    channel: 9,
    isDrum: true,
  }));

  const planned = planTrack({ id: 0, name: 'kick rhythm', channel: 9, notes }, arena, {
    gravityY: 160,
    minFlightTime: 0.28,
    preferredFlightTime: 0.82,
    spawnPreferredFlightTime: 0.32,
    maxSpeed: 1550,
    reusableCandidateLimit: 6,
    largeTrackNoteThreshold: 9999,
  });

  assert.ok(
    planned.ballCount <= 4,
    `repeated low rhythm should recycle bouncing balls instead of spawning one per hit; got ${planned.ballCount}`,
  );

  const reusedSegments = planned.balls.flatMap((ball) => ball.events.slice(1));
  assert.ok(reusedSegments.length >= notes.length - 4, 'most rhythm hits should be assigned to already spawned balls');
  assert.ok(
    reusedSegments.some((segment) => segment.sameWallReturn && segment.gravityY > segment.idleGravityY && segment.speed > 100),
    'reused rhythm balls should be re-energized with stronger same-wall bounce physics instead of shallow bottom jitter',
  );
});

function segmentPeakRise(segment, sampleCount = 80) {
  const gravity = { x: segment.gravityX || 0, y: segment.gravityY || 0 };
  let minY = Infinity;
  for (let index = 0; index <= sampleCount; index += 1) {
    const point = simulatePosition(segment.start, segment.velocity, (segment.duration * index) / sampleCount, gravity);
    minY = Math.min(minY, point.y);
  }
  return segment.start.y - minY;
}

test('planTrack gives repeated low rhythm same-wall returns a visibly larger bounce arc', () => {
  const notes = Array.from({ length: 12 }, (_, index) => ({
    time: 1 + index * 0.4,
    duration: 0.08,
    midi: 36,
    velocity: 0.9,
    channel: 9,
    isDrum: true,
  }));

  const planned = planTrack({ id: 0, name: 'kick bounce height', channel: 9, notes }, arena, {
    gravityY: 160,
    minFlightTime: 0.28,
    preferredFlightTime: 0.82,
    spawnPreferredFlightTime: 0.32,
    maxSpeed: 1550,
    reusableCandidateLimit: 6,
    largeTrackNoteThreshold: 9999,
  });

  const sameWallReturns = planned.balls.flatMap((ball) => ball.events.slice(1)).filter((segment) => segment.sameWallReturn);
  const peakRises = sameWallReturns.map((segment) => segmentPeakRise(segment));

  assert.ok(sameWallReturns.length >= notes.length - 4, 'most low rhythm hits should still recycle through same-wall returns');
  assert.ok(
    Math.min(...peakRises) >= arena.radius * 0.24,
    `same-wall rhythm bounces should visibly leave the bottom pocket; peak rises were ${peakRises.map((value) => value.toFixed(1)).join(', ')}`,
  );
  assert.ok(
    sameWallReturns.some((segment) => segment.speed >= 240),
    'same-wall rhythm returns should be made faster instead of barely hopping at the bottom',
  );
});

test('planTrack forbids same-side double bounces above the low rhythm arc', () => {
  const notes = Array.from({ length: 8 }, (_, index) => ({
    time: 1 + index * 0.5,
    duration: 0.08,
    midi: 52,
    velocity: 0.78,
  }));

  const planned = planTrack({ id: 0, name: 'too high for same-side double bounce', notes }, arena, {
    gravityY: 160,
    minFlightTime: 0.28,
    preferredFlightTime: 0.82,
    spawnPreferredFlightTime: 0.32,
    maxSpeed: 1550,
    reusableCandidateLimit: 6,
    largeTrackNoteThreshold: 9999,
  });

  for (const ball of planned.balls) {
    for (let index = 1; index < ball.events.length; index += 1) {
      const previous = ball.events[index - 1].target;
      const next = ball.events[index].target;
      const previousNormal = { x: (previous.x - arena.cx) / arena.radius, y: (previous.y - arena.cy) / arena.radius };
      const nextNormal = { x: (next.x - arena.cx) / arena.radius, y: (next.y - arena.cy) / arena.radius };
      const dot = previousNormal.x * nextNormal.x + previousNormal.y * nextNormal.y;
      const bothInLowPocket = previousNormal.y >= 0.55 && nextNormal.y >= 0.55;
      assert.ok(
        dot <= 0 || bothInLowPocket,
        `${ball.id} double-bounced on the same side above the low rhythm arc: dot=${dot.toFixed(3)} previousY=${previousNormal.y.toFixed(3)} nextY=${nextNormal.y.toFixed(3)}`,
      );
    }
  }
});

test('planTrack applies instrument ball personalities to physics and segment metadata', () => {
  const baseOptions = {
    gravityY: 160,
    maxSpeed: 1550,
    minFlightTime: 0.28,
    preferredFlightTime: 0.82,
    recoveryTime: 0.06,
  };
  const bass = planTrack({
    id: 0,
    name: 'Bass line',
    instrumentName: 'Electric Bass (pick)',
    program: 34,
    notes: [{ time: 1, duration: 0.2, midi: 38, velocity: 0.7, program: 34 }],
  }, arena, baseOptions);
  const treble = planTrack({
    id: 1,
    name: 'Glass lead',
    instrumentName: 'Vibraphone',
    program: 11,
    notes: [{ time: 1, duration: 0.2, midi: 84, velocity: 0.7, program: 11 }],
  }, arena, baseOptions);
  const drums = planTrack({
    id: 2,
    name: 'Drums',
    channel: 9,
    instrumentName: 'Drums',
    notes: [{ time: 1, duration: 0.2, midi: 38, velocity: 0.9, channel: 9, isDrum: true }],
  }, arena, baseOptions);

  assert.equal(bass.personality.name, 'bass');
  assert.equal(treble.personality.name, 'treble');
  assert.equal(drums.personality.name, 'drums');
  assert.ok(bass.balls[0].radius > treble.balls[0].radius, 'bass balls should be visibly heavier than treble balls');
  assert.ok(bass.segments[0].gravityY > baseOptions.gravityY, 'bass should use heavier scheduled gravity');
  assert.ok(treble.segments[0].speedLimit > baseOptions.maxSpeed, 'treble should allow faster agile launches');
  assert.ok(drums.segments[0].personality.sparkMultiplier > bass.segments[0].personality.sparkMultiplier, 'drums should have punchier impacts');
});
