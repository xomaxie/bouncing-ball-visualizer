import {
  applyBlackHoleOrbitToBall,
  createBall,
  createBlackHoleOrbit,
  reflectVelocity,
  stepBallInCircle,
  PLAYBACK_PHYSICS_OPTIONS,
} from './physics.js?v=20260505-note-wall-only-v2';

const EPSILON = 1e-7;


function parkBallInBlackHoleOrbit(ball, blackHole, currentTime = 0) {
  const orbit = createBlackHoleOrbit(ball, blackHole, currentTime);
  if (!ball || !orbit || !blackHole) return false;

  ball.blackHoleOrbit = orbit;
  ball.spawned = true;
  ball.retired = false;
  ball.retireOnNextCollision = false;
  ball.armedSegmentId = null;
  ball.holdAtWall = false;
  ball.blackHoleCaptured = false;
  ball.blackHoleDestroyed = false;
  applyBlackHoleOrbitToBall(ball, orbit, blackHole, currentTime);
  return true;
}

function destroyBallInBlackHole(ball) {
  if (!ball) return;
  ball.spawned = false;
  ball.retired = true;
  ball.retireOnNextCollision = false;
  ball.armedSegmentId = null;
  ball.holdAtWall = false;
  ball.blackHoleOrbit = null;
  ball.blackHoleOrbitProgress = 0;
  ball.blackHoleOrbitRadius = 0;
  ball.blackHoleCaptured = true;
  ball.blackHoleDestroyed = true;
  ball.vx = 0;
  ball.vy = 0;
}

function advanceBlackHoleOrbit(ball, dt, blackHole, currentTime = 0) {
  const orbit = ball?.blackHoleOrbit;
  if (!orbit?.active || !blackHole || dt <= 0) return false;

  const destroyed = applyBlackHoleOrbitToBall(ball, orbit, blackHole, currentTime + dt);
  if (destroyed) {
    ball.x = blackHole.x;
    ball.y = blackHole.y;
    destroyBallInBlackHole(ball);
    return true;
  }

  return false;
}

export function createPlaybackState(plan, arena) {
  const balls = new Map();
  const segmentStates = new Map();

  for (const track of plan?.tracks || []) {
    for (const planned of track.balls) {
      const first = planned.events[0];
      const last = planned.events[planned.events.length - 1];
      const start = first?.start || { x: arena.cx, y: arena.cy };
      const personality = planned.personality || first?.personality || track.personality || null;
      const ball = createBall({
        id: planned.id,
        trackId: planned.trackId,
        x: start.x,
        y: start.y,
        vx: 0,
        vy: 0,
        radius: planned.radius || first?.ballRadius || plan.options.ballRadius,
        color: track.color,
      });
      ball.personality = personality;
      ball.lightMultiplier = Number(personality?.lightMultiplier ?? 1);
      ball.spawned = false;
      ball.retired = false;
      ball.gravityY = planned.idleGravityY || first?.idleGravityY || plan.options.gravityY || 0;
      ball.finalSegmentId = last?.id ?? null;
      ball.retireOnNextCollision = false;
      ball.blackHoleOrbit = null;
      ball.blackHoleOrbitProgress = 0;
      ball.blackHoleOrbitRadius = 0;
      ball.blackHoleCaptured = false;
      ball.blackHoleDestroyed = false;
      ball.holdAtWall = false;
      balls.set(planned.id, ball);
    }

    for (const segment of track.segments) {
      segmentStates.set(segment.id, { launched: false, hit: false, missed: false, missReason: null });
    }
  }

  return {
    time: 0,
    balls,
    segmentStates,
    flashes: [],
    ghostHits: [],
    log: [],
  };
}

export function launchPlaybackSegment(sim, segment) {
  const ball = sim.balls.get(segment.ballId);
  if (!ball) return null;

  const previous = {
    x: ball.x,
    y: ball.y,
    vx: ball.vx,
    vy: ball.vy,
    spawned: ball.spawned,
    orbiting: Boolean(ball.blackHoleOrbit?.active),
  };
  const jumpDistance = previous.spawned ? Math.hypot(previous.x - segment.start.x, previous.y - segment.start.y) : 0;

  ball.x = segment.start.x;
  ball.y = segment.start.y;
  ball.vx = segment.velocity.x;
  ball.vy = segment.velocity.y;
  ball.radius = segment.ballRadius || ball.radius;
  ball.personality = segment.personality || ball.personality;
  ball.lightMultiplier = Number(ball.personality?.lightMultiplier ?? ball.lightMultiplier ?? 1);
  ball.gravityY = Number.isFinite(segment.gravityY) ? segment.gravityY : ball.gravityY;
  ball.armedSegmentId = segment.id;
  ball.spawned = true;
  ball.retired = false;
  ball.blackHoleOrbit = null;
  ball.blackHoleOrbitProgress = 0;
  ball.blackHoleOrbitRadius = 0;
  ball.blackHoleCaptured = false;
  ball.blackHoleDestroyed = false;
  ball.holdAtWall = false;

  const state = sim.segmentStates.get(segment.id);
  if (state) state.launched = true;

  return { ball, segment, previous, jumpDistance };
}


function scheduledHitTolerance(ball, segment) {
  const radius = Math.max(0, Number(segment?.ballRadius ?? ball?.radius ?? 0));
  const solverMiss = Math.max(0, Number(segment?.missDistance || 0));
  return Math.max(7.5, radius * 1.35, solverMiss + 3.5);
}

function validatePlaybackSegmentHit(sim, arena, segment) {
  const ball = sim?.balls?.get(segment?.ballId);
  if (!ball) return { ok: false, reason: 'missing-ball', ball: null };
  if (!ball.spawned || ball.retired) return { ok: false, reason: 'inactive-ball', ball };
  if (ball.blackHoleCaptured || ball.blackHoleDestroyed) return { ok: false, reason: 'black-hole-captured', ball };
  if (ball.armedSegmentId !== segment.id) {
    return { ok: false, reason: 'unarmed-ball', ball, armedSegmentId: ball.armedSegmentId ?? null };
  }

  const center = segment.centerTarget || segment.target;
  if (!center) return { ok: true, ball, distance: 0, tolerance: Infinity };
  const distance = Math.hypot((ball.x || 0) - center.x, (ball.y || 0) - center.y);
  const tolerance = scheduledHitTolerance(ball, segment);
  if (distance > tolerance) {
    return { ok: false, reason: 'missed-target', ball, distance, tolerance };
  }
  return { ok: true, ball, distance, tolerance };
}

function missPlaybackSegment(sim, plan, segment, validation = {}) {
  const state = sim?.segmentStates?.get(segment.id);
  if (state) {
    state.missed = true;
    state.missReason = validation.reason || 'missed';
    state.missDistance = validation.distance ?? null;
  }

  const ball = validation.ball || sim?.balls?.get(segment.ballId);
  if (ball?.armedSegmentId === segment.id) ball.armedSegmentId = null;
  if (ball && !ball.retired && ball.spawned && !ball.blackHoleCaptured && !ball.blackHoleDestroyed) {
    const blackHole = segment.blackHole || plan.blackHole || plan.options?.blackHole || null;
    if (!parkBallInBlackHoleOrbit(ball, blackHole, sim.time)) {
      ball.spawned = false;
      ball.retired = true;
      ball.vx = 0;
      ball.vy = 0;
    }
  }

  return { segment, ball, validation, missed: true };
}

export function hitPlaybackSegment(sim, plan, arena, segment) {
  const ball = sim.balls.get(segment.ballId);
  if (!ball) return null;

  const center = segment.centerTarget || segment.target;
  const normal = {
    x: (segment.target.x - arena.cx) / arena.radius,
    y: (segment.target.y - arena.cy) / arena.radius,
  };
  const incoming = segment.arrivalVelocity || {
    x: segment.velocity.x,
    y: segment.velocity.y + (Number.isFinite(segment.gravityY) ? segment.gravityY : (plan.options.gravityY || 0)) * segment.duration,
  };
  const reflected = reflectVelocity(incoming, normal, 0.92, 0.992);

  ball.x = center.x;
  ball.y = center.y;
  ball.vx = reflected.x;
  ball.vy = reflected.y;
  ball.gravityY = Number.isFinite(segment.idleGravityY) ? segment.idleGravityY : (plan.options.gravityY || 0);
  if (segment.wallColor) ball.color = segment.wallColor;
  ball.armedSegmentId = null;
  ball.spawned = true;
  ball.retired = false;
  ball.holdAtWall = false;
  ball.retireOnNextCollision = false;

  const blackHole = segment.blackHole || plan.blackHole || plan.options?.blackHole || null;
  const shouldParkInBlackHole = Boolean(blackHole)
    && (Boolean(segment.parkInBlackHoleAfterHit) || segment.id === ball.finalSegmentId);
  let parkedInBlackHoleOrbit = false;

  if (shouldParkInBlackHole) {
    parkedInBlackHoleOrbit = parkBallInBlackHoleOrbit(ball, blackHole, segment.arrivalTime ?? sim.time);
  } else if (segment.id === ball.finalSegmentId || Boolean(segment.retireAfterHit)) {
    ball.spawned = false;
    ball.retired = true;
    ball.vx = 0;
    ball.vy = 0;
  } else if (segment.parkInBlackHoleAfterBounce) {
    ball.retireOnNextCollision = true;
  } else {
    ball.holdAtWall = true;
    ball.vx = 0;
    ball.vy = 0;
  }

  const state = sim.segmentStates.get(segment.id);
  if (state) state.hit = true;

  return { ball, segment, parkedInBlackHoleOrbit };
}

function launchDueSegmentsAtCurrentTime(sim, plan, callbacks, predicate = () => true) {
  for (const segment of plan.events) {
    const state = sim.segmentStates.get(segment.id);
    if (!state || state.launched || segment.launchTime > sim.time + EPSILON) continue;
    if (!predicate(segment, state)) continue;
    const launch = launchPlaybackSegment(sim, segment);
    if (launch) callbacks.onLaunch?.(launch);
  }
}

function processEventsAtCurrentTime(sim, plan, arena, callbacks) {
  launchDueSegmentsAtCurrentTime(sim, plan, callbacks, (segment) => (
    Math.abs((segment.arrivalTime ?? 0) - (segment.launchTime ?? 0)) <= EPSILON
      && segment.arrivalTime <= sim.time + EPSILON
  ));

  for (const segment of plan.events) {
    const state = sim.segmentStates.get(segment.id);
    if (!state || state.hit || state.missed || segment.arrivalTime > sim.time + EPSILON) continue;
    const validation = validatePlaybackSegmentHit(sim, arena, segment);
    if (!validation.ok) {
      const miss = missPlaybackSegment(sim, plan, segment, validation);
      callbacks.onMiss?.(miss);
      continue;
    }
    const hit = hitPlaybackSegment(sim, plan, arena, segment);
    if (hit) {
      callbacks.onHit?.(hit);
      if (hit.parkedInBlackHoleOrbit) {
        callbacks.onBlackHoleOrbit?.({ ball: hit.ball, blackHole: plan.blackHole || plan.options?.blackHole || null, segment, time: segment.arrivalTime, hit: true });
      }
    }
  }

  launchDueSegmentsAtCurrentTime(sim, plan, callbacks, (segment) => (
    (segment.arrivalTime ?? Infinity) > sim.time + EPSILON
  ));
}

function nextPendingEventTime(sim, plan, targetTime) {
  let nextTime = targetTime;
  for (const segment of plan.events) {
    const state = sim.segmentStates.get(segment.id);
    if (!state) continue;
    if (!state.launched && segment.launchTime > sim.time + EPSILON && segment.launchTime < nextTime - EPSILON) {
      nextTime = segment.launchTime;
    }
    if (!state.hit && !state.missed && segment.arrivalTime > sim.time + EPSILON && segment.arrivalTime < nextTime - EPSILON) {
      nextTime = segment.arrivalTime;
    }
  }
  return nextTime;
}

function stepSpawnedBalls(sim, dt, arena, gravity, callbacks, physicsOptions) {
  if (dt <= 0) return;
  for (const ball of sim.balls.values()) {
    if (!ball.spawned || ball.retired) continue;
    const blackHole = gravity.blackHole || null;
    let elapsed = 0;
    let guard = 0;

    while (elapsed < dt - 1e-12 && guard < 20000) {
      guard += 1;

      if (!ball.spawned || ball.retired) break;

      if (ball.blackHoleOrbit?.active) {
        const remaining = dt - elapsed;
        const destroyed = advanceBlackHoleOrbit(ball, remaining, blackHole, sim.time + elapsed);
        if (destroyed) callbacks.onBlackHoleCapture?.({ ball, blackHole, x: ball.x, y: ball.y, orbit: true });
        elapsed = dt;
        break;
      }

      if (ball.holdAtWall && !ball.armedSegmentId) {
        elapsed = dt;
        break;
      }

      const subStep = ball.retireOnNextCollision
        ? Math.min(1 / 120, dt - elapsed)
        : dt - elapsed;
      const collisionTime = sim.time + elapsed + subStep;
      const ballGravity = {
        x: gravity.x || 0,
        y: Number.isFinite(ball.gravityY) ? ball.gravityY : (gravity.y || 0),
        blackHole,
      };
      const activeScheduledFlight = Boolean(ball.armedSegmentId);
      stepBallInCircle(ball, subStep, arena, ballGravity, (collision) => {
        callbacks.onCollision?.(collision);
        if (ball.retireOnNextCollision && !ball.armedSegmentId) {
          if (parkBallInBlackHoleOrbit(ball, blackHole, collisionTime)) {
            callbacks.onBlackHoleOrbit?.({ ball, blackHole, collision, time: collisionTime });
            return;
          }
          ball.spawned = false;
          ball.retired = true;
          ball.retireOnNextCollision = false;
          ball.vx = 0;
          ball.vy = 0;
        }
      }, {
        ...physicsOptions,
        grazingWallDetach: !ball.armedSegmentId && !ball.retireOnNextCollision,
        wallCollisionMode: activeScheduledFlight ? 'clamp' : physicsOptions.wallCollisionMode,
        onBlackHoleCapture: (capture) => {
          if (ball.retireOnNextCollision && !ball.armedSegmentId) {
            if (parkBallInBlackHoleOrbit(ball, blackHole, collisionTime)) {
              ball.blackHoleCaptured = true;
              ball._parkedInBlackHoleOrbitThisStep = true;
              callbacks.onBlackHoleOrbit?.({ ball, blackHole, collision: capture, time: collisionTime, capture: true });
              return;
            }
          }
          callbacks.onBlackHoleCapture?.(capture);
          destroyBallInBlackHole(ball);
        },
      });
      if (ball._parkedInBlackHoleOrbitThisStep) {
        ball.blackHoleCaptured = false;
        delete ball._parkedInBlackHoleOrbitThisStep;
      }
      elapsed += subStep;
    }

    if (guard >= 20000) {
      throw new Error('Playback spawned-ball step exceeded guard');
    }
  }
}

export function advancePlayback(sim, plan, arena, dt, callbacks = {}) {
  if (!plan || !sim || dt <= 0) return sim;

  const gravity = { x: 0, y: plan.options.gravityY || 0, blackHole: plan.blackHole || plan.options.blackHole || null };
  const physicsOptions = callbacks.physicsOptions || PLAYBACK_PHYSICS_OPTIONS;
  const targetTime = sim.time + dt;
  let guard = 0;

  processEventsAtCurrentTime(sim, plan, arena, callbacks);

  while (sim.time < targetTime - EPSILON && guard < 10000) {
    guard += 1;
    const nextTime = nextPendingEventTime(sim, plan, targetTime);
    const step = Math.max(0, nextTime - sim.time);
    stepSpawnedBalls(sim, step, arena, gravity, callbacks, physicsOptions);
    sim.time = nextTime;
    processEventsAtCurrentTime(sim, plan, arena, callbacks);
  }

  if (guard >= 10000) {
    throw new Error('Playback advance exceeded event-boundary guard');
  }

  return sim;
}
