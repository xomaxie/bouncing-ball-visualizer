import {
  createBall,
  reflectVelocity,
  stepBallInCircle,
  PLAYBACK_PHYSICS_OPTIONS,
} from './physics.js?v=20260505-black-hole-waiting-room-v1';

const EPSILON = 1e-7;


function hashString(value = '') {
  let hash = 2166136261;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function randomUnitForBall(ball, salt = '') {
  const seed = hashString(`${ball?.id || 'ball'}:${salt}`);
  return ((seed % 1000003) / 1000003);
}

function captureOrbitRadius(ball, blackHole) {
  return Math.max(0, Number(blackHole?.eventHorizonRadius || 0)) + Math.max(0, Number(ball?.radius || 0));
}

function parkBallInBlackHoleOrbit(ball, blackHole, currentTime = 0) {
  if (!ball || !blackHole || blackHole.enabled === false) return false;
  const dx = ball.x - blackHole.x;
  const dy = ball.y - blackHole.y;
  const currentDistance = Math.hypot(dx, dy);
  const captureRadius = captureOrbitRadius(ball, blackHole);
  const safeDistance = Math.max(captureRadius + 6, currentDistance || captureRadius + Number(blackHole.radius || 12) * 2.2);
  const unit = currentDistance > 1e-6
    ? { x: dx / currentDistance, y: dy / currentDistance }
    : { x: Math.cos(randomUnitForBall(ball, 'angle') * Math.PI * 2), y: Math.sin(randomUnitForBall(ball, 'angle') * Math.PI * 2) };
  const direction = randomUnitForBall(ball, `direction:${Math.round(currentTime * 1000)}`) < 0.5 ? -1 : 1;
  const rotations = 2.15 + randomUnitForBall(ball, `rotations:${Math.round(currentTime * 1000)}`) * 2.25;
  const angularVelocity = direction * (1.95 + randomUnitForBall(ball, 'angular-velocity') * 0.9);
  const lifetime = Math.max(1.2, (Math.PI * 2 * rotations) / Math.max(0.4, Math.abs(angularVelocity)));

  ball.blackHoleOrbit = {
    active: true,
    startedAt: currentTime,
    angle: Math.atan2(unit.y, unit.x),
    radius: safeDistance,
    initialRadius: safeDistance,
    captureRadius,
    rotations,
    angularVelocity,
    decayRate: (safeDistance - captureRadius) / lifetime,
    wobble: Math.min(10, Math.max(1.5, safeDistance * 0.018)) * (0.35 + randomUnitForBall(ball, 'wobble') * 0.65),
    wobblePhase: randomUnitForBall(ball, 'phase') * Math.PI * 2,
  };
  ball.spawned = true;
  ball.retired = false;
  ball.retireOnNextCollision = false;
  ball.armedSegmentId = null;
  ball.blackHoleCaptured = false;
  ball.blackHoleDestroyed = false;
  ball.x = blackHole.x + unit.x * safeDistance;
  ball.y = blackHole.y + unit.y * safeDistance;
  ball.vx = -unit.y * Math.abs(angularVelocity) * safeDistance * direction;
  ball.vy = unit.x * Math.abs(angularVelocity) * safeDistance * direction;
  return true;
}

function destroyBallInBlackHole(ball) {
  if (!ball) return;
  ball.spawned = false;
  ball.retired = true;
  ball.retireOnNextCollision = false;
  ball.armedSegmentId = null;
  ball.blackHoleOrbit = null;
  ball.blackHoleCaptured = true;
  ball.blackHoleDestroyed = true;
  ball.vx = 0;
  ball.vy = 0;
}

function advanceBlackHoleOrbit(ball, dt, blackHole) {
  const orbit = ball?.blackHoleOrbit;
  if (!orbit?.active || !blackHole || dt <= 0) return false;

  const previous = { x: ball.x, y: ball.y };
  orbit.angle += orbit.angularVelocity * dt;
  orbit.radius -= orbit.decayRate * dt;
  const visibleRadius = Math.max(orbit.captureRadius, orbit.radius);
  const progress = 1 - Math.max(0, Math.min(1, (visibleRadius - orbit.captureRadius) / Math.max(1, orbit.initialRadius - orbit.captureRadius)));
  const wobble = Math.sin(orbit.angle * 2.3 + orbit.wobblePhase) * orbit.wobble * (1 - progress) * 0.55;
  const radius = Math.max(orbit.captureRadius, visibleRadius + wobble);

  ball.x = blackHole.x + Math.cos(orbit.angle) * radius;
  ball.y = blackHole.y + Math.sin(orbit.angle) * radius;
  ball.vx = (ball.x - previous.x) / dt;
  ball.vy = (ball.y - previous.y) / dt;

  if (orbit.radius <= orbit.captureRadius + 0.2) {
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
      ball.blackHoleCaptured = false;
      ball.blackHoleDestroyed = false;
      balls.set(planned.id, ball);
    }

    for (const segment of track.segments) {
      segmentStates.set(segment.id, { launched: false, hit: false });
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
  ball.blackHoleCaptured = false;
  ball.blackHoleDestroyed = false;

  const state = sim.segmentStates.get(segment.id);
  if (state) state.launched = true;

  return { ball, segment, previous, jumpDistance };
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
  ball.retireOnNextCollision = segment.id === ball.finalSegmentId;

  const state = sim.segmentStates.get(segment.id);
  if (state) state.hit = true;

  return { ball, segment };
}

function processEventsAtCurrentTime(sim, plan, arena, callbacks) {
  for (const segment of plan.events) {
    const state = sim.segmentStates.get(segment.id);
    if (!state || state.launched || segment.launchTime > sim.time + EPSILON) continue;
    const launch = launchPlaybackSegment(sim, segment);
    if (launch) callbacks.onLaunch?.(launch);
  }

  for (const segment of plan.events) {
    const state = sim.segmentStates.get(segment.id);
    if (!state || state.hit || segment.arrivalTime > sim.time + EPSILON) continue;
    const hit = hitPlaybackSegment(sim, plan, arena, segment);
    if (hit) callbacks.onHit?.(hit);
  }
}

function nextPendingEventTime(sim, plan, targetTime) {
  let nextTime = targetTime;
  for (const segment of plan.events) {
    const state = sim.segmentStates.get(segment.id);
    if (!state) continue;
    if (!state.launched && segment.launchTime > sim.time + EPSILON && segment.launchTime < nextTime - EPSILON) {
      nextTime = segment.launchTime;
    }
    if (!state.hit && segment.arrivalTime > sim.time + EPSILON && segment.arrivalTime < nextTime - EPSILON) {
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

    if (ball.blackHoleOrbit?.active) {
      const destroyed = advanceBlackHoleOrbit(ball, dt, blackHole);
      if (destroyed) callbacks.onBlackHoleCapture?.({ ball, blackHole, x: ball.x, y: ball.y, orbit: true });
      continue;
    }

    const ballGravity = {
      x: gravity.x || 0,
      y: Number.isFinite(ball.gravityY) ? ball.gravityY : (gravity.y || 0),
      blackHole,
    };
    stepBallInCircle(ball, dt, arena, ballGravity, (collision) => {
      callbacks.onCollision?.(collision);
      if (ball.retireOnNextCollision && !ball.armedSegmentId) {
        if (parkBallInBlackHoleOrbit(ball, blackHole, sim.time)) {
          callbacks.onBlackHoleOrbit?.({ ball, blackHole, collision });
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
      onBlackHoleCapture: (capture) => {
        callbacks.onBlackHoleCapture?.(capture);
        destroyBallInBlackHole(ball);
      },
    });
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
