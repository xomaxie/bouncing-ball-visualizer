import { parseMidiFile, createDemoSong } from './midi.js';
import { analyzeAudioBufferToSong } from './audio-analysis.js';
import {
  analyzeMp3WithPreferredTranscriber,
  transcribeAudioBufferWithBasicPitch,
  transcribeAudioFileWithServerBasicPitch,
} from './basic-pitch-analysis.js';
import { noteName, trackColor, frequencyForMidi, wallColorForTarget } from './music.js?v=20260505-adaptive-octaves-v2';
import { planSong } from './solver.js?v=20260505-perceptual-black-hole-energy-v1';
import { advancePlayback, createPlaybackState } from './playback.js?v=20260504-personality-v1';
import { AudioEngine, soundButtonLabel } from './audio.js';
import { ROYALTY_FREE_SAMPLES, fetchSampleMidi, sampleLabel } from './samples.js';
import { createVisualEffectsState, decayVisualEffects, registerNoteImpact } from './visual-effects.js?v=20260505-disc-light-particles-v1';
import { fieldPathSamples } from './physics.js?v=20260505-perceptual-black-hole-energy-v1';
import {
  advanceBlackHoleParticles,
  blackHoleLightParticleSnapshots,
  blackHoleParticleSnapshots,
  createBlackHoleParticleSystem,
} from './black-hole-particles.js?v=20260505-readable-photon-dust-v1';
import { createPixiLightParticleLayer } from './pixi-light-layer.js?v=20260505-readable-photon-dust-v1';
import { energyAtTime, sceneModeForEnergy } from './energy.js?v=20260504-personality-v1';
import { fetchYoutubeAudio, isLikelyYouTubeUrl } from './youtube-import.js?v=20260505-youtube-import';

const canvas = document.querySelector('#arena');
const canvasFrame = document.querySelector('.canvasFrame');
const ctx = canvas.getContext('2d');
const appShell = document.querySelector('#appShell');
const processingText = document.querySelector('#processingText');
const playBtn = document.querySelector('#playBtn');
const demoBtn = document.querySelector('#demoBtn');
const sampleBtn = document.querySelector('#sampleBtn');
const resetBtn = document.querySelector('#resetBtn');
const mp3ModeBtn = document.querySelector('#mp3ModeBtn');
const speedBtn = document.querySelector('#speedBtn');
const soundBtn = document.querySelector('#soundBtn');
const fileInput = document.querySelector('#midiFile');
const dropZone = document.querySelector('#dropZone');
const sourceName = document.querySelector('#sourceName');
const youtubeForm = document.querySelector('#youtubeForm');
const youtubeUrlInput = document.querySelector('#youtubeUrl');
const youtubeRightsInput = document.querySelector('#youtubeRights');
const youtubeImportBtn = document.querySelector('#youtubeImportBtn');
const gravityInput = document.querySelector('#gravity');
const gravityOut = document.querySelector('#gravityOut');
const maxSpeedInput = document.querySelector('#maxSpeed');
const maxSpeedOut = document.querySelector('#maxSpeedOut');
const trackList = document.querySelector('#trackList');
const eventLog = document.querySelector('#eventLog');
const timeline = document.querySelector('#timeline');
const clockEl = document.querySelector('#clock');
const phaseEl = document.querySelector('#phase');
const ballCountEl = document.querySelector('#ballCount');
const activeBallCountEl = document.querySelector('#activeBallCount');
const noteCountEl = document.querySelector('#noteCount');
const hitCountEl = document.querySelector('#hitCount');
const nextHitEl = document.querySelector('#nextHit');

const audio = new AudioEngine({ enabledByDefault: true });
const DPR = () => Math.max(1, Math.min(2, window.devicePixelRatio || 1));
const fixedStep = 1 / 120;

let W = 0;
let H = 0;
let arena = { cx: 0, cy: 0, radius: 0 };
let song = null;
let sourceLabel = 'Drop a MIDI or MP3';
let plan = null;
let sim = null;
let running = false;
let speedIndex = 1;
let mp3HighAccuracy = true;
let lastFrame = performance.now();
let hitCounter = 0;
let raf = 0;
let arenaRefreshRaf = 0;
let arenaRefreshRebuild = false;
let arenaRefreshResolvers = [];
let visualEffects = createVisualEffectsState({ bandCount: 56 });
let lightCanvas = null;
let lightCtx = null;
let blackHoleParticleSystem = null;
let blackHoleParticleKey = '';
let pixiLightLayer = null;
let pixiLightLayerPromise = null;
let currentSceneMode = sceneModeForEnergy();
let smoothedBlackHoleEnergy = null;
const lightBufferScale = 0.36;
const speedValues = [0.35, 1, 1.75];

function playbackRate() {
  return speedValues[speedIndex];
}

function hasBackingAudio() {
  return Boolean(song?.audioBuffer);
}
function updateMp3ModeButton() {
  if (!mp3ModeBtn) return;
  mp3ModeBtn.textContent = mp3HighAccuracy ? 'MP3: high accuracy' : 'MP3: fast';
  mp3ModeBtn.classList.toggle('active', mp3HighAccuracy);
}


function stopBackingAudio() {
  audio.stopBackingTrack();
}

async function startBackingAudioIfNeeded() {
  if (!hasBackingAudio() || !sim || !running || !audio.enabled) return;
  await audio.armIfEnabled();
  audio.startBackingTrack(song.audioBuffer, sim.time, playbackRate());
}

function isMp3File(file) {
  const name = (file?.name || '').toLowerCase();
  return file?.type === 'audio/mpeg' || file?.type === 'audio/mp3' || name.endsWith('.mp3');
}

function solverOptions() {
  return {
    gravityY: Number(gravityInput.value),
    maxSpeed: Number(maxSpeedInput.value),
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
    blackHole: {
      enabled: true,
      offsetX: 0,
      offsetY: 0,
      radius: Math.max(7, arena.radius * 0.043),
      strength: arena.radius * arena.radius * 92,
      softeningRadius: Math.max(24, arena.radius * 0.115),
      eventHorizonRadius: Math.max(8, arena.radius * 0.045),
    },
  };
}

function resize() {
  const host = canvasFrame || canvas.parentElement;
  const width = host.clientWidth || window.innerWidth || 0;
  const height = host.clientHeight || window.innerHeight || 0;
  const nextW = Math.max(320, Math.floor(width));
  const nextH = Math.max(320, Math.floor(height));
  const dpr = DPR();
  const nextCanvasWidth = Math.floor(nextW * dpr);
  const nextCanvasHeight = Math.floor(nextH * dpr);
  const changed = W !== nextW || H !== nextH || canvas.width !== nextCanvasWidth || canvas.height !== nextCanvasHeight;
  W = nextW;
  H = nextH;
  canvas.width = nextCanvasWidth;
  canvas.height = nextCanvasHeight;
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  arena = { cx: W * 0.5, cy: H * 0.5, radius: Math.min(W, H) * 0.39 };
  if (pixiLightLayer?.ready) pixiLightLayer.resize({ width: W, height: H, dpr });
  return changed;
}

function queueArenaRefresh({ rebuild = false } = {}) {
  arenaRefreshRebuild = arenaRefreshRebuild || rebuild;
  if (arenaRefreshRaf) {
    return new Promise((resolve) => arenaRefreshResolvers.push(resolve));
  }

  return new Promise((resolve) => {
    arenaRefreshResolvers.push(resolve);
    arenaRefreshRaf = requestAnimationFrame(() => {
      arenaRefreshRaf = requestAnimationFrame(() => {
        const shouldRebuild = arenaRefreshRebuild;
        arenaRefreshRaf = 0;
        arenaRefreshRebuild = false;
        const changed = resize();
        if (shouldRebuild && changed && song?.tracks?.length && !running) buildPlan();
        else render();
        const resolvers = arenaRefreshResolvers.splice(0);
        for (const done of resolvers) done();
      });
    });
  });
}

function resetBlackHoleParticles() {
  blackHoleParticleSystem = null;
  blackHoleParticleKey = '';
}

function blackHoleSystemKey(blackHole) {
  if (!blackHole) return '';
  return [blackHole.x, blackHole.y, blackHole.radius, blackHole.eventHorizonRadius]
    .map((value) => Number(value || 0).toFixed(3))
    .join(':');
}

function ensureBlackHoleParticleSystem() {
  const blackHole = plan?.blackHole;
  if (!blackHole) {
    resetBlackHoleParticles();
    return null;
  }
  const key = blackHoleSystemKey(blackHole);
  if (!blackHoleParticleSystem || blackHoleParticleKey !== key) {
    blackHoleParticleSystem = createBlackHoleParticleSystem(blackHole, { count: 1120, seed: key });
    blackHoleParticleKey = key;
  }
  return blackHoleParticleSystem;
}

function advanceBlackHoleVisual(dt) {
  const system = ensureBlackHoleParticleSystem();
  if (!system) return;
  advanceBlackHoleParticles(system, dt, blackHoleEnergyState());
}

function resetVisualEffects() {
  visualEffects = createVisualEffectsState({ bandCount: 56 });
  currentSceneMode = sceneModeForEnergy();
  smoothedBlackHoleEnergy = settleBlackHoleEnergyTarget();
}

function currentEnergyState() {
  return plan?.energyProfile && sim
    ? energyAtTime(plan.energyProfile, sim.time)
    : { energy: 0, intensity: 0, level: 'low' };
}

function settleBlackHoleEnergyTarget() {
  const state = currentEnergyState();
  const pulse = Math.max(0, Math.min(1.15, Number(visualEffects?.blackHolePulse ?? 0)));
  const rawEnergy = Math.max(0, Math.min(1, Number(state.energy ?? 0)));
  const energy = Math.max(rawEnergy, Math.min(1, pulse * 0.86));
  const intensity = Math.max(0, Math.min(1, Number(state.intensity ?? 0)));
  return {
    ...state,
    energy,
    intensity,
    pulse,
  };
}

function smoothScalar(current, target, dt, attack = 12, release = 4.8) {
  const safeCurrent = Number.isFinite(Number(current)) ? Number(current) : Number(target) || 0;
  const safeTarget = Number.isFinite(Number(target)) ? Number(target) : 0;
  const rate = safeTarget > safeCurrent ? attack : release;
  const alpha = 1 - Math.exp(-Math.max(0, Number(dt) || 0) * rate);
  return safeCurrent + (safeTarget - safeCurrent) * alpha;
}

function advanceSmoothedBlackHoleEnergy(dt = 0) {
  const target = settleBlackHoleEnergyTarget();
  if (!smoothedBlackHoleEnergy) {
    smoothedBlackHoleEnergy = target;
    return smoothedBlackHoleEnergy;
  }
  const safeDt = Math.max(0, Math.min(0.05, Number(dt) || 0));
  smoothedBlackHoleEnergy = {
    ...target,
    energy: smoothScalar(smoothedBlackHoleEnergy.energy, target.energy, safeDt, 10.5, 3.9),
    intensity: smoothScalar(smoothedBlackHoleEnergy.intensity, target.intensity, safeDt, 8.5, 3.2),
    pulse: smoothScalar(smoothedBlackHoleEnergy.pulse, target.pulse, safeDt, 16, 5.2),
  };
  return smoothedBlackHoleEnergy;
}

function blackHoleEnergyState() {
  return smoothedBlackHoleEnergy || settleBlackHoleEnergyTarget();
}

function blackHoleVisualState(blackHole = plan?.blackHole, energyState = blackHoleEnergyState()) {
  if (!blackHole) return null;
  const energy = Math.max(0, Math.min(1, Number(energyState?.energy ?? 0)));
  const intensity = Math.max(0, Math.min(1, Number(energyState?.intensity ?? energy)));
  const pulse = Math.max(0, Math.min(1.15, Number(energyState?.pulse ?? 0)));
  const sectionLift = Math.max(0, Math.min(1, (energy - 0.24) * 0.78));
  const basePower = Math.max(intensity, sectionLift);
  const power = Math.max(pulse, Math.min(1.15, basePower + pulse * (0.50 + Math.max(0, 1 - basePower) * 0.38)));
  const sizeScale = 0.80 + energy * 0.05 + power * 0.82 + pulse * 0.22;
  const density = Math.max(0.26, Math.min(1, 0.28 + power * 0.72));
  const baseRadius = Math.max(4, blackHole.radius || arena.radius * 0.045);
  const baseHorizon = Math.max(baseRadius * 1.02, blackHole.eventHorizonRadius || baseRadius * 1.08);
  return {
    energy,
    intensity,
    pulse,
    power,
    sizeScale,
    density,
    radius: baseRadius * sizeScale,
    horizon: baseHorizon * sizeScale,
  };
}

function blackHoleDominantColorState() {
  return {
    color: visualEffects?.dominantNoteColor || '#bd82ff',
    colorEnergy: Math.max(0, Math.min(1.15, Number(visualEffects?.dominantNoteEnergy || 0))),
  };
}

function updateSceneMode() {
  currentSceneMode = sceneModeForEnergy(currentEnergyState());
  return currentSceneMode;
}

function buildPlan() {
  if (!song?.tracks?.length) {
    plan = null;
    sim = null;
    renderTimeline();
    renderPanels();
    return;
  }
  const tracks = song.tracks.map((track, index) => ({
    ...track,
    id: track.id ?? index,
    color: track.color || trackColor(index),
  }));
  plan = planSong(tracks, arena, solverOptions());
  resetBlackHoleParticles();
  ensureBlackHoleParticleSystem();
  resetSimulation(false);
  renderTimeline();
  renderPanels();
}

function resetSimulation(redraw = true) {
  sim = createPlaybackState(plan, arena);
  hitCounter = 0;
  resetVisualEffects();
  if (redraw) renderPanels();
}

function playbackEndTime() {
  if (!plan) return 0;
  if (!hasBackingAudio()) return plan.duration;
  const contentEnd = Number(song?.analysis?.audioContentEndSeconds);
  const audioEnd = Number.isFinite(contentEnd) && contentEnd > 0
    ? contentEnd
    : Number(song?.audioBuffer?.duration || 0);
  return Math.max(plan.duration, audioEnd);
}

function activeBalls() {
  if (!sim) return [];
  return [...sim.balls.values()].filter((ball) => ball.spawned && !ball.retired);
}

function activeBallCount() {
  return activeBalls().length;
}

function setDemoState(state, message = '') {
  if (!appShell) return;
  appShell.classList.remove('is-empty', 'is-processing', 'is-ready', 'is-error');
  appShell.classList.add(`is-${state}`);
  appShell.dataset.state = state;
  if (message) {
    sourceName.textContent = message;
    if (processingText) processingText.textContent = message;
  }
}

function setProcessingMessage(message) {
  sourceName.textContent = message;
  if (processingText) processingText.textContent = message;
}

async function loadSong(nextSong, label) {
  stopBackingAudio();
  song = nextSong;
  sourceLabel = label;
  sourceName.textContent = label;
  running = false;
  playBtn.textContent = 'play';
  playBtn.classList.remove('active');
  resize();
  buildPlan();
  setDemoState('ready', label);
  await queueArenaRefresh({ rebuild: true });
}

async function beginDemoPlayback({ fromStart = true } = {}) {
  if (!sim || !plan) return;
  if (fromStart) resetSimulation(false);
  running = true;
  playBtn.textContent = 'pause';
  playBtn.classList.add('active');
  await audio.armIfEnabled();
  await startBackingAudioIfNeeded();
  renderPanels();
}

function energizeBallLight(ball, amount = 1) {
  if (!ball) return;
  const scene = currentSceneMode || sceneModeForEnergy();
  const multiplier = Number(ball.lightMultiplier ?? ball.personality?.lightMultiplier ?? 1) * Number(scene.lightMultiplier ?? 1);
  const current = Number(ball.lightEnergy || 0);
  ball.lightEnergy = Math.max(current, amount * multiplier);
}

function decayBallLights(dt) {
  if (!sim) return;
  const settle = Math.exp(-Math.max(0, dt) * 2.65);
  for (const ball of activeBalls()) {
    const base = 0.04 * Number(ball.lightMultiplier ?? 1);
    const current = Number(ball.lightEnergy || base);
    const next = base + (current - base) * settle;
    ball.lightEnergy = next < base + 0.004 ? base : next;
  }
}

function recordSegmentHit({ segment, ball }) {
  if (!ball) return;

  hitCounter += 1;
  const label = `${noteName(segment.note.midi)} · ${segment.trackName}`;
  sim.flashes.push({
    x: segment.target.x,
    y: segment.target.y,
    color: ball.color,
    life: 1,
    midi: segment.note.midi,
    label,
  });
  registerNoteImpact(visualEffects, {
    midi: segment.note.midi,
    velocity: segment.note.velocity,
    x: segment.target.x,
    y: segment.target.y,
    color: ball.color,
    sceneMode: currentSceneMode,
    personality: segment.personality || ball.personality,
  });
  energizeBallLight(ball, 0.24 + Number(segment.note.velocity || 0.7) * 0.34);
  sim.log.unshift({ time: sim.time, label, midi: segment.note.midi, track: segment.trackName, color: ball.color });
  sim.log = sim.log.slice(0, 12);
  if (!hasBackingAudio()) audio.trigger(segment.note, segment.note.velocity, Math.max(0.08, Math.min(0.42, segment.note.duration || 0.16)));
}

function stepSimulation(dt) {
  if (!plan || !sim) return;
  updateSceneMode();
  advancePlayback(sim, plan, arena, dt, {
    onLaunch: ({ ball, previous }) => {
      if (!previous?.spawned) energizeBallLight(ball, 0.15);
    },
    onCollision: (hit) => {
      energizeBallLight(hit.ball, 0.10);
      sim.ghostHits.push({ x: hit.x, y: hit.y, color: hit.ball.color, life: 0.45 });
    },
    onHit: recordSegmentHit,
  });

  if (sim.time > playbackEndTime() + 1.35) {
    running = false;
    playBtn.textContent = 'play';
    playBtn.classList.remove('active');
    stopBackingAudio();
    phaseEl.textContent = 'ended';
  }

  for (const flash of sim.flashes) flash.life -= dt * 2.1;
  sim.flashes = sim.flashes.filter((flash) => flash.life > 0);
  for (const ghost of sim.ghostHits) ghost.life -= dt * 1.7;
  sim.ghostHits = sim.ghostHits.filter((ghost) => ghost.life > 0);
  decayVisualEffects(visualEffects, dt);
  decayBallLights(dt);
  updateSceneMode();
}

function drawExteriorFrequencyField() {
  if (!visualEffects?.frequencyBands?.length) return;
  const bands = visualEffects.frequencyBands;
  const screenImpact = visualEffects.screenImpact || 0;
  const scene = currentSceneMode || sceneModeForEnergy();
  const rippleMultiplier = Number(scene.wallRippleMultiplier ?? 1);
  const outerReach = Math.min(Math.max(W, H), arena.radius + 62 + screenImpact * 24 * rippleMultiplier);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.arc(arena.cx, arena.cy, arena.radius + 5, 0, Math.PI * 2);
  ctx.clip('evenodd');
  ctx.globalCompositeOperation = 'screen';

  for (let i = 0; i < bands.length; i += 1) {
    const energy = bands[i];
    if (energy <= 0.015) continue;
    const unit = i / Math.max(1, bands.length - 1);
    const y = arena.radius - unit * arena.radius * 2;
    const span = Math.sqrt(Math.max(0, arena.radius * arena.radius - y * y));
    ctx.globalAlpha = Math.min(0.082, energy * 0.043 * rippleMultiplier);
    ctx.strokeStyle = `hsla(${205 + unit * 190}, 88%, ${40 + energy * 9}%, 0.42)`;
    ctx.lineWidth = 0.4 + energy * 1.8;
    ctx.beginPath();
    ctx.moveTo(arena.cx - outerReach, arena.cy + y);
    ctx.lineTo(arena.cx - span - 14, arena.cy + y);
    ctx.moveTo(arena.cx + span + 14, arena.cy + y);
    ctx.lineTo(arena.cx + outerReach, arena.cy + y);
    ctx.stroke();
  }

  ctx.globalAlpha = Math.min(0.30, (0.08 + screenImpact * 0.16) * rippleMultiplier);
  ctx.lineWidth = 0.8 + screenImpact * 2.2 * rippleMultiplier;
  ctx.strokeStyle = 'rgba(247,240,219,0.20)';
  ctx.beginPath();
  const samples = 144;
  for (let i = 0; i <= samples; i += 1) {
    const angle = (i / samples) * Math.PI * 2;
    const pitchUnit = 1 - ((Math.sin(angle) + 1) / 2);
    const band = Math.max(0, Math.min(bands.length - 1, Math.round(pitchUnit * (bands.length - 1))));
    const energy = bands[band] || 0;
    const ripple = Math.sin(angle * 5 + performance.now() * 0.003) * energy * 2.4 * rippleMultiplier;
    const radius = arena.radius + 9 + energy * 21 * rippleMultiplier + screenImpact * 5 * rippleMultiplier + ripple;
    const x = arena.cx + Math.cos(angle) * radius;
    const y = arena.cy + Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}

function drawLocalizedImpactHalo(screenImpact) {
  if (screenImpact <= 0) return;
  const outerRadius = arena.radius + 8 + screenImpact * 32;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.arc(arena.cx, arena.cy, arena.radius + 2, 0, Math.PI * 2);
  ctx.clip('evenodd');
  ctx.globalCompositeOperation = 'screen';
  const halo = ctx.createRadialGradient(
    arena.cx,
    arena.cy,
    arena.radius + 2,
    arena.cx,
    arena.cy,
    outerRadius,
  );
  halo.addColorStop(0, 'rgba(247,240,219,0)');
  halo.addColorStop(0.72, `rgba(247,240,219,${screenImpact * 0.028})`);
  halo.addColorStop(1, 'rgba(247,240,219,0)');
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(arena.cx, arena.cy, outerRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = `rgba(247,240,219,${screenImpact * 0.075})`;
  ctx.lineWidth = 0.8 + screenImpact * 2.2;
  ctx.beginPath();
  ctx.arc(arena.cx, arena.cy, arena.radius + screenImpact * 14, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawImpactFrames() {
  if (!visualEffects) return;
  const screenImpact = visualEffects.screenImpact || 0;
  drawLocalizedImpactHalo(screenImpact);

  for (const impact of visualEffects.impactFrames || []) {
    const alpha = Math.max(0, impact.life);
    const burstRadius = Number(impact.burstRadius || 70);
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = alpha * 0.42;
    ctx.strokeStyle = impact.color;
    ctx.lineWidth = 0.8 + alpha * 3;
    ctx.beginPath();
    ctx.arc(impact.x, impact.y, 4 + impact.age * burstRadius * 1.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = alpha * 0.16;
    ctx.beginPath();
    ctx.arc(impact.x, impact.y, 16 + impact.age * burstRadius * 2.3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawImpactParticles() {
  const particles = visualEffects?.particles || [];
  if (!particles.length) return;

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const particle of particles) {
    const life = Math.max(0, Math.min(1, particle.life || 0));
    if (life <= 0) continue;
    const style = particle.style || 'default';
    const radiusStyle = style === 'bass' ? 1.35 : style === 'treble' ? 0.72 : style === 'drums' ? 1.05 : 1;
    const alphaStyle = style === 'bass' ? 0.62 : style === 'drums' ? 1.08 : 0.92;
    const streakStyle = style === 'bass' ? 0.56 : style === 'treble' ? 1.34 : style === 'drums' ? 1.16 : 1;
    const particleRadius = Math.max(0.5, particle.radius || 1) * radiusStyle * (0.85 + (1 - life) * 1.65);
    const alpha = Math.min(0.86, life * life * 0.62 * alphaStyle);
    const streakX = particle.x - particle.vx * particle.length * 0.0028 * streakStyle;
    const streakY = particle.y - particle.vy * particle.length * 0.0028 * streakStyle;
    ctx.globalAlpha = alpha * 0.78;
    ctx.strokeStyle = colorWithAlpha(particle.color, 0.72);
    ctx.lineWidth = Math.max(0.6, particle.radius * (style === 'treble' ? 0.42 : 0.58));
    ctx.beginPath();
    ctx.moveTo(particle.x, particle.y);
    ctx.lineTo(streakX, streakY);
    ctx.stroke();

    const ember = ctx.createRadialGradient(
      particle.x,
      particle.y,
      0,
      particle.x,
      particle.y,
      particleRadius * 4.2,
    );
    ember.addColorStop(0, colorWithAlpha(particle.color, alpha));
    ember.addColorStop(0.28, colorWithAlpha(particle.color, alpha * 0.38));
    ember.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = ember;
    ctx.beginPath();
    ctx.arc(particle.x, particle.y, particleRadius * 4.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = alpha * 0.95;
    ctx.fillStyle = colorWithAlpha(particle.color, 0.86);
    ctx.beginPath();
    ctx.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

function colorWithAlpha(color, alpha) {
  const safeAlpha = Math.max(0, Math.min(1, Number(alpha) || 0));
  const hex = String(color || '').trim().match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const value = hex[1];
    const r = parseInt(value.slice(0, 2), 16);
    const g = parseInt(value.slice(2, 4), 16);
    const b = parseInt(value.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${safeAlpha})`;
  }

  const hsl = String(color || '').trim().match(/^hsla?\(([^)]+)\)$/i);
  if (hsl) {
    const parts = hsl[1].split(',').map((part) => part.trim());
    if (parts.length >= 3) return `hsla(${parts[0]}, ${parts[1]}, ${parts[2]}, ${safeAlpha})`;
  }

  return `rgba(255,255,255,${safeAlpha})`;
}

function ensureLightBuffer() {
  const width = Math.max(1, Math.ceil(W * lightBufferScale));
  const height = Math.max(1, Math.ceil(H * lightBufferScale));
  if (!lightCanvas) {
    lightCanvas = document.createElement('canvas');
    lightCtx = lightCanvas.getContext('2d', { alpha: true });
  }
  if (lightCanvas.width !== width || lightCanvas.height !== height) {
    lightCanvas.width = width;
    lightCanvas.height = height;
  }
  return { canvas: lightCanvas, context: lightCtx, scale: lightBufferScale };
}

function drawLightSystem() {
  const balls = activeBalls();
  if (!balls.length || !arena.radius) return;
  const { canvas: buffer, context: lightCtx, scale } = ensureLightBuffer();
  if (!lightCtx) return;
  const scene = currentSceneMode || sceneModeForEnergy();
  const sceneLight = Number(scene.lightMultiplier ?? 1);

  lightCtx.setTransform(1, 0, 0, 1, 0, 0);
  lightCtx.clearRect(0, 0, buffer.width, buffer.height);
  lightCtx.save();
  lightCtx.setTransform(scale, 0, 0, scale, 0, 0);
  lightCtx.beginPath();
  lightCtx.arc(arena.cx, arena.cy, arena.radius, 0, Math.PI * 2);
  lightCtx.clip();
  lightCtx.globalCompositeOperation = 'lighter';

  for (const ball of balls) {
    const speed = Math.min(1, Math.hypot(ball.vx || 0, ball.vy || 0) / 1200);
    const personalityLight = Number(ball.lightMultiplier ?? 1);
    const energy = Math.max(0.035, Math.min(0.78, Number(ball.lightEnergy || 0.04) * sceneLight * personalityLight));
    const radius = ball.radius * (5.8 + speed * 2.4 + energy * 4.1);
    const core = Math.max(0.055, Math.min(0.18, 0.045 + energy * 0.095));
    const falloff = lightCtx.createRadialGradient(ball.x, ball.y, 0, ball.x, ball.y, radius);
    falloff.addColorStop(0, colorWithAlpha(ball.color, core));
    falloff.addColorStop(0.20, colorWithAlpha(ball.color, core * 0.42));
    falloff.addColorStop(0.56, colorWithAlpha(ball.color, core * 0.10));
    falloff.addColorStop(1, 'rgba(0,0,0,0)');
    lightCtx.fillStyle = falloff;
    lightCtx.beginPath();
    lightCtx.arc(ball.x, ball.y, radius, 0, Math.PI * 2);
    lightCtx.fill();
  }
  lightCtx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(arena.cx, arena.cy, arena.radius + 7, 0, Math.PI * 2);
  ctx.clip();
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = Math.min(0.36, 0.28 + Math.max(0, sceneLight - 1) * 0.12);
  ctx.imageSmoothingEnabled = true;
  ctx.filter = 'blur(6px) saturate(112%)';
  ctx.drawImage(buffer, 0, 0, W, H);
  ctx.filter = 'none';
  ctx.globalAlpha = Math.min(0.16, 0.11 + Math.max(0, sceneLight - 1) * 0.05);
  ctx.drawImage(buffer, 0, 0, W, H);
  ctx.restore();
}

function drawWall() {
  const scene = currentSceneMode || sceneModeForEnergy();
  const scenePulse = Number(scene.ballPulse ?? 0);
  ctx.save();
  ctx.translate(arena.cx, arena.cy);
  for (let i = 0; i < 44; i += 1) {
    const a0 = (i / 44) * Math.PI * 2;
    const a1 = ((i + 0.88) / 44) * Math.PI * 2;
    const y = Math.sin((a0 + a1) / 2) * arena.radius;
    const unit = 1 - ((y + arena.radius) / (arena.radius * 2));
    ctx.strokeStyle = wallColorForTarget({ x: 0, y: arena.cy + y }, arena, 0.72);
    ctx.lineWidth = 9 + scenePulse * 8;
    ctx.beginPath();
    ctx.arc(0, 0, arena.radius, a0, a1);
    ctx.stroke();
  }
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(243,236,214,0.78)';
  ctx.beginPath();
  ctx.arc(0, 0, arena.radius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(243,236,214,0.032)';
  ctx.lineWidth = 1;
  for (let row = 1; row < 12; row += 1) {
    const y = -arena.radius + (row / 12) * arena.radius * 2;
    const span = Math.sqrt(Math.max(0, arena.radius * arena.radius - y * y));
    ctx.beginPath();
    ctx.moveTo(-span, y);
    ctx.lineTo(span, y);
    ctx.stroke();
  }
  ctx.restore();
}

function ensurePixiLightLayer() {
  if (pixiLightLayer?.ready) return pixiLightLayer;
  if (pixiLightLayerPromise || !canvasFrame) return pixiLightLayer;
  pixiLightLayerPromise = createPixiLightParticleLayer({
    host: canvasFrame,
    width: W || canvasFrame.clientWidth || window.innerWidth || 1,
    height: H || canvasFrame.clientHeight || window.innerHeight || 1,
    dpr: DPR(),
    maxParticles: 1220,
  })
    .then((layer) => {
      pixiLightLayer = layer;
      pixiLightLayer.resize({ width: W, height: H, dpr: DPR() });
      return layer;
    })
    .catch((error) => {
      console.error('Pixi light layer failed; black-hole lightfield requires PixiJS', error);
      return null;
    })
    .finally(() => {
      pixiLightLayerPromise = null;
    });
  return pixiLightLayer;
}

function renderBlackHoleLightParticlesWithLibrary(lightParticles, power = 0) {
  const layer = ensurePixiLightLayer();
  if (!layer?.ready) return false;
  layer.render({
    particles: lightParticles || [],
    arena,
    power,
  });
  return true;
}

function drawBlackHole() {
  const blackHole = plan?.blackHole;
  if (!blackHole) return;
  const system = ensureBlackHoleParticleSystem();
  const energyState = blackHoleEnergyState();
  const visual = blackHoleVisualState(blackHole, energyState);
  const particles = blackHoleParticleSnapshots(system, blackHole, energyState);
  const lightParticles = blackHoleLightParticleSnapshots(system, blackHole, energyState, blackHoleDominantColorState());
  const radius = visual?.radius ?? Math.max(4, blackHole.radius || arena.radius * 0.045);
  const horizon = visual?.horizon ?? Math.max(radius * 1.02, blackHole.eventHorizonRadius || radius * 1.08);
  const pulse = 0.5 + Math.sin(performance.now() * 0.0034) * 0.5;
  const power = Math.max(0, Math.min(1.15, Number(visual?.power ?? visual?.intensity ?? 0)));

  ctx.save();
  ctx.beginPath();
  ctx.arc(arena.cx, arena.cy, arena.radius - 1, 0, Math.PI * 2);
  ctx.clip();
  ctx.globalCompositeOperation = 'lighter';

  renderBlackHoleLightParticlesWithLibrary(lightParticles, power);

  for (const particle of particles) {
    const alpha = Math.max(0, Math.min(1, particle.alpha || 0));
    if (alpha <= 0.02) continue;
    ctx.globalAlpha = alpha * (0.09 + power * 0.18);
    ctx.strokeStyle = colorWithAlpha(particle.color, 0.74);
    ctx.lineWidth = Math.max(0.13, particle.size * 0.34);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(particle.tailX, particle.tailY);
    ctx.quadraticCurveTo(
      Number.isFinite(particle.controlX) ? particle.controlX : (particle.tailX + particle.x) * 0.5,
      Number.isFinite(particle.controlY) ? particle.controlY : (particle.tailY + particle.y) * 0.5,
      particle.x,
      particle.y,
    );
    ctx.stroke();
  }

  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.arc(blackHole.x, blackHole.y, horizon * 1.34, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = `rgba(232,238,255,${0.08 + pulse * 0.035 + power * 0.11})`;
  ctx.lineWidth = 1.05;
  ctx.beginPath();
  ctx.arc(blackHole.x, blackHole.y, horizon * (1.08 + pulse * 0.025), 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = `rgba(119,167,255,${0.028 + pulse * 0.026 + power * 0.12})`;
  ctx.lineWidth = 0.55 + power * 0.65;
  ctx.beginPath();
  ctx.ellipse(blackHole.x, blackHole.y, radius * 4.6, radius * 1.42, -0.22, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawBalls() {
  if (!sim) return;
  for (const ghost of sim.ghostHits) {
    ctx.save();
    ctx.globalAlpha = ghost.life * 0.45;
    ctx.strokeStyle = ghost.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(ghost.x, ghost.y, 12 + (1 - ghost.life) * 18, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  for (const flash of sim.flashes) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, flash.life);
    ctx.strokeStyle = flash.color;
    ctx.fillStyle = flash.color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(flash.x, flash.y, 14 + (1 - flash.life) * 34, 0, Math.PI * 2);
    ctx.stroke();
    ctx.font = '12px ui-monospace, monospace';
    ctx.fillText(noteName(flash.midi), flash.x + 12, flash.y - 10);
    ctx.restore();
  }

  for (const ball of sim.balls.values()) {
    if (!ball.spawned || ball.retired) continue;
    ctx.save();
    const scene = currentSceneMode || sceneModeForEnergy();
    const personality = ball.personality || {};
    const lightPulse = Math.max(0, Number(ball.lightEnergy || 0) - 0.04);
    const renderRadius = ball.radius * (1 + Math.min(0.18, lightPulse * 0.12 + Number(scene.ballPulse ?? 0)));
    ctx.globalAlpha = Number(personality.trailAlpha ?? 0.22);
    ctx.strokeStyle = ball.color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(ball.x, ball.y);
    ctx.lineTo(ball.x - ball.vx * 0.075, ball.y - ball.vy * 0.075);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = ball.color;
    ctx.strokeStyle = '#050504';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, renderRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

function render() {
  updateSceneMode();
  ctx.clearRect(0, 0, W, H);
  if (!plan || !sim) {
    if (pixiLightLayer?.ready) pixiLightLayer.clear();
    return;
  }
  drawExteriorFrequencyField();
  drawWall();
  drawLightSystem();
  drawBlackHole();
  drawBalls();
  drawImpactFrames();
  drawImpactParticles();
}

function renderTimeline() {
  if (!timeline) return;
  timeline.innerHTML = '';
  if (!plan) return;
  const duration = Math.max(1, plan.duration);
  plan.tracks.forEach((track, index) => {
    const top = ((index + 0.5) / Math.max(1, plan.tracks.length)) * 100;
    const row = document.createElement('div');
    row.className = 'row';
    row.style.top = `${top}%`;
    timeline.append(row);
    for (const segment of track.segments) {
      const event = document.createElement('div');
      event.className = 'event';
      event.title = `${track.name} ${noteName(segment.note.midi)} @ ${segment.arrivalTime.toFixed(2)}s`;
      event.style.left = `${(segment.arrivalTime / duration) * 100}%`;
      event.style.top = `${top}%`;
      event.style.height = `${Math.max(12, Math.min(42, (segment.note.duration || 0.12) * 60))}px`;
      event.style.background = track.color;
      timeline.append(event);
    }
  });
  const head = document.createElement('div');
  head.className = 'head';
  head.id = 'timelineHead';
  timeline.append(head);
}

function renderPanels() {
  const state = appShell?.dataset?.state || 'empty';
  if (!plan || !sim) {
    if (sourceName && state === 'empty') sourceName.textContent = sourceLabel;
    return;
  }
  ballCountEl.textContent = String(plan.totalBalls);
  activeBallCountEl.textContent = String(activeBallCount());
  noteCountEl.textContent = String(plan.events.length);
  hitCountEl.textContent = String(hitCounter);
  clockEl.textContent = `${sim.time.toFixed(2)}s`;
  phaseEl.textContent = running ? 'running' : sim.time > playbackEndTime() + 1.2 ? 'ended' : sim.time > 0 ? 'paused' : 'ready';
  gravityOut.textContent = gravityInput.value;
  maxSpeedOut.textContent = maxSpeedInput.value;
  if (state !== 'processing') sourceName.textContent = sourceLabel;

  const next = plan.events.find((event) => !sim.segmentStates.get(event.id)?.hit);
  nextHitEl.textContent = next ? `${noteName(next.note.midi)} in ${Math.max(0, next.arrivalTime - sim.time).toFixed(2)}s` : '—';

  const head = document.querySelector('#timelineHead');
  if (head) head.style.left = `${Math.min(100, (sim.time / Math.max(1, playbackEndTime())) * 100)}%`;

  trackList.innerHTML = plan.tracks.map((track) => `
    <div class="trackItem">
      <i style="background:${track.color}"></i>
      <span><strong>${escapeHtml(track.name)}</strong><small>${track.notes.length} notes · ${noteName(track.minMidi)}–${noteName(track.maxMidi)}</small></span>
      <b>${track.ballCount}</b>
    </div>
  `).join('');

  eventLog.innerHTML = sim.log.map((item) => `
    <li><b style="color:${item.color}">${escapeHtml(item.label)}</b><br>${item.time.toFixed(2)}s · ${frequencyForMidi(item.midi).toFixed(1)} Hz</li>
  `).join('') || '<li>Wall hits will appear here.</li>';
}

function blackHoleBendStats() {
  const segments = (plan?.events || []).filter((segment) => segment.flightField === 'black-hole' && segment.duration > 0 && segment.blackHole);
  if (!segments.length) return { median: 0, p90: 0, max: 0 };
  const bends = segments.map((segment) => {
    const samples = fieldPathSamples(
      segment.start,
      segment.velocity,
      segment.duration,
      { x: segment.gravityX || 0, y: segment.gravityY || 0, blackHole: segment.blackHole },
      20,
      { fieldStep: plan.options?.fieldStep, fieldMaxSteps: plan.options?.fieldMaxSteps },
    );
    const first = samples[0];
    const last = samples.at(-1);
    let maxBend = 0;
    for (let index = 0; index < samples.length; index += 1) {
      const unit = index / Math.max(1, samples.length - 1);
      const straightX = first.x + (last.x - first.x) * unit;
      const straightY = first.y + (last.y - first.y) * unit;
      maxBend = Math.max(maxBend, Math.hypot(samples[index].x - straightX, samples[index].y - straightY));
    }
    return maxBend;
  }).sort((a, b) => a - b);
  return {
    median: bends[Math.floor((bends.length - 1) * 0.5)] || 0,
    p90: bends[Math.floor((bends.length - 1) * 0.9)] || 0,
    max: bends.at(-1) || 0,
  };
}

window.MusicVisualizerDebug = {
  stats: () => ({
    source: sourceLabel,
    format: song?.format,
    transcriber: song?.analysis?.transcriber,
    highAccuracyError: song?.analysis?.highAccuracyError,
    totalBalls: plan?.totalBalls ?? 0,
    activeBalls: activeBallCount(),
    retiredBalls: sim ? [...sim.balls.values()].filter((ball) => ball.retired).length : 0,
    spawnedBalls: sim ? [...sim.balls.values()].filter((ball) => ball.spawned).length : 0,
    notes: plan?.events.length ?? 0,
    hits: hitCounter,
    time: sim?.time ?? 0,
    playbackEnd: playbackEndTime(),
    impactFrames: visualEffects?.impactFrames?.length ?? 0,
    particles: visualEffects?.particles?.length ?? 0,
    frequencyEnergy: visualEffects?.frequencyBands?.reduce((sum, value) => sum + value, 0) ?? 0,
    songEnergy: plan?.energyProfile && sim ? energyAtTime(plan.energyProfile, sim.time).energy : 0,
    songEnergyLevel: plan?.energyProfile && sim ? energyAtTime(plan.energyProfile, sim.time).level : 'low',
    sceneMode: currentSceneMode?.name || 'calm',
    sceneLightMultiplier: currentSceneMode?.lightMultiplier ?? 1,
    trackPersonalities: plan?.tracks?.map((track) => track.personality?.name || 'default') ?? [],
    pitchRange: plan?.pitchRange ?? null,
    blackHole: plan?.blackHole ?? null,
    blackHoleSegments: plan?.events?.filter((segment) => segment.flightField === 'black-hole').length ?? 0,
    maxBlackHoleMissDistance: plan?.events?.length ? Math.max(0, ...plan.events.map((segment) => segment.missDistance || 0)) : 0,
    blackHoleBendPx: blackHoleBendStats(),
    blackHoleParticleCount: blackHoleParticleSystem?.particles?.length ?? 0,
    blackHoleParticleVisibleCount: plan?.blackHole
      ? blackHoleParticleSnapshots(blackHoleParticleSystem, plan.blackHole, blackHoleEnergyState()).filter((particle) => particle.alpha > 0.025).length
      : 0,
    blackHoleVisualScale: blackHoleVisualState()?.sizeScale ?? 1,
    blackHoleVisualDensity: blackHoleVisualState()?.density ?? 0,
    blackHoleVisualPower: blackHoleVisualState()?.power ?? 0,
    blackHolePulse: visualEffects?.blackHolePulse ?? 0,
    blackHoleDominantNoteColor: visualEffects?.dominantNoteColor ?? null,
    blackHoleDominantNoteEnergy: visualEffects?.dominantNoteEnergy ?? 0,
    pixiLightLayer: pixiLightLayer?.kind ?? (pixiLightLayerPromise ? 'loading' : 'pending'),
    blackHoleLightParticleCount: plan?.blackHole
      ? blackHoleLightParticleSnapshots(blackHoleParticleSystem, plan.blackHole, blackHoleEnergyState(), blackHoleDominantColorState()).filter((particle) => particle.alpha > 0.025).length
      : 0,
    ballRadii: sim ? [...sim.balls.values()].map((ball) => ball.radius) : [],
    peakSegmentEnergy: plan?.events?.length ? Math.max(0, ...plan.events.map((segment) => segment.energy || 0)) : 0,
    adaptiveSegments: plan?.events?.filter((segment) => (segment.energyIntensity || 0) > 0)?.length ?? 0,
    maxSegmentGravityY: plan?.events?.length ? Math.max(0, ...plan.events.map((segment) => segment.gravityY || plan.options.gravityY || 0)) : 0,
    baseGravityY: plan?.options?.gravityY ?? 0,
    audioTimeline: audio.backingTimelineTime?.(),
    audioDuration: song?.audioBuffer?.duration ?? null,
    audioContentEnd: song?.analysis?.audioContentEndSeconds ?? null,
  }),
};

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function frame(now) {
  const raw = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  advanceSmoothedBlackHoleEnergy(raw);
  advanceBlackHoleVisual(raw);
  if (running) {
    const audioTimeline = hasBackingAudio() && audio.enabled ? audio.backingTimelineTime() : null;
    let budget = Number.isFinite(audioTimeline)
      ? Math.max(0, Math.min(audioTimeline, playbackEndTime() + 1.35) - sim.time)
      : raw * speedValues[speedIndex];
    while (budget > 0) {
      const dt = Math.min(budget > 0.75 ? 1 / 30 : fixedStep, budget);
      stepSimulation(dt);
      budget -= dt;
    }
  }
  render();
  renderPanels();
  raf = requestAnimationFrame(frame);
}

async function handleFile(file) {
  const name = file?.name || 'song';
  setDemoState('processing', `Reading ${name}…`);
  await audio.armIfEnabled();
  const buffer = await file.arrayBuffer();
  if (isMp3File(file)) {
    setProcessingMessage(`Decoding ${name}…`);
    const audioBuffer = await audio.decodeAudioData(buffer);
    if (!mp3HighAccuracy) {
      setProcessingMessage(`Fast analyzing ${name}…`);
      const analyzed = analyzeAudioBufferToSong(audioBuffer);
      const playableTracks = analyzed.tracks.filter((track) => track.notes.length > 0);
      if (playableTracks.length === 0) throw new Error('No usable MP3 note events were inferred');
      await loadSong({ ...analyzed, tracks: playableTracks, audioBuffer }, `${name} · fast MP3`);
      await beginDemoPlayback();
      return;
    }

    setProcessingMessage(`Loading Basic Pitch model for ${name}…`);
    const analyzed = await analyzeMp3WithPreferredTranscriber(audioBuffer, {
      highAccuracy: async (bufferToAnalyze) => {
        setProcessingMessage(`Uploading ${name} to Basic Pitch…`);
        try {
          return await transcribeAudioFileWithServerBasicPitch(file, bufferToAnalyze);
        } catch (serverError) {
          console.warn('Basic Pitch server unavailable; using browser model fallback', serverError);
          return transcribeAudioBufferWithBasicPitch(bufferToAnalyze, {
            onProgress: (progress, phase) => {
              if (phase === 'loading-model') setProcessingMessage(`Loading browser Basic Pitch model for ${name}…`);
              else if (phase === 'transcribing') setProcessingMessage(`Browser Basic Pitch ${Math.round(progress * 100)}% · ${name}`);
              else setProcessingMessage(`Preparing ${name}…`);
            },
          });
        }
      },
      fallback: (bufferToAnalyze) => {
        setProcessingMessage(`Basic Pitch unavailable; using fast analyzer for ${name}…`);
        return analyzeAudioBufferToSong(bufferToAnalyze);
      },
    });
    const playableTracks = analyzed.tracks.filter((track) => track.notes.length > 0);
    if (playableTracks.length === 0) throw new Error('No usable MP3 note events were inferred');
    const mode = analyzed.format === 'basic-pitch' ? 'Basic Pitch MP3' : 'fast MP3 fallback';
    await loadSong({ ...analyzed, tracks: playableTracks, audioBuffer }, `${name} · ${mode}`);
    await beginDemoPlayback();
    return;
  }

  const parsed = parseMidiFile(buffer);
  const playableTracks = parsed.tracks.filter((track) => track.notes.length > 0);
  await loadSong({ ...parsed, tracks: playableTracks }, file.name || 'Uploaded MIDI');
  await beginDemoPlayback();
}


async function handleYoutubeImport() {
  const url = String(youtubeUrlInput?.value || '').trim();
  const rightsAccepted = Boolean(youtubeRightsInput?.checked);
  if (!isLikelyYouTubeUrl(url)) throw new Error('Paste a valid YouTube URL');
  if (!rightsAccepted) throw new Error('Confirm you have rights or permission to process this media');

  setDemoState('processing', 'Importing YouTube audio…');
  await audio.armIfEnabled();
  const audioFile = await fetchYoutubeAudio({ url, rightsAccepted });
  setProcessingMessage(`Processing ${audioFile.name || 'YouTube audio'}…`);
  await handleFile(audioFile);
}

async function handleBundledSample(sample = ROYALTY_FREE_SAMPLES[0]) {
  setDemoState('processing', `Loading ${sampleLabel(sample)}…`);
  const buffer = await fetchSampleMidi(sample);
  const parsed = parseMidiFile(buffer);
  const playableTracks = parsed.tracks.filter((track) => track.notes.length > 0);
  await loadSong({ ...parsed, tracks: playableTracks }, sampleLabel(sample));
}

playBtn.addEventListener('click', async () => {
  if (!sim) return;
  if (!running && sim.time >= playbackEndTime() + 1.2) resetSimulation();
  running = !running;
  playBtn.textContent = running ? 'pause' : 'play';
  playBtn.classList.toggle('active', running);
  if (running) {
    await audio.armIfEnabled();
    await startBackingAudioIfNeeded();
  } else {
    stopBackingAudio();
  }
});

demoBtn.addEventListener('click', () => { void loadSong(createDemoSong(), 'Generated demo loaded'); });
sampleBtn.addEventListener('click', async () => {
  try { await handleBundledSample(); }
  catch (error) { setDemoState('empty', `Could not load sample: ${error.message}`); }
});
resetBtn.addEventListener('click', async () => {
  stopBackingAudio();
  resetSimulation();
  if (running) await startBackingAudioIfNeeded();
});
speedBtn.addEventListener('click', async () => {
  speedIndex = (speedIndex + 1) % speedValues.length;
  speedBtn.textContent = `${speedValues[speedIndex]}×`;
  speedBtn.classList.toggle('active', speedValues[speedIndex] !== 1);
  if (running && hasBackingAudio()) await startBackingAudioIfNeeded();
});
mp3ModeBtn?.addEventListener('click', () => {
  mp3HighAccuracy = !mp3HighAccuracy;
  updateMp3ModeButton();
});
soundBtn.addEventListener('click', async () => {
  await audio.setEnabled(!audio.enabled);
  if (!audio.enabled) stopBackingAudio();
  else await startBackingAudioIfNeeded();
  soundBtn.textContent = soundButtonLabel(audio.enabled);
  soundBtn.classList.toggle('active', audio.enabled);
});
fileInput.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try { await handleFile(file); }
  catch (error) {
    running = false;
    stopBackingAudio();
    setDemoState('empty', `Could not load file: ${error.message}`);
  }
});
for (const input of [gravityInput, maxSpeedInput]) {
  input.addEventListener('input', () => {
    gravityOut.textContent = gravityInput.value;
    maxSpeedOut.textContent = maxSpeedInput.value;
  });
  input.addEventListener('change', () => buildPlan());
}

for (const type of ['dragenter', 'dragover']) {
  dropZone.addEventListener(type, (event) => {
    event.preventDefault();
    dropZone.classList.add('drag');
  });
}
for (const type of ['dragleave', 'drop']) {
  dropZone.addEventListener(type, (event) => {
    event.preventDefault();
    dropZone.classList.remove('drag');
  });
}

function shouldIgnoreDropZoneActivation(event) {
  return Boolean(event.target?.closest?.('.urlImport, a, button, input, label'));
}

dropZone.addEventListener('click', (event) => {
  if (shouldIgnoreDropZoneActivation(event)) return;
  fileInput.click();
});
dropZone.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  if (shouldIgnoreDropZoneActivation(event)) return;
  event.preventDefault();
  fileInput.click();
});

youtubeForm?.addEventListener('click', (event) => event.stopPropagation());
youtubeForm?.addEventListener('pointerdown', (event) => event.stopPropagation());
youtubeForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (youtubeImportBtn) youtubeImportBtn.disabled = true;
  try { await handleYoutubeImport(); }
  catch (error) {
    running = false;
    stopBackingAudio();
    setDemoState('empty', `Could not import YouTube audio: ${error.message}`);
  } finally {
    if (youtubeImportBtn) youtubeImportBtn.disabled = false;
  }
});

dropZone.addEventListener('drop', async (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  try { await handleFile(file); }
  catch (error) {
    running = false;
    stopBackingAudio();
    setDemoState('empty', `Could not load file: ${error.message}`);
  }
});

window.addEventListener('resize', () => {
  queueArenaRefresh({ rebuild: Boolean(song?.tracks?.length) });
  renderTimeline();
});

if (typeof ResizeObserver !== 'undefined' && canvasFrame) {
  const observer = new ResizeObserver(() => {
    queueArenaRefresh({ rebuild: Boolean(song?.tracks?.length) && !running });
  });
  observer.observe(canvasFrame);
}

appShell?.addEventListener('transitionend', (event) => {
  if (event.target?.classList?.contains('stageModule')) {
    queueArenaRefresh({ rebuild: false });
  }
});

resize();
soundBtn.textContent = soundButtonLabel(audio.enabled);
soundBtn.classList.toggle('active', audio.enabled);
updateMp3ModeButton();
setDemoState('empty');
renderTimeline();
render();
renderPanels();
raf = requestAnimationFrame(frame);
