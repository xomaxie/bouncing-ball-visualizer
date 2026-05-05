import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

async function projectFiles() {
  const [html, css, app, pkg, pixiLayer] = await Promise.all([
    readFile(resolve(root, 'index.html'), 'utf8'),
    readFile(resolve(root, 'styles.css'), 'utf8'),
    readFile(resolve(root, 'src/app.js'), 'utf8'),
    readFile(resolve(root, 'package.json'), 'utf8'),
    readFile(resolve(root, 'src/pixi-light-layer.js'), 'utf8'),
  ]);
  return { html, css, app, pkg, pixiLayer };
}

test('demo UI starts as a suspended black upload-only screen', async () => {
  const { html, css } = await projectFiles();

  assert.match(html, /<main[^>]*class="demoShell is-empty"/);
  assert.match(html, /class="uploadOverlay"/);
  assert.match(html, /Drop a MIDI or MP3/);
  assert.match(html, /id="midiFile"[^>]*accept="[^"]*\.mp3/);
  assert.match(html, /class="hiddenControls"/);
  assert.doesNotMatch(html, /class="masthead"|class="rail\b|Track allocation|Solver output|Recent wall hits/);
  assert.match(css, /background:\s*#000/);
  assert.match(css, /\.demoShell\.is-empty\s+\.stageModule/);
  assert.match(css, /\.demoShell\.is-ready\s+\.stageModule/);
});

test('demo UI animates from processing upload state into the beat circle', async () => {
  const { html, css, app } = await projectFiles();

  assert.match(html, /id="processingText"/);
  assert.match(css, /\.uploadOverlay/);
  assert.match(css, /transition:[^;]*(opacity|transform)/);
  assert.match(app, /function setDemoState/);
  assert.match(app, /setDemoState\('processing'/);
  assert.match(app, /setDemoState\('ready'/);
  assert.match(app, /beginDemoPlayback/);
});

test('canvas resize measures untransformed layout size so the ready circle stays centered', async () => {
  const { app } = await projectFiles();

  assert.match(app, /clientWidth/);
  assert.match(app, /clientHeight/);
  assert.doesNotMatch(app, /canvas\.parentElement\.getBoundingClientRect\(\)/);
});

test('ready transition schedules a post-layout arena refresh so upload planning stays centered', async () => {
  const { app } = await projectFiles();

  assert.match(app, /const canvasFrame = document\.querySelector\('\.canvasFrame'\)/);
  assert.match(app, /function queueArenaRefresh/);
  assert.match(app, /requestAnimationFrame/);
  assert.match(app, /ResizeObserver/);
  assert.match(app, /transitionend/);
  assert.match(app, /queueArenaRefresh\(\{ rebuild: true/);
});

test('demo canvas includes impact frames and a frequency-reactive circle layer', async () => {
  const { app } = await projectFiles();

  assert.match(app, /visual-effects\.js/);
  assert.match(app, /registerNoteImpact/);
  assert.match(app, /drawExteriorFrequencyField/);
  assert.match(app, /drawImpactFrames/);
  assert.match(app, /decayVisualEffects/);
});

test('impact pulse stays local to the circle instead of brightening the whole screen', async () => {
  const { app } = await projectFiles();

  assert.doesNotMatch(app, /screenImpact \* 0\.025/, 'impact frames should not draw the old whole-canvas brightness flash');
  assert.match(app, /drawLocalizedImpactHalo/);
  assert.match(app, /ctx\.arc\(arena\.cx, arena\.cy, arena\.radius \+ screenImpact \* 14/);
});

test('frequency ribs are intentionally low alpha so they stay behind the ball physics', async () => {
  const { app } = await projectFiles();

  assert.doesNotMatch(app, /Math\.min\(0\.58, energy \* 0\.42\)/);
  assert.match(app, /Math\.min\(0\.082, energy \* 0\.043 \* rippleMultiplier\)/);
  assert.match(app, /scene\.wallRippleMultiplier/);
});

test('frequency visualizer is clipped outside the arena so the circle interior stays dark', async () => {
  const { app } = await projectFiles();

  assert.match(app, /function drawExteriorFrequencyField/);
  assert.match(app, /ctx\.clip\('evenodd'\)/);
  assert.match(app, /arena\.radius \+ 5/);
  assert.doesNotMatch(app, /ctx\.lineTo\(span \* 0\.92, y\)/);
  assert.match(app, /ctx\.moveTo\(arena\.cx - outerReach, arena\.cy \+ y\)/);
  assert.match(app, /ctx\.lineTo\(arena\.cx - span - 14, arena\.cy \+ y\)/);
});

test('inner circle glow is removed so the suspended black stage stays unlit until balls emit light', async () => {
  const { app } = await projectFiles();

  assert.doesNotMatch(app, /ctx\.createRadialGradient\(arena\.cx, arena\.cy, 20, arena\.cx, arena\.cy, arena\.radius \* 1\.3\)/);
  assert.doesNotMatch(app, /rgba\(243,236,214,0\.028\)/);
  assert.doesNotMatch(app, new RegExp(String.raw`ctx\.fillRect\\(0, 0, W, H\\);\n\s*if \(!plan`));
  assert.match(app, /drawLightSystem\(\)/);
});

test('balls use a scene light buffer instead of per-ball fake glow sprites', async () => {
  const { app } = await projectFiles();

  assert.match(app, /let lightCanvas/);
  assert.match(app, /function ensureLightBuffer/);
  assert.match(app, /function drawLightSystem/);
  assert.match(app, /lightCtx\.globalCompositeOperation = 'lighter'/);
  assert.match(app, /ball\.lightEnergy/);
  assert.doesNotMatch(app, /function drawBallEmitter/);
  assert.doesNotMatch(app, /drawBallEmitter\(ball\)/);
});

test('scene light buffer is restrained so balls light the circle without washing it out', async () => {
  const { app } = await projectFiles();

  assert.doesNotMatch(app, /ctx\.globalAlpha = 0\.86/);
  assert.doesNotMatch(app, /ctx\.globalAlpha = 0\.42/);
  assert.match(app, /ctx\.globalAlpha = Math\.min\(0\.36, 0\.28 \+ Math\.max\(0, sceneLight - 1\) \* 0\.12\)/);
  assert.match(app, /ctx\.globalAlpha = Math\.min\(0\.16, 0\.11 \+ Math\.max\(0, sceneLight - 1\) \* 0\.05\)/);
  assert.match(app, /const base = 0\.04 \* Number\(ball\.lightMultiplier \?\? 1\)/);
  assert.match(app, /energizeBallLight\(ball, 0\.15\)/);
});

test('scheduled note impacts draw particle sparks sized by amplitude', async () => {
  const { app } = await projectFiles();

  assert.match(app, /drawImpactParticles/);
  assert.match(app, /particle\.radius/);
  assert.match(app, /particle\.length/);
  assert.match(app, /particle\.vx \* particle\.length/);
  assert.match(app, /particle\.life/);
  assert.match(app, /drawImpactParticles\(\)/);
});

test('demo draws a particle-system black hole and enables stronger real field-solved maneuvers', async () => {
  const { html, app } = await projectFiles();

  assert.match(html, /app\.js\?v=20260505-fine-pixi-lightfield-v1/);
  assert.match(app, /black-hole-particles\.js/);
  assert.match(app, /createBlackHoleParticleSystem/);
  assert.match(app, /advanceBlackHoleParticles/);
  assert.match(app, /blackHoleParticleSnapshots/);
  assert.match(app, /function drawBlackHole/);
  assert.match(app, /ctx\.quadraticCurveTo/);
  assert.match(app, /blackHoleSolveIterations:\s*7/);
  assert.match(app, /blackHoleSolveTolerancePx:\s*3\.75/);
  assert.match(app, /arena\.radius \* arena\.radius \* 92/);
  assert.match(app, /arena\.radius \* 0\.115/);
  assert.match(app, /offsetX:\s*0/);
  assert.match(app, /offsetY:\s*0/);
  assert.doesNotMatch(app, /offsetX:\s*0\.055/);
  assert.doesNotMatch(app, /offsetY:\s*-0\.06/);
  assert.match(app, /blackHoleVisualState/);
  assert.match(app, /blackHoleParticleSnapshots\(system, blackHole, energyState\)/);
  assert.match(app, /drawBlackHole\(\)/);
  assert.match(app, /blackHoleSegments/);
  assert.match(app, /maxBlackHoleMissDistance/);
  assert.doesNotMatch(app, /const shadow = ctx\.createRadialGradient/, 'black hole should be rendered as orbiting particles, not a static gradient image');
});

test('black-hole disc emits energy-scaled light particles using the current dominant note color', async () => {
  const { app } = await projectFiles();

  assert.match(app, /blackHoleLightParticleSnapshots/);
  assert.match(app, /dominantNoteColor/);
  assert.match(app, /dominantNoteEnergy/);
  assert.match(app, /count:\s*520/);
  assert.match(app, /maxParticles:\s*640/);
  assert.match(app, /blackHoleLightParticleCount/);
});


test('black-hole disc light requires the PixiJS library layer instead of hand-drawn fallbacks or light sprites', async () => {
  const { app, pkg, pixiLayer } = await projectFiles();
  const packageJson = JSON.parse(pkg);

  assert.equal(packageJson.dependencies['pixi.js'], '8.18.1');
  assert.match(app, /pixi-light-layer\.js/);
  assert.match(app, /ensurePixiLightLayer/);
  assert.match(app, /renderBlackHoleLightParticlesWithLibrary/);
  assert.doesNotMatch(app, /drawBlackHoleLightParticles/, 'disc light should not keep a canvas fallback renderer');
  assert.doesNotMatch(app, /using canvas fallback|Pixi light layer unavailable/, 'this project should not silently downgrade the black-hole lightfield');
  assert.match(pixiLayer, /vendor\/pixi\/pixi\.esm\.js/);
  assert.match(pixiLayer, /new PIXI\.Application/);
  assert.match(pixiLayer, /blendMode = 'add'|blendMode: 'add'/);
  assert.match(pixiLayer, /new PIXI\.BlurFilter/);
  assert.doesNotMatch(pixiLayer, /drawLightMote|graphic\.circle\(particle\.x/, 'Pixi light particles should be fine streaks, not dot/sprite motes');
  assert.doesNotMatch(app, /createRadialGradient\(particle\.x, particle\.y, 0, particle\.x, particle\.y, glowRadius\)/);
});

test('black-hole energy is smoothed before rendering so the accretion disc does not jerk', async () => {
  const { app } = await projectFiles();

  assert.match(app, /let smoothedBlackHoleEnergy/);
  assert.match(app, /function settleBlackHoleEnergyTarget/);
  assert.match(app, /function advanceSmoothedBlackHoleEnergy/);
  assert.match(app, /blackHoleEnergyState\(\)/);
  assert.match(app, /advanceSmoothedBlackHoleEnergy\(raw\)/);
});

test('source metadata remains available without visual chrome', async () => {
  const { html } = await projectFiles();

  assert.match(html, /Spotify Basic Pitch/);
  assert.match(html, /PixiJS/);
  assert.match(html, /https:\/\/github\.com\/spotify\/basic-pitch/);
  assert.match(html, /Mutopia Project/);
  assert.match(html, /Public Domain/);
});
