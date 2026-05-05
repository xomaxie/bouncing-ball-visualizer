import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

async function projectFiles() {
  const [html, css, app] = await Promise.all([
    readFile(resolve(root, 'index.html'), 'utf8'),
    readFile(resolve(root, 'styles.css'), 'utf8'),
    readFile(resolve(root, 'src/app.js'), 'utf8'),
  ]);
  return { html, css, app };
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


test('source metadata remains available without visual chrome', async () => {
  const { html } = await projectFiles();

  assert.match(html, /Spotify Basic Pitch/);
  assert.match(html, /https:\/\/github\.com\/spotify\/basic-pitch/);
  assert.match(html, /Mutopia Project/);
  assert.match(html, /Public Domain/);
});
