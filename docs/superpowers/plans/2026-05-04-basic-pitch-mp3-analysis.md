# Basic Pitch MP3 Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a high-accuracy MP3 transcription path powered by Spotify Basic Pitch, while keeping the existing in-browser analyzer as a fast fallback.

**Architecture:** Basic Pitch runs in the browser from vendored JS/model assets so the nginx-hosted static app does not need a new backend process. A small app-facing wrapper resamples uploads to Basic Pitch's required mono 22,050 Hz input, converts predicted notes into the visualizer's existing song/track format, and falls back to the current analyzer if the model fails.

**Tech Stack:** Static HTML/CSS/ES modules, TensorFlow.js via `@spotify/basic-pitch`, existing MIDI/physics solver modules, Node test runner, Playwright live smoke probes.

---

### Task 1: Add Basic Pitch wrapper tests

**Files:**
- Create: `/srv/music-visualizer/tests/basic-pitch-analysis.test.mjs`
- Modify: none

- [ ] Write tests proving Basic Pitch note events are converted into sorted low/mid/high visualizer tracks with normalized velocity and metadata.
- [ ] Write tests proving the MP3 analysis preference tries high accuracy first and falls back to the existing analyzer on failure.
- [ ] Run `npm test -- tests/basic-pitch-analysis.test.mjs` and verify the tests fail because the module does not exist yet.

### Task 2: Implement wrapper and frontend integration

**Files:**
- Create: `/srv/music-visualizer/src/basic-pitch-analysis.js`
- Modify: `/srv/music-visualizer/src/app.js`
- Modify: `/srv/music-visualizer/index.html`
- Modify: `/srv/music-visualizer/styles.css`

- [ ] Implement pure conversion helpers first: `basicPitchNotesToSong()`, `resampleAudioBufferForBasicPitch()`, and `transcribeAudioBufferWithBasicPitch()`.
- [ ] Update `handleFile()` so MP3 upload decodes audio, attempts Basic Pitch high-accuracy analysis with progress text, and falls back to `analyzeAudioBufferToSong()` on error.
- [ ] Update the source panel copy so users know MP3 uploads use Basic Pitch when available.

### Task 3: Vendor Basic Pitch browser assets

**Files:**
- Create: `/srv/music-visualizer/vendor/basic-pitch.bundle.js`
- Create: `/srv/music-visualizer/vendor/basic-pitch/model/model.json`
- Create: `/srv/music-visualizer/vendor/basic-pitch/model/group1-shard1of1.bin`
- Modify: `/srv/music-visualizer/package.json`
- Modify: `/srv/music-visualizer/package-lock.json`

- [ ] Install `@spotify/basic-pitch` as a local dependency.
- [ ] Bundle its browser ESM entry with esbuild into a static vendored module.
- [ ] Copy model assets under the same static `/music-visualizer/vendor/basic-pitch/model/` URL path.

### Task 4: Verify locally and live

**Files:**
- Create or update: `/opt/agent-zero/usr/workdir/browser_task/music_visualizer_basic_pitch_probe_20260504.mjs`

- [ ] Run `npm test` in `/srv/music-visualizer`.
- [ ] Run `node --check` over all app modules and browser probes.
- [ ] Run `nginx -t` and reload nginx if config changed.
- [ ] Curl the live Tailnet URL and vendored model assets.
- [ ] Run a Playwright upload probe with a synthetic MP3 or existing MP3 fixture and confirm high-accuracy source label, note count, and playable hits.

