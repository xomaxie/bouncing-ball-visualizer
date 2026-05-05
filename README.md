# Bouncing Ball Music Visualizer

A self-hostable web music visualizer that turns MIDI, MP3, or temporary YouTube audio imports into a real-time 2D circular physics show. Notes are mapped to colored wall positions, balls are physically launched to hit the right note zones at the right time, and the visual system reacts with light, particles, adaptive energy modes, and instrument-specific ball personalities.

Live demo currently deployed at:

- https://maxscomputers.com/music-visualizer/

## Features

- MIDI upload and public-domain bundled Bach sample.
- MP3 upload with Basic Pitch transcription and fast browser fallback.
- Optional temporary YouTube import using `yt-dlp` + `ffmpeg` behind a rights/permission checkbox.
- Adaptive octave coverage per song.
- Bounce-only retargeting: balls do not fake mid-air course changes.
- Rhythm-ball reuse with stronger low-pocket bounce arcs.
- Energy-based scene modes and instrument/track ball personalities.
- Dark demo UI with impact particles and clipped ball lightfield.
- Lightweight owner auth for a local saved-track library.
- Saved tracks store source media plus precomputed physics plans when enabled.
- Public share links can play a saved track without requiring auth.

## Local development

```bash
npm install
npm test
```

Run the static app with any local HTTP server rooted at this directory.

## Basic Pitch / YouTube backend

The optional backend is in `server/transcribe_api.py`.

```bash
python3 -m venv .basic-pitch-venv
.basic-pitch-venv/bin/pip install -r requirements.txt
.basic-pitch-venv/bin/python -m uvicorn server.transcribe_api:app --host 127.0.0.1 --port 8765
```

For YouTube imports, install `ffmpeg` on the host. Self-hosted instances can set:

- `MUSIC_VISUALIZER_YOUTUBE_MAX_DURATION_SECONDS`
- `MUSIC_VISUALIZER_YOUTUBE_MAX_FILESIZE`
- `MUSIC_VISUALIZER_YOUTUBE_IMPORT_TIMEOUT_SECONDS`
- `MUSIC_VISUALIZER_YOUTUBE_COOKIES_FILE`
- `MUSIC_VISUALIZER_YOUTUBE_PROXY_URL`

The demo is designed to process imported audio temporarily, not store original MP3s.

## Saved track library

The optional library API is intentionally light for self-hosted/demo use. Set these
environment variables on the backend:

- `MUSIC_VISUALIZER_AUTH_TOKEN`: shared owner passphrase / bearer token.
- `MUSIC_VISUALIZER_LIBRARY_DIR`: directory for saved track metadata, source media,
  and cached physics plans. Defaults to `/var/lib/music-visualizer/library`.

Users who know the library key can unlock the panel, save the current track with
its precomputed plan, reopen saved tracks, and create public `?share=` links.
Shared links do not require the library key and expose only that track payload.
