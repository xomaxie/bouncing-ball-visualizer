export const PLAYBACK_PHYSICS_OPTIONS = Object.freeze({ restitution: 0.90, tangentRetention: 0.990, drag: 0 });

export function simulatePosition(start, velocity, duration, gravity = { x: 0, y: 0 }) {
  return {
    x: start.x + velocity.x * duration + 0.5 * (gravity.x || 0) * duration * duration,
    y: start.y + velocity.y * duration + 0.5 * (gravity.y || 0) * duration * duration,
  };
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

  const ax = gravity.x || 0;
  const ay = gravity.y || 0;
  ball.x += ball.vx * dt + 0.5 * ax * dt * dt;
  ball.y += ball.vy * dt + 0.5 * ay * dt * dt;
  ball.vx += ax * dt;
  ball.vy += ay * dt;
  if (drag > 0) {
    const damping = Math.max(0, 1 - drag * dt);
    ball.vx *= damping;
    ball.vy *= damping;
  }

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
