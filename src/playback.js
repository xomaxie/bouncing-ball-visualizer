import {
  createBall,
  reflectVelocity,
  stepBallInCircle,
  PLAYBACK_PHYSICS_OPTIONS,
} from './physics.js';

const EPSILON = 1e-7;

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
  const incoming = {
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
    const ballGravity = {
      x: gravity.x || 0,
      y: Number.isFinite(ball.gravityY) ? ball.gravityY : (gravity.y || 0),
    };
    stepBallInCircle(ball, dt, arena, ballGravity, (collision) => {
      callbacks.onCollision?.(collision);
      if (ball.retireOnNextCollision && !ball.armedSegmentId) {
        ball.spawned = false;
        ball.retired = true;
        ball.retireOnNextCollision = false;
        ball.vx = 0;
        ball.vy = 0;
      }
    }, physicsOptions);
  }
}

export function advancePlayback(sim, plan, arena, dt, callbacks = {}) {
  if (!plan || !sim || dt <= 0) return sim;

  const gravity = { x: 0, y: plan.options.gravityY || 0 };
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
