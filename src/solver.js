import {
  createAdaptivePitchRange,
  insetPoint,
  personalityForTrack,
  pitchToWallTarget,
  summarizeTracks,
  wallColorForTarget,
} from './music.js?v=20260505-adaptive-octaves-v2';
import { createEnergyProfile, dynamicSolverOptionsForEnergy, energyAtTime } from './energy.js';
import {
  activeBlackHole,
  ballisticPathSamples,
  createBall,
  fieldPathSamples,
  reflectVelocity,
  simulateFieldState,
  stepBallInCircle,
  PLAYBACK_PHYSICS_OPTIONS,
} from './physics.js?v=20260505-black-hole-waiting-room-v1';

export const DEFAULT_SOLVER_OPTIONS = {
  ballRadius: 8,
  gravityY: 160,
  minFlightTime: 0.28,
  preferredFlightTime: 0.82,
  recoveryTime: 0.06,
  maxSpeed: 1550,
  pathSamples: 14,
  trackStagger: 0.37,
  maxSameHemisphereDot: 0,
  allowSameWallReturnArcs: true,
  sameWallReturnMaxArc: 0.035,
  sameWallReturnMinNormalY: 0.55,
  sameWallReturnMinFlightTime: 0.42,
  sameWallReturnGravityMultiplier: 1.85,
  sameWallReturnMinBounceRiseRatio: 0.24,
  sameWallReturnMaxGravityY: 4200,
  idleStep: 1 / 120,
  retargetAtWallOnly: true,
  wallLaunchTolerance: 1.25,
  maxWallLaunchContacts: 6,
  wallRetargetEpsilon: 1e-6,
  spawnPreferredFlightTime: 0.32,
  spawnMaxFlightTime: 0.42,
  spawnVisibilityPenalty: 1100,
  blackHoleEmitterMargin: 2.5,
  reusableCandidateLimit: 18,
  recycleFallbackCandidateLimit: 48,
  recycleFallbackMinGap: 0.6,
  largeTrackNoteThreshold: 240,
  largeTrackReusableCandidateLimit: 8,
  largeTrackRecycleFallbackCandidateLimit: 24,
  energyAdaptive: false,
  energyThreshold: 0.52,
  adaptivePitchRange: true,
  pitchRangePaddingSemitones: 3,
  minimumPitchSpanSemitones: 36,
  excludeDrumsFromPitchRange: false,
  blackHole: null,
  blackHoleSolveTolerancePx: 2.5,
  blackHoleSolveIterations: 8,
  fieldStep: 1 / 180,
  fieldMaxSteps: 320,
};

export function planFlight(start, target, launchTime, arrivalTime, options = {}) {
  const opts = { ...DEFAULT_SOLVER_OPTIONS, ...options };
  const duration = arrivalTime - launchTime;
  const gravity = { x: opts.gravityX || 0, y: opts.gravityY || 0, blackHole: activeBlackHole(opts) };

  if (duration < 0) {
    return { feasible: false, reason: 'negative-duration', launchTime, arrivalTime, duration, velocity: { x: 0, y: 0 }, speed: 0 };
  }

  if (duration === 0) {
    return {
      feasible: true,
      reason: 'spawn-on-target',
      launchTime,
      arrivalTime,
      duration,
      velocity: { x: 0, y: 0 },
      speed: 0,
      gravity,
    };
  }

  if (gravity.blackHole) {
    return planFieldFlight(start, target, launchTime, arrivalTime, opts, gravity);
  }

  const velocity = {
    x: (target.x - start.x - 0.5 * gravity.x * duration * duration) / duration,
    y: (target.y - start.y - 0.5 * gravity.y * duration * duration) / duration,
  };
  const speed = Math.hypot(velocity.x, velocity.y);
  const feasible = duration >= (opts.minFlightTime ?? 0) && speed <= opts.maxSpeed;
  return {
    feasible,
    reason: feasible ? 'ok' : duration < opts.minFlightTime ? 'too-soon' : 'too-fast',
    launchTime,
    arrivalTime,
    duration,
    velocity,
    speed,
    gravity,
  };
}

function planFieldFlight(start, target, launchTime, arrivalTime, options, gravity) {
  const duration = arrivalTime - launchTime;
  const tolerance = Math.max(0.25, Number(options.blackHoleSolveTolerancePx ?? DEFAULT_SOLVER_OPTIONS.blackHoleSolveTolerancePx));
  const iterations = Math.max(1, Math.round(Number(options.blackHoleSolveIterations ?? DEFAULT_SOLVER_OPTIONS.blackHoleSolveIterations)));
  let velocity = {
    x: (target.x - start.x - 0.5 * (gravity.x || 0) * duration * duration) / duration,
    y: (target.y - start.y - 0.5 * (gravity.y || 0) * duration * duration) / duration,
  };
  let best = null;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const arrivedState = simulateFieldState(start, velocity, duration, gravity, options);
    const error = {
      x: arrivedState.x - target.x,
      y: arrivedState.y - target.y,
    };
    const missDistance = Math.hypot(error.x, error.y);
    const speed = Math.hypot(velocity.x, velocity.y);
    const candidate = {
      velocity: { x: velocity.x, y: velocity.y },
      arrivalVelocity: { x: arrivedState.vx, y: arrivedState.vy },
      speed,
      missDistance,
      iteration,
    };
    if (!best || missDistance < best.missDistance) best = candidate;
    if (missDistance <= tolerance) break;

    const correctionGain = iteration < 3 ? 0.92 : 0.68;
    velocity = {
      x: velocity.x - (error.x / duration) * correctionGain,
      y: velocity.y - (error.y / duration) * correctionGain,
    };
  }

  const speed = best?.speed ?? Math.hypot(velocity.x, velocity.y);
  const missDistance = best?.missDistance ?? Infinity;
  const feasible = duration >= (options.minFlightTime ?? 0)
    && speed <= options.maxSpeed
    && missDistance <= tolerance;
  return {
    feasible,
    reason: feasible ? 'ok' : duration < options.minFlightTime ? 'too-soon' : speed > options.maxSpeed ? 'too-fast' : 'missed-target',
    field: 'black-hole',
    launchTime,
    arrivalTime,
    duration,
    velocity: best?.velocity ?? velocity,
    arrivalVelocity: best?.arrivalVelocity ?? velocity,
    speed,
    missDistance,
    gravity,
  };
}

export function pathFitsArena(start, velocity, duration, arena, options = {}) {
  const opts = { ...DEFAULT_SOLVER_OPTIONS, ...options };
  const gravity = { x: opts.gravityX || 0, y: opts.gravityY || 0, blackHole: activeBlackHole(opts) };
  const samples = gravity.blackHole
    ? fieldPathSamples(start, velocity, duration, gravity, opts.pathSamples, opts)
    : ballisticPathSamples(start, velocity, duration, gravity, opts.pathSamples);
  const limit = arena.radius - opts.ballRadius;
  const horizonLimit = gravity.blackHole
    ? (Number(gravity.blackHole.eventHorizonRadius || 0) + Number(opts.ballRadius || 0))
    : 0;
  return samples.every((point, index) => {
    if (index === samples.length - 1) return true;
    if (Math.hypot(point.x - arena.cx, point.y - arena.cy) > limit + 1e-6) return false;
    if (horizonLimit > 0 && Math.hypot(point.x - gravity.blackHole.x, point.y - gravity.blackHole.y) <= horizonLimit) return false;
    return true;
  });
}

function launchWindow(noteTime, availableAt, options) {
  const availableDuration = noteTime - availableAt;
  if (availableDuration < options.minFlightTime) return null;
  const duration = Math.min(options.preferredFlightTime, availableDuration);
  return {
    launchTime: noteTime - duration,
    duration,
  };
}

function createSeedStart(ballIndex, trackIndex, arena) {
  const angle = ballIndex * 2.399963229728653 + trackIndex * 0.71;
  const radius = arena.radius * (0.12 + (ballIndex % 4) * 0.035);
  return {
    x: arena.cx + Math.cos(angle) * radius,
    y: arena.cy + Math.sin(angle) * radius,
  };
}

function wallNormal(point, arena) {
  const dx = point.x - arena.cx;
  const dy = point.y - arena.cy;
  const dist = Math.hypot(dx, dy) || 1;
  return { x: dx / dist, y: dy / dist };
}

function clonePoint(point) {
  return { x: point.x, y: point.y };
}

function cloneSpawnPoint(point) {
  const cloned = clonePoint(point);
  if (point?.spawnSource) cloned.spawnSource = point.spawnSource;
  return cloned;
}

function blackHoleEmitterPoints(wallTarget, arena, options = {}) {
  const opts = { ...DEFAULT_SOLVER_OPTIONS, ...options };
  const blackHole = activeBlackHole(opts);
  if (!blackHole || blackHole.eventHorizonRadius <= 0) return [];
  const dx = wallTarget.x - blackHole.x;
  const dy = wallTarget.y - blackHole.y;
  const distance = Math.hypot(dx, dy) || 1;
  const baseAngle = Math.atan2(dy, dx);
  const rimRadius = blackHole.eventHorizonRadius + opts.ballRadius + Math.max(0.5, Number(opts.blackHoleEmitterMargin ?? 2.5));
  const offsets = [0, 0.32, -0.32];
  return offsets.map((offset) => ({
    x: blackHole.x + Math.cos(baseAngle + offset) * rimRadius,
    y: blackHole.y + Math.sin(baseAngle + offset) * rimRadius,
    spawnSource: 'black-hole',
  })).filter((point) => Math.hypot(point.x - arena.cx, point.y - arena.cy) < arena.radius - opts.ballRadius);
}

function predictStateAt(state, targetTime, arena, options) {
  const opts = { ...DEFAULT_SOLVER_OPTIONS, ...options };
  const startTime = state?.time ?? 0;
  if (!state || targetTime <= startTime) {
    return {
      time: targetTime,
      x: state?.x ?? arena.cx,
      y: state?.y ?? arena.cy,
      vx: state?.vx ?? 0,
      vy: state?.vy ?? 0,
    };
  }

  const ball = createBall({
    x: state.x,
    y: state.y,
    vx: state.vx,
    vy: state.vy,
    radius: opts.ballRadius,
  });
  const gravity = { x: opts.gravityX || 0, y: opts.gravityY || 0, blackHole: activeBlackHole(opts) };
  const fixedStep = opts.idleStep || (1 / 120);
  let time = startTime;
  while (time < targetTime - 1e-9) {
    const dt = Math.min(fixedStep, targetTime - time);
    stepBallInCircle(ball, dt, arena, gravity, () => {}, PLAYBACK_PHYSICS_OPTIONS);
    time += dt;
  }

  return {
    time: targetTime,
    x: ball.x,
    y: ball.y,
    vx: ball.vx,
    vy: ball.vy,
  };
}

function isAtPlayableWall(point, arena, options) {
  const opts = { ...DEFAULT_SOLVER_OPTIONS, ...options };
  const limit = arena.radius - opts.ballRadius;
  const distance = Math.hypot(point.x - arena.cx, point.y - arena.cy);
  return Math.abs(distance - limit) <= (opts.wallLaunchTolerance ?? 1.25);
}

function predictWallLaunches(state, earliestLaunchTime, latestLaunchTime, arena, options) {
  const opts = { ...DEFAULT_SOLVER_OPTIONS, ...options };
  if (!state || latestLaunchTime < earliestLaunchTime - 1e-9) return [];

  const launches = [];
  const gravity = { x: opts.gravityX || 0, y: opts.gravityY || 0, blackHole: activeBlackHole(opts) };
  const ball = createBall({
    x: state.x,
    y: state.y,
    vx: state.vx,
    vy: state.vy,
    radius: opts.ballRadius,
  });
  const fixedStep = opts.idleStep || (1 / 120);
  const maxContacts = opts.maxWallLaunchContacts ?? 6;
  let time = state.time ?? 0;

  if (time >= earliestLaunchTime - 1e-9 && time <= latestLaunchTime + 1e-9 && isAtPlayableWall(ball, arena, opts)) {
    launches.push({
      time,
      start: { x: ball.x, y: ball.y },
    });
  }

  let guard = 0;
  while (time < latestLaunchTime - 1e-9 && guard < 20000 && launches.length < maxContacts) {
    guard += 1;
    const dt = Math.min(fixedStep, latestLaunchTime - time);
    let collision = null;
    stepBallInCircle(ball, dt, arena, gravity, (hit) => {
      collision = hit;
    }, PLAYBACK_PHYSICS_OPTIONS);
    time += dt;

    if (!collision || time < earliestLaunchTime - 1e-9) continue;
    launches.push({
      time,
      start: { x: collision.x, y: collision.y },
    });
  }

  return launches;
}

function stateAfterScheduledHit(wallTarget, centerTarget, velocity, duration, arrivalTime, arena, options) {
  const opts = { ...DEFAULT_SOLVER_OPTIONS, ...options };
  const normal = wallNormal(wallTarget, arena);
  const incoming = opts.arrivalVelocity || {
    x: velocity.x + (opts.gravityX || 0) * duration,
    y: velocity.y + (opts.gravityY || 0) * duration,
  };
  const reflected = reflectVelocity(incoming, normal, 0.92, 0.992);
  return {
    time: arrivalTime,
    x: centerTarget.x,
    y: centerTarget.y,
    vx: reflected.x,
    vy: reflected.y,
  };
}

export function wallTransitionIsPlausible(previousTarget, nextTarget, arena, options = {}) {
  if (!previousTarget || !nextTarget) return true;
  const opts = { ...DEFAULT_SOLVER_OPTIONS, ...options };
  const previous = wallNormal(previousTarget, arena);
  const next = wallNormal(nextTarget, arena);
  const dot = previous.x * next.x + previous.y * next.y;
  return dot <= (opts.maxSameHemisphereDot ?? 0) + 1e-9;
}

function sameWallReturnIsPlausible(launchStart, nextTarget, flight, arena, options = {}) {
  if (!launchStart || !nextTarget || !flight?.feasible) return false;
  const opts = { ...DEFAULT_SOLVER_OPTIONS, ...options };
  if (opts.allowSameWallReturnArcs === false) return false;
  if (Math.abs(opts.gravityY || 0) <= 1e-6) return false;
  if (flight.duration < (opts.sameWallReturnMinFlightTime ?? 0.42)) return false;

  const launch = wallNormal(launchStart, arena);
  const next = wallNormal(nextTarget, arena);
  const minNormalY = Number(opts.sameWallReturnMinNormalY ?? DEFAULT_SOLVER_OPTIONS.sameWallReturnMinNormalY);
  if (launch.y < minNormalY || next.y < minNormalY) return false;

  const dot = Math.max(-1, Math.min(1, launch.x * next.x + launch.y * next.y));
  const arc = Math.acos(dot);
  return arc <= (opts.sameWallReturnMaxArc ?? 0.035) + 1e-9;
}

function sameWallReturnGravityY(options, duration, arena) {
  const opts = { ...DEFAULT_SOLVER_OPTIONS, ...options };
  const baseGravity = Math.abs(Number(opts.gravityY || 0));
  const multiplierGravity = baseGravity * Number(opts.sameWallReturnGravityMultiplier ?? 1);
  const minRise = Math.max(0, Number(opts.sameWallReturnMinBounceRisePx ?? 0))
    || Math.max(0, Number(opts.sameWallReturnMinBounceRiseRatio ?? 0)) * (arena?.radius || 0);
  const bounceGravity = duration > 0 ? (8 * minRise) / (duration * duration) : multiplierGravity;
  const maxGravity = Math.max(multiplierGravity, Number(opts.sameWallReturnMaxGravityY ?? Infinity));
  const boosted = Math.max(multiplierGravity, bounceGravity);
  return Math.min(boosted, maxGravity);
}

function launchTransitionIsPlausible(launchStart, previousTarget, nextTarget, flight, arena, options = {}) {
  if (wallTransitionIsPlausible(launchStart || previousTarget, nextTarget, arena, options)) return true;
  return sameWallReturnIsPlausible(launchStart, nextTarget, flight, arena, options);
}

function isSameWallReturnCandidate(launchStart, previousTarget, nextTarget, flight, arena, options = {}) {
  if (wallTransitionIsPlausible(launchStart || previousTarget, nextTarget, arena, options)) return false;
  return sameWallReturnIsPlausible(launchStart, nextTarget, flight, arena, options);
}

function targetCandidatesForNote(note, arena, noteIndex, trackId, options) {
  const preferredPhase = noteIndex + (trackId || 0) * options.trackStagger;
  const phases = [preferredPhase, preferredPhase + 1];
  const seen = new Set();
  return phases.map((phase) => pitchToWallTarget(note.midi, arena, phase, options)).filter((target) => {
    const key = `${target.x.toFixed(6)}:${target.y.toFixed(6)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function reusableCandidateLimitForTrack(noteCount, options) {
  const requested = Math.max(1, options.reusableCandidateLimit ?? DEFAULT_SOLVER_OPTIONS.reusableCandidateLimit);
  const largeThreshold = options.largeTrackNoteThreshold ?? DEFAULT_SOLVER_OPTIONS.largeTrackNoteThreshold;
  if (noteCount >= largeThreshold) {
    return Math.max(1, Math.min(requested, options.largeTrackReusableCandidateLimit ?? requested));
  }
  return requested;
}

function recycleFallbackCandidateLimitForTrack(noteCount, options) {
  const requested = Math.max(0, options.recycleFallbackCandidateLimit ?? DEFAULT_SOLVER_OPTIONS.recycleFallbackCandidateLimit);
  const largeThreshold = options.largeTrackNoteThreshold ?? DEFAULT_SOLVER_OPTIONS.largeTrackNoteThreshold;
  if (noteCount >= largeThreshold) {
    return Math.max(0, Math.min(requested, options.largeTrackRecycleFallbackCandidateLimit ?? requested));
  }
  return requested;
}

function createPlanBlackHole(arena, options = {}) {
  const config = options.blackHole;
  if (!config || config.enabled === false) return null;
  const radius = Math.max(5, Number(config.radius ?? arena.radius * 0.045));
  const x = Number.isFinite(Number(config.x))
    ? Number(config.x)
    : arena.cx + Number(config.offsetX ?? 0) * arena.radius;
  const y = Number.isFinite(Number(config.y))
    ? Number(config.y)
    : arena.cy + Number(config.offsetY ?? 0) * arena.radius;
  return {
    enabled: true,
    x,
    y,
    radius,
    strength: Math.max(0, Number(config.strength ?? arena.radius * arena.radius * 12)),
    softeningRadius: Math.max(radius * 1.8, Number(config.softeningRadius ?? radius * 4.6)),
    eventHorizonRadius: Math.max(radius * 0.72, Number(config.eventHorizonRadius ?? radius * 1.05)),
    label: config.label || 'gravity well',
  };
}

function uniqueNumbers(values) {
  const seen = new Set();
  return values.filter((value) => {
    const rounded = Number(value.toFixed(6));
    if (!Number.isFinite(rounded) || seen.has(rounded)) return false;
    seen.add(rounded);
    return true;
  });
}

function uniquePoints(points) {
  const seen = new Set();
  return points.filter((point) => {
    const key = `${point.x.toFixed(6)}:${point.y.toFixed(6)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function spawnFlightCandidates(seed, wallTarget, target, noteTime, arena, options) {
  const opts = { ...DEFAULT_SOLVER_OPTIONS, ...options };
  const candidates = [];
  const maxDuration = Math.max(0, noteTime);
  const spawnPreferred = Math.max(opts.minFlightTime, opts.spawnPreferredFlightTime ?? opts.minFlightTime);
  const spawnMax = Math.max(spawnPreferred, opts.spawnMaxFlightTime ?? spawnPreferred);
  const hasBlackHole = Boolean(activeBlackHole(opts));
  const stagedPoints = hasBlackHole
    ? [
      seed,
      insetPoint(wallTarget, arena, Math.min(arena.radius - opts.ballRadius, opts.ballRadius + arena.radius * 0.28)),
      insetPoint(wallTarget, arena, Math.min(arena.radius - opts.ballRadius, opts.ballRadius + arena.radius * 0.48)),
    ]
    : [
      seed,
      { x: arena.cx, y: arena.cy },
      insetPoint(wallTarget, arena, Math.min(arena.radius - opts.ballRadius, opts.ballRadius + arena.radius * 0.28)),
      insetPoint(wallTarget, arena, Math.min(arena.radius - opts.ballRadius, opts.ballRadius + arena.radius * 0.48)),
    ];
  const startPoints = uniquePoints([
    ...blackHoleEmitterPoints(wallTarget, arena, opts),
    ...stagedPoints,
  ]);

  if (maxDuration >= opts.minFlightTime) {
    const durations = uniqueNumbers([
      Math.min(spawnPreferred, maxDuration),
      opts.minFlightTime,
      Math.min(spawnMax, maxDuration),
      Math.min(opts.preferredFlightTime, maxDuration),
    ]).filter((duration) => duration >= opts.minFlightTime && duration <= maxDuration);

    for (const duration of durations) {
      const launchTime = noteTime - duration;
      for (const start of startPoints) {
        const flight = planFlight(start, target, launchTime, noteTime, opts);
        if (!flight.feasible) continue;
        if (!pathFitsArena(start, flight.velocity, flight.duration, arena, opts)) continue;
        const longLoiterPenalty = Math.max(0, flight.duration - spawnMax) * opts.maxSpeed * 8;
        const spawnSource = start.spawnSource || (start === seed ? 'seed' : 'staged');
        const sourcePenalty = spawnSource === 'black-hole'
          ? -160
          : hasBlackHole ? 260 : (start === seed ? 0 : 45);
        candidates.push({
          start: cloneSpawnPoint(start),
          spawnSource,
          flight,
          score: flight.speed * 0.55 + flight.duration * opts.spawnVisibilityPenalty + longLoiterPenalty + sourcePenalty,
        });
      }
    }
  }

  const zeroFlight = planFlight(target, target, noteTime, noteTime, opts);
  candidates.push({
    start: clonePoint(target),
    spawnSource: 'target',
    flight: zeroFlight,
    score: opts.maxSpeed * 4,
  });

  return candidates;
}

function optionsForNote(baseOptions, noteTime) {
  if (!baseOptions?.energyProfile) {
    return {
      options: baseOptions,
      energy: { energy: 0, intensity: 0, level: 'low' },
    };
  }
  const energy = energyAtTime(baseOptions.energyProfile, noteTime);
  return {
    options: dynamicSolverOptionsForEnergy(baseOptions, energy),
    energy,
  };
}

function optionsWithPersonality(options, personality = {}) {
  const baseRadius = Number(options.ballRadius ?? DEFAULT_SOLVER_OPTIONS.ballRadius);
  const baseGravity = Number(options.gravityY ?? DEFAULT_SOLVER_OPTIONS.gravityY);
  const baseMaxSpeed = Number(options.maxSpeed ?? DEFAULT_SOLVER_OPTIONS.maxSpeed);
  return {
    ...options,
    ballRadius: Math.max(4, baseRadius * Number(personality.radiusScale ?? 1)),
    gravityY: baseGravity * Number(personality.gravityScale ?? 1),
    maxSpeed: baseMaxSpeed * Number(personality.maxSpeedScale ?? 1),
  };
}

export function planTrack(track, arena, options = {}) {
  const opts = { ...DEFAULT_SOLVER_OPTIONS, ...options };
  const notes = [...(track.notes || [])].sort((a, b) => a.time - b.time || a.midi - b.midi);
  const personality = personalityForTrack({ ...track, notes });
  const trackOpts = optionsWithPersonality(opts, personality);
  const balls = [];
  const segments = [];
  const effectiveReusableCandidateLimit = reusableCandidateLimitForTrack(notes.length, trackOpts);
  const effectiveRecycleFallbackCandidateLimit = recycleFallbackCandidateLimitForTrack(notes.length, trackOpts);
  const planningStats = {
    notes: notes.length,
    reusableCandidateLimit: effectiveReusableCandidateLimit,
    recycleFallbackCandidateLimit: effectiveRecycleFallbackCandidateLimit,
    requestedReusableCandidateLimit: trackOpts.reusableCandidateLimit,
    maxReusableCandidatesConsidered: 0,
    totalReusableCandidatesConsidered: 0,
    maxRecycleFallbackCandidatesConsidered: 0,
    recycleFallbackCandidatesConsidered: 0,
  };

  notes.forEach((note, noteIndex) => {
    const { options: noteOpts, energy } = optionsForNote(trackOpts, note.time);
    const targetCandidates = targetCandidatesForNote(note, arena, noteIndex, track.id ?? 0, trackOpts);
    let best = null;
    const latestReusableLaunchTime = note.time - noteOpts.minFlightTime;
    const reusableCandidates = balls
      .filter((ball) => ball.state && (!trackOpts.retargetAtWallOnly || ball.availableAt <= latestReusableLaunchTime + 1e-9))
      .sort((a, b) => {
        const recency = (b.availableAt ?? 0) - (a.availableAt ?? 0);
        if (Math.abs(recency) > 1e-9) return recency;
        return a.events.length - b.events.length;
      })
      .slice(0, Math.max(1, effectiveReusableCandidateLimit));

    planningStats.maxReusableCandidatesConsidered = Math.max(planningStats.maxReusableCandidatesConsidered, reusableCandidates.length);
    planningStats.totalReusableCandidatesConsidered += reusableCandidates.length;

    const evaluateReusableBall = (ball) => {
      const launchCandidates = [];
      if (trackOpts.retargetAtWallOnly) {
        const latestLaunchTime = note.time - noteOpts.minFlightTime;
        if (ball.state && isAtPlayableWall(ball.state, arena, trackOpts)) {
          const launchTime = (ball.state.time ?? 0) + (trackOpts.wallRetargetEpsilon ?? 1e-6);
          if (launchTime <= latestLaunchTime + 1e-9) {
            launchCandidates.push({
              launchTime,
              start: { x: ball.state.x, y: ball.state.y },
            });
          }
        }
        for (const launch of predictWallLaunches(ball.state, ball.availableAt, latestLaunchTime, arena, trackOpts)) {
          launchCandidates.push({
            launchTime: launch.time,
            start: launch.start,
          });
        }
      } else {
        const window = launchWindow(note.time, ball.availableAt, trackOpts);
        if (window) {
          const predictedState = predictStateAt(ball.state, window.launchTime, arena, trackOpts);
          launchCandidates.push({
            launchTime: window.launchTime,
            start: { x: predictedState.x, y: predictedState.y },
          });
        }
      }

      for (const launch of launchCandidates) {
        const start = launch.start;
        for (const wallTarget of targetCandidates) {
          const target = insetPoint(wallTarget, arena, noteOpts.ballRadius);
          let flight = planFlight(start, target, launch.launchTime, note.time, noteOpts);
          if (!flight.feasible) continue;
          const transitionStart = trackOpts.retargetAtWallOnly ? start : ball.lastWallTarget;
          const sameWallReturn = isSameWallReturnCandidate(transitionStart, ball.lastWallTarget, wallTarget, flight, arena, noteOpts);
          if (sameWallReturn) {
            const returnOptions = {
              ...noteOpts,
              gravityY: sameWallReturnGravityY(noteOpts, flight.duration, arena),
            };
            const returnFlight = planFlight(start, target, launch.launchTime, note.time, returnOptions);
            if (!returnFlight.feasible) continue;
            flight = returnFlight;
          }
          if (!launchTransitionIsPlausible(transitionStart, ball.lastWallTarget, wallTarget, flight, arena, noteOpts)) continue;
          const flightOptions = sameWallReturn
            ? { ...noteOpts, gravityY: flight.gravity?.y ?? flight.gravityY ?? noteOpts.gravityY }
            : noteOpts;
          if (!pathFitsArena(start, flight.velocity, flight.duration, arena, flightOptions)) continue;
          const durationPenalty = Math.max(0, flight.duration - noteOpts.preferredFlightTime) * 18;
          const candidate = {
            ball,
            wallTarget,
            target,
            start,
            flight,
            sameWallReturn,
            score: flight.speed + durationPenalty + ball.events.length * 6,
          };
          if (!best || candidate.score < best.score) best = candidate;
        }
      }
    };

    for (const ball of reusableCandidates) {
      evaluateReusableBall(ball);
    }

    const previousNoteTime = notes[noteIndex - 1]?.time ?? -Infinity;
    const isRecycleFallbackWindow = note.time - previousNoteTime >= (trackOpts.recycleFallbackMinGap ?? 0);

    if (!best && isRecycleFallbackWindow && effectiveRecycleFallbackCandidateLimit > 0 && balls.length > reusableCandidates.length) {
      const alreadyConsidered = new Set(reusableCandidates.map((ball) => ball.id));
      const recycleFallbackCandidates = balls
        .filter((ball) => ball.state && !alreadyConsidered.has(ball.id) && ball.availableAt <= latestReusableLaunchTime + 1e-9)
        .sort((a, b) => {
          const useCount = a.events.length - b.events.length;
          if (Math.abs(useCount) > 0) return useCount;
          const age = (a.availableAt ?? 0) - (b.availableAt ?? 0);
          if (Math.abs(age) > 1e-9) return age;
          return a.localIndex - b.localIndex;
        })
        .slice(0, effectiveRecycleFallbackCandidateLimit);

      planningStats.maxRecycleFallbackCandidatesConsidered = Math.max(
        planningStats.maxRecycleFallbackCandidatesConsidered,
        recycleFallbackCandidates.length,
      );
      planningStats.recycleFallbackCandidatesConsidered += recycleFallbackCandidates.length;

      for (const ball of recycleFallbackCandidates) {
        evaluateReusableBall(ball);
        if (best) break;
      }
    }

    if (!best) {
      const ball = {
        id: `${track.id ?? 0}:${balls.length}`,
        localIndex: balls.length,
        trackId: track.id ?? 0,
        trackName: track.name || `Track ${(track.id ?? 0) + 1}`,
        color: track.color,
        personality,
        radius: trackOpts.ballRadius,
        idleGravityY: trackOpts.gravityY,
        events: [],
        availableAt: 0,
        lastTarget: null,
        lastWallTarget: null,
      };
      balls.push(ball);
      const seed = createSeedStart(ball.localIndex, track.id ?? 0, arena);
      for (const wallTarget of targetCandidates) {
        const target = insetPoint(wallTarget, arena, noteOpts.ballRadius);
        for (const spawn of spawnFlightCandidates(seed, wallTarget, target, note.time, arena, noteOpts)) {
          const candidate = { ball, wallTarget, target, start: spawn.start, flight: spawn.flight, spawnSource: spawn.spawnSource, score: spawn.score };
          if (!best || candidate.score < best.score) best = candidate;
        }
      }
    }

    const segment = {
      id: `${track.id ?? 0}:${noteIndex}`,
      trackId: track.id ?? 0,
      trackName: track.name || `Track ${(track.id ?? 0) + 1}`,
      ballId: best.ball.id,
      ballLocalIndex: best.ball.localIndex,
      noteIndex,
      note: { ...note },
      target: best.wallTarget,
      centerTarget: best.target,
      wallColor: wallColorForTarget(best.wallTarget, arena),
      start: best.start,
      launchTime: best.flight.launchTime,
      arrivalTime: note.time,
      duration: best.flight.duration,
      velocity: best.flight.velocity,
      arrivalVelocity: best.flight.arrivalVelocity || null,
      speed: best.flight.speed,
      speedLimit: noteOpts.maxSpeed,
      gravityX: best.flight.gravity?.x ?? noteOpts.gravityX ?? 0,
      gravityY: best.flight.gravity?.y ?? noteOpts.gravityY ?? 0,
      blackHole: best.flight.gravity?.blackHole || noteOpts.blackHole || null,
      flightField: best.flight.field || 'ballistic',
      missDistance: best.flight.missDistance || 0,
      spawnSource: best.spawnSource || (best.ball.events.length ? 'reuse' : 'unknown'),
      idleGravityY: trackOpts.gravityY || 0,
      ballRadius: noteOpts.ballRadius,
      personality,
      sameWallReturn: Boolean(best.sameWallReturn),
      energy: energy.energy,
      energyIntensity: energy.intensity,
      energyLevel: energy.level,
      feasible: best.flight.feasible,
      reason: best.flight.reason,
    };

    best.ball.events.push(segment);
    best.ball.availableAt = note.time + noteOpts.recoveryTime;
    best.ball.lastTarget = best.target;
    best.ball.lastWallTarget = best.wallTarget;
    best.ball.state = stateAfterScheduledHit(best.wallTarget, best.target, best.flight.velocity, best.flight.duration, note.time, arena, {
      ...noteOpts,
      gravityX: best.flight.gravity?.x ?? noteOpts.gravityX ?? 0,
      gravityY: best.flight.gravity?.y ?? noteOpts.gravityY ?? 0,
      blackHole: best.flight.gravity?.blackHole || noteOpts.blackHole || null,
      arrivalVelocity: best.flight.arrivalVelocity || null,
    });
    segments.push(segment);
  });

  return {
    ...track,
    notes,
    balls,
    segments,
    personality,
    ballCount: balls.length,
    first: notes[0]?.time ?? 0,
    last: notes.reduce((max, note) => Math.max(max, note.time + (note.duration || 0)), 0),
    planningStats,
  };
}

export function planSong(tracks, arena, options = {}) {
  const normalized = summarizeTracks(tracks);
  const baseOptions = { ...DEFAULT_SOLVER_OPTIONS, ...options };
  const blackHole = createPlanBlackHole(arena, baseOptions);
  const pitchRange = createAdaptivePitchRange(normalized, baseOptions);
  const energyProfile = options.energyProfile
    || (options.energyAdaptive ? createEnergyProfile(normalized, {
      ...(options.energyProfileOptions || {}),
      threshold: options.energyThreshold ?? DEFAULT_SOLVER_OPTIONS.energyThreshold,
    }) : null);
  const rangeOptions = {
    ...options,
    minMidi: pitchRange.minMidi,
    maxMidi: pitchRange.maxMidi,
    pitchRange,
    blackHole,
  };
  const trackOptions = energyProfile ? { ...rangeOptions, energyProfile } : rangeOptions;
  const plannedTracks = normalized.map((track) => planTrack(track, arena, trackOptions));
  const events = plannedTracks.flatMap((track) => track.segments).sort((a, b) => a.arrivalTime - b.arrivalTime || a.trackId - b.trackId);
  const totalBalls = plannedTracks.reduce((sum, track) => sum + track.ballCount, 0);
  const duration = Math.max(0, ...plannedTracks.map((track) => track.last));
  const planOptions = {
    ...DEFAULT_SOLVER_OPTIONS,
    ...options,
    minMidi: pitchRange.minMidi,
    maxMidi: pitchRange.maxMidi,
  };
  delete planOptions.energyProfile;
  return {
    tracks: plannedTracks,
    events,
    totalBalls,
    duration,
    arena: { ...arena },
    options: planOptions,
    energyProfile,
    pitchRange,
    blackHole,
  };
}
