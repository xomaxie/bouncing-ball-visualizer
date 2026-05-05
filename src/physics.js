export const PLAYBACK_PHYSICS_OPTIONS = Object.freeze({ restitution: 0.90, tangentRetention: 0.990, drag: 0 });

export function simulatePosition(start, velocity, duration, gravity = { x: 0, y: 0 }) {
  return {
    x: start.x + velocity.x * duration + 0.5 * (gravity.x || 0) * duration * duration,
    y: start.y + velocity.y * duration + 0.5 * (gravity.y || 0) * duration * duration,
  };
}

export function activeBlackHole(gravityOrOptions = {}) {
  const blackHole = gravityOrOptions?.blackHole;
  if (!blackHole || blackHole.enabled === false) return null;
  if (!Number.isFinite(Number(blackHole.x)) || !Number.isFinite(Number(blackHole.y))) return null;
  return {
    ...blackHole,
    x: Number(blackHole.x),
    y: Number(blackHole.y),
    strength: Math.max(0, Number(blackHole.strength ?? 0)),
    softeningRadius: Math.max(1, Number(blackHole.softeningRadius ?? 48)),
    eventHorizonRadius: Math.max(0, Number(blackHole.eventHorizonRadius ?? 0)),
  };
}


function hashString(value = '') {
  let hash = 2166136261;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function randomUnitForBallId(id = 'ball', salt = '') {
  const seed = hashString(`${id || 'ball'}:${salt}`);
  return ((seed % 1000003) / 1000003);
}

export function blackHoleCaptureRadiusForBall(ballOrRadius = 0, blackHoleConfig = null) {
  const radius = typeof ballOrRadius === 'number'
    ? ballOrRadius
    : Number(ballOrRadius?.radius || 0);
  const blackHole = activeBlackHole({ blackHole: blackHoleConfig }) || blackHoleConfig;
  return Math.max(0, Number(blackHole?.eventHorizonRadius || 0)) + Math.max(0, radius);
}

export function createBlackHoleOrbit(ballLike = {}, blackHoleConfig = null, currentTime = 0) {
  const blackHole = activeBlackHole({ blackHole: blackHoleConfig }) || blackHoleConfig;
  if (!blackHole || blackHole.enabled === false) return null;

  const ballId = ballLike.id || 'ball';
  const ballRadius = Number(ballLike.radius || 0);
  const dx = Number(ballLike.x || 0) - blackHole.x;
  const dy = Number(ballLike.y || 0) - blackHole.y;
  const currentDistance = Math.hypot(dx, dy);
  const captureRadius = blackHoleCaptureRadiusForBall(ballRadius, blackHole);
  const fallbackDistance = captureRadius + Number(blackHole.radius || 12) * 2.2;
  const safeDistance = Math.max(captureRadius + 6, currentDistance || fallbackDistance);
  const unit = currentDistance > 1e-6
    ? { x: dx / currentDistance, y: dy / currentDistance }
    : {
      x: Math.cos(randomUnitForBallId(ballId, 'angle') * Math.PI * 2),
      y: Math.sin(randomUnitForBallId(ballId, 'angle') * Math.PI * 2),
    };
  const timeSalt = Math.round(Number(currentTime || 0) * 1000);
  const direction = randomUnitForBallId(ballId, `direction:${timeSalt}`) < 0.5 ? -1 : 1;
  const rotations = 2.15 + randomUnitForBallId(ballId, `rotations:${timeSalt}`) * 2.25;
  const angularVelocity = direction * (1.95 + randomUnitForBallId(ballId, 'angular-velocity') * 0.9);
  const lifetime = Math.max(1.2, (Math.PI * 2 * rotations) / Math.max(0.4, Math.abs(angularVelocity)));

  return {
    active: true,
    startedAt: Number(currentTime || 0),
    angle: Math.atan2(unit.y, unit.x),
    radius: safeDistance,
    initialRadius: safeDistance,
    captureRadius,
    rotations,
    angularVelocity,
    decayRate: (safeDistance - captureRadius) / lifetime,
    wobble: Math.min(10, Math.max(1.5, safeDistance * 0.018)) * (0.35 + randomUnitForBallId(ballId, 'wobble') * 0.65),
    wobblePhase: randomUnitForBallId(ballId, 'phase') * Math.PI * 2,
  };
}

function sampleBlackHoleOrbitPoint(orbit, blackHole, elapsed) {
  const angle = orbit.angle + orbit.angularVelocity * elapsed;
  const rawRadius = orbit.radius - orbit.decayRate * elapsed;
  const visibleRadius = Math.max(orbit.captureRadius, rawRadius);
  const progress = 1 - Math.max(0, Math.min(1, (visibleRadius - orbit.captureRadius) / Math.max(1, orbit.initialRadius - orbit.captureRadius)));
  const wobble = Math.sin(angle * 2.3 + orbit.wobblePhase) * orbit.wobble * (1 - progress) * 0.55;
  const radius = Math.max(orbit.captureRadius, visibleRadius + wobble);
  return {
    x: blackHole.x + Math.cos(angle) * radius,
    y: blackHole.y + Math.sin(angle) * radius,
    angle,
    radius,
    rawRadius,
    destroyed: rawRadius <= orbit.captureRadius + 0.2,
  };
}

export function sampleBlackHoleOrbit(orbit = null, blackHoleConfig = null, absoluteTime = 0) {
  const blackHole = activeBlackHole({ blackHole: blackHoleConfig }) || blackHoleConfig;
  if (!orbit?.active || !blackHole) return null;
  const elapsed = Math.max(0, Number(absoluteTime || 0) - Number(orbit.startedAt || 0));
  const point = sampleBlackHoleOrbitPoint(orbit, blackHole, elapsed);
  const delta = 1 / 240;
  const previous = sampleBlackHoleOrbitPoint(orbit, blackHole, Math.max(0, elapsed - delta));
  const next = sampleBlackHoleOrbitPoint(orbit, blackHole, elapsed + delta);
  return {
    ...point,
    vx: (next.x - previous.x) / (elapsed < delta ? delta : delta * 2),
    vy: (next.y - previous.y) / (elapsed < delta ? delta : delta * 2),
    elapsed,
  };
}

export function applyBlackHoleOrbitToBall(ball, orbit = null, blackHoleConfig = null, absoluteTime = 0) {
  const sample = sampleBlackHoleOrbit(orbit, blackHoleConfig, absoluteTime);
  if (!ball || !sample) return false;
  ball.x = sample.x;
  ball.y = sample.y;
  ball.vx = sample.vx;
  ball.vy = sample.vy;
  return sample.destroyed;
}

export function blackHoleAccelerationAt(point, blackHoleConfig = null) {
  const blackHole = activeBlackHole({ blackHole: blackHoleConfig });
  if (!blackHole || blackHole.strength <= 0) return { x: 0, y: 0 };
  const dx = blackHole.x - point.x;
  const dy = blackHole.y - point.y;
  const softening = blackHole.softeningRadius;
  const distanceSquared = dx * dx + dy * dy + softening * softening;
  const scale = blackHole.strength / Math.pow(distanceSquared, 1.5);
  return {
    x: dx * scale,
    y: dy * scale,
  };
}

export function accelerationAtPoint(point, gravity = { x: 0, y: 0 }) {
  const base = {
    x: gravity.x || 0,
    y: gravity.y || 0,
  };
  const blackHole = activeBlackHole(gravity);
  if (!blackHole) return base;
  const well = blackHoleAccelerationAt(point, blackHole);
  return {
    x: base.x + well.x,
    y: base.y + well.y,
  };
}

function blackHoleCaptureRadius(ball, blackHole) {
  return Math.max(0, Number(blackHole?.eventHorizonRadius || 0)) + Math.max(0, Number(ball?.radius || 0));
}

function checkBlackHoleCapture(ball, blackHole, onCapture = null) {
  if (!ball || !blackHole || blackHole.eventHorizonRadius <= 0 || ball.blackHoleCaptured) return false;
  const dx = ball.x - blackHole.x;
  const dy = ball.y - blackHole.y;
  const distance = Math.hypot(dx, dy);
  const captureRadius = blackHoleCaptureRadius(ball, blackHole);
  if (distance > captureRadius) return false;

  ball.blackHoleCaptured = true;
  ball.vx = 0;
  ball.vy = 0;
  onCapture?.({
    ball,
    blackHole,
    x: ball.x,
    y: ball.y,
    distance,
    captureRadius,
  });
  return true;
}

function fieldStepSize(duration, options = {}) {
  const requested = Number(options.fieldStep ?? options.maxFieldStep ?? 1 / 180);
  const maxStep = Number.isFinite(requested) && requested > 0 ? requested : 1 / 180;
  const maxSteps = Math.max(1, Math.round(Number(options.fieldMaxSteps ?? 360)));
  return Math.max(duration / maxSteps, maxStep);
}

function integrateFieldStep(state, dt, gravity = { x: 0, y: 0 }) {
  const a0 = accelerationAtPoint(state, gravity);
  state.x += state.vx * dt + 0.5 * a0.x * dt * dt;
  state.y += state.vy * dt + 0.5 * a0.y * dt * dt;
  const a1 = accelerationAtPoint(state, gravity);
  state.vx += 0.5 * (a0.x + a1.x) * dt;
  state.vy += 0.5 * (a0.y + a1.y) * dt;
  return state;
}

export function simulateFieldState(start, velocity, duration, gravity = { x: 0, y: 0 }, options = {}) {
  const state = {
    x: start.x,
    y: start.y,
    vx: velocity.x,
    vy: velocity.y,
  };
  if (duration <= 0) return state;
  const maxStep = fieldStepSize(duration, options);
  let elapsed = 0;
  let guard = 0;
  while (elapsed < duration - 1e-12 && guard < 20000) {
    guard += 1;
    const dt = Math.min(maxStep, duration - elapsed);
    integrateFieldStep(state, dt, gravity);
    elapsed += dt;
  }
  return state;
}

export function simulateFieldPosition(start, velocity, duration, gravity = { x: 0, y: 0 }, options = {}) {
  const state = simulateFieldState(start, velocity, duration, gravity, options);
  return { x: state.x, y: state.y };
}

export function fieldPathSamples(start, velocity, duration, gravity = { x: 0, y: 0 }, samples = 12, options = {}) {
  const count = Math.max(1, Math.round(samples));
  const points = [{ x: start.x, y: start.y }];
  const state = {
    x: start.x,
    y: start.y,
    vx: velocity.x,
    vy: velocity.y,
  };
  const sampleStep = duration / count;
  const maxStep = Math.min(sampleStep, fieldStepSize(duration, options));
  let elapsed = 0;

  for (let sample = 1; sample <= count; sample += 1) {
    const targetTime = sample * sampleStep;
    let guard = 0;
    while (elapsed < targetTime - 1e-12 && guard < 20000) {
      guard += 1;
      const dt = Math.min(maxStep, targetTime - elapsed);
      integrateFieldStep(state, dt, gravity);
      elapsed += dt;
    }
    points.push({ x: state.x, y: state.y });
  }
  return points;
}

export function createBall({ id = '', x = 0, y = 0, vx = 0, vy = 0, radius = 7, color = '#fff', trackId = 0 } = {}) {
  return {
    id,
    x,
    y,
    vx,
    vy,
    radius,
    color,
    trackId,
    armedSegmentId: null,
    sleep: false,
    spawned: true,
    retired: false,
    retireOnNextCollision: false,
    blackHoleOrbit: null,
    blackHoleCaptured: false,
    blackHoleDestroyed: false,
  };
}

export function reflectVelocity(velocity, normal, restitution = 0.92, tangentRetention = 0.996) {
  const normalLength = Math.hypot(normal.x, normal.y);
  if (!Number.isFinite(normalLength) || normalLength <= 0) {
    return { x: velocity.x, y: velocity.y };
  }
  const nx = normal.x / normalLength;
  const ny = normal.y / normalLength;
  const vn = velocity.x * nx + velocity.y * ny;
  const tx = velocity.x - vn * nx;
  const ty = velocity.y - vn * ny;
  return {
    x: tx * tangentRetention - vn * restitution * nx,
    y: ty * tangentRetention - vn * restitution * ny,
  };
}

export function stepBallInCircle(ball, dt, arena, gravity = { x: 0, y: 0 }, onCollision = () => {}, options = {}) {
  const restitution = options.restitution ?? 0.92;
  const tangentRetention = options.tangentRetention ?? 0.996;
  const drag = options.drag ?? 0.000;
  const blackHole = activeBlackHole(gravity) || activeBlackHole(options);
  const onBlackHoleCapture = typeof options.onBlackHoleCapture === 'function' ? options.onBlackHoleCapture : null;

  if (blackHole && checkBlackHoleCapture(ball, blackHole, onBlackHoleCapture)) return ball;

  if (blackHole && dt > 0) {
    const maxStep = fieldStepSize(dt, options);
    let elapsed = 0;
    let guard = 0;
    while (elapsed < dt - 1e-12 && guard < 10000) {
      guard += 1;
      const subDt = Math.min(maxStep, dt - elapsed);
      integrateBallStepInCircle(ball, subDt, arena, { ...gravity, blackHole }, onCollision, { restitution, tangentRetention, drag, onBlackHoleCapture });
      elapsed += subDt;
      if (ball.blackHoleCaptured) break;
    }
    return ball;
  }

  const ax = gravity.x || 0;
  const ay = gravity.y || 0;
  ball.x += ball.vx * dt + 0.5 * ax * dt * dt;
  ball.y += ball.vy * dt + 0.5 * ay * dt * dt;
  ball.vx += ax * dt;
  ball.vy += ay * dt;
  applyDrag(ball, dt, drag);
  if (blackHole && checkBlackHoleCapture(ball, blackHole, onBlackHoleCapture)) return ball;
  resolveCircleCollision(ball, arena, onCollision, restitution, tangentRetention);

  return ball;
}

function applyDrag(ball, dt, drag = 0) {
  if (drag <= 0) return;
  const damping = Math.max(0, 1 - drag * dt);
  ball.vx *= damping;
  ball.vy *= damping;
}

function resolveCircleCollision(ball, arena, onCollision, restitution, tangentRetention) {
  const dx = ball.x - arena.cx;
  const dy = ball.y - arena.cy;
  const dist = Math.hypot(dx, dy) || 1;
  const limit = arena.radius - ball.radius;

  if (dist > limit) {
    const normal = { x: dx / dist, y: dy / dist };
    ball.x = arena.cx + normal.x * limit;
    ball.y = arena.cy + normal.y * limit;
    const outwardSpeed = ball.vx * normal.x + ball.vy * normal.y;
    if (outwardSpeed > 0) {
      const reflected = reflectVelocity({ x: ball.vx, y: ball.vy }, normal, restitution, tangentRetention);
      ball.vx = reflected.x;
      ball.vy = reflected.y;
      onCollision({
        ball,
        x: ball.x,
        y: ball.y,
        normal,
        speed: Math.hypot(ball.vx, ball.vy),
      });
    }
  }
}

function integrateBallStepInCircle(ball, dt, arena, gravity, onCollision, options) {
  integrateFieldStep(ball, dt, gravity);
  applyDrag(ball, dt, options.drag);
  const blackHole = activeBlackHole(gravity);
  if (blackHole && checkBlackHoleCapture(ball, blackHole, options.onBlackHoleCapture)) return ball;
  resolveCircleCollision(ball, arena, onCollision, options.restitution, options.tangentRetention);
  return ball;
}

export function ballisticPathSamples(start, velocity, duration, gravity, samples = 12) {
  const points = [];
  for (let i = 0; i <= samples; i += 1) {
    points.push(simulatePosition(start, velocity, (duration * i) / samples, gravity));
  }
  return points;
}

export function trajectoryPathSamples(segment, currentTime, gravity = { x: 0, y: 0 }, samples = 12) {
  const elapsed = Math.max(0, Math.min(segment.duration || 0, currentTime - segment.launchTime));
  const remaining = Math.max(0, (segment.duration || 0) - elapsed);
  const start = simulatePosition(segment.start, segment.velocity, elapsed, gravity);
  const velocity = {
    x: segment.velocity.x + (gravity.x || 0) * elapsed,
    y: segment.velocity.y + (gravity.y || 0) * elapsed,
  };
  return ballisticPathSamples(start, velocity, remaining, gravity, samples);
}
