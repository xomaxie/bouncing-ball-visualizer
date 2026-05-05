import os
os.environ.setdefault('TF_CPP_MIN_LOG_LEVEL', '2')
os.environ.setdefault('CUDA_VISIBLE_DEVICES', '')

import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from basic_pitch import ICASSP_2022_MODEL_PATH
from basic_pitch.inference import Model, predict

MAX_UPLOAD_BYTES = 100 * 1024 * 1024
MAX_YOUTUBE_DURATION_SECONDS = int(os.environ.get('MUSIC_VISUALIZER_YOUTUBE_MAX_DURATION_SECONDS', '600'))
MAX_YOUTUBE_AUDIO_SIZE = os.environ.get('MUSIC_VISUALIZER_YOUTUBE_MAX_FILESIZE', '100M')
YOUTUBE_IMPORT_TIMEOUT_SECONDS = int(os.environ.get('MUSIC_VISUALIZER_YOUTUBE_IMPORT_TIMEOUT_SECONDS', '240'))
YOUTUBE_COOKIES_FILE_ENV = 'MUSIC_VISUALIZER_YOUTUBE_COOKIES_FILE'
YOUTUBE_PROXY_URL_ENV = 'MUSIC_VISUALIZER_YOUTUBE_PROXY_URL'
TMP_DIR = Path('/tmp/music-visualizer-basic-pitch')
YOUTUBE_TMP_DIR = TMP_DIR / 'youtube-imports'
TMP_DIR.mkdir(parents=True, exist_ok=True)
YOUTUBE_TMP_DIR.mkdir(parents=True, exist_ok=True)

YOUTUBE_ALLOWED_HOSTS = {
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
}

app = FastAPI(title='Music Visualizer Basic Pitch API')
_model: Model | None = None
_model_lock = threading.Lock()
_predict_lock = threading.Lock()
_model_load_seconds: float | None = None




class YoutubeImportRequest(BaseModel):
  url: str
  rightsAccepted: bool = False


def validate_youtube_url(url: str) -> str:
  candidate = str(url or '').strip()
  parsed = urlparse(candidate)
  host = (parsed.hostname or '').lower()
  if parsed.scheme != 'https' or not (host in YOUTUBE_ALLOWED_HOSTS or host.endswith('.youtube.com')):
    raise HTTPException(status_code=400, detail='Paste a valid YouTube URL')

  query = parse_qs(parsed.query)
  if parsed.path.rstrip('/') == '/playlist' or ('list' in query and 'v' not in query and host != 'youtu.be'):
    raise HTTPException(status_code=400, detail='Playlist imports are disabled for this demo')
  return candidate


def safe_download_filename(value: str) -> str:
  cleaned = ''.join(char if char.isalnum() or char in {' ', '.', '-', '_'} else '-' for char in str(value or 'youtube-audio.mp3'))
  cleaned = ' '.join(cleaned.split()).strip()[:160]
  if not cleaned:
    cleaned = 'youtube-audio.mp3'
  return cleaned if cleaned.lower().endswith('.mp3') else f'{cleaned}.mp3'


def cleanup_download_dir(path: Path) -> None:
  shutil.rmtree(path, ignore_errors=True)


def import_error_detail(stderr: str, stdout: str = '') -> str:
  text = '\n'.join(line.strip() for line in f'{stderr}\n{stdout}'.splitlines() if line.strip())
  if not text:
    return 'YouTube import failed'
  lines = text.splitlines()[-6:]
  return 'YouTube import failed: ' + ' | '.join(lines)[:900]


def youtube_import_failure(stderr: str, stdout: str = '') -> tuple[int, str]:
  text = '\n'.join(line.strip() for line in f'{stderr}\n{stdout}'.splitlines() if line.strip())
  lower_text = text.lower()
  if 'sign in to confirm' in lower_text and 'not a bot' in lower_text:
    return (
      424,
      'YouTube blocked this server with a bot check for that video. '
      'The public demo does not use account cookies. '
      f'For a self-hosted instance, configure {YOUTUBE_COOKIES_FILE_ENV} with your own cookies file, or try a different URL.',
    )
  return 502, import_error_detail(stderr, stdout)


def yt_dlp_download_command(url: str, output_template: Path) -> list[str]:
  command = [
    sys.executable,
    '-m',
    'yt_dlp',
    '--ignore-config',
    '--no-playlist',
    '--max-downloads',
    '1',
    '--max-filesize',
    MAX_YOUTUBE_AUDIO_SIZE,
    '--match-filter',
    f'duration <= {MAX_YOUTUBE_DURATION_SECONDS}',
    '--format',
    'bestaudio/best',
    '--extract-audio',
    '--audio-format',
    'mp3',
    '--audio-quality',
    '192K',
    '--output',
    str(output_template),
    '--print',
    'after_move:filepath',
    url,
  ]
  node_path = shutil.which('node')
  if node_path:
    command[-1:-1] = [
      '--js-runtimes',
      f'node:{node_path}',
      '--remote-components',
      'ejs:github',
    ]
  cookies_file = os.environ.get(YOUTUBE_COOKIES_FILE_ENV, '').strip()
  if cookies_file:
    command[-1:-1] = [
      '--cookies',
      cookies_file,
    ]
  proxy_url = os.environ.get(YOUTUBE_PROXY_URL_ENV, '').strip()
  if proxy_url:
    command[-1:-1] = [
      '--proxy',
      proxy_url,
    ]
  return command


def find_downloaded_mp3(job_dir: Path, stdout: str) -> Path | None:
  for line in reversed([item.strip() for item in stdout.splitlines() if item.strip()]):
    candidate = Path(line)
    if candidate.exists() and candidate.suffix.lower() == '.mp3':
      return candidate
  matches = sorted(job_dir.glob('*.mp3'), key=lambda item: item.stat().st_mtime, reverse=True)
  return matches[0] if matches else None

def get_model() -> Model:
  global _model, _model_load_seconds
  if _model is not None:
    return _model
  with _model_lock:
    if _model is None:
      started = time.perf_counter()
      _model = Model(ICASSP_2022_MODEL_PATH)
      _model_load_seconds = time.perf_counter() - started
  return _model


def safe_suffix(filename: str | None) -> str:
  suffix = Path(filename or '').suffix.lower()
  return suffix if suffix in {'.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac'} else '.mp3'


def note_to_json(note: tuple[Any, Any, Any, Any, Any]) -> dict[str, Any]:
  start, end, pitch, amplitude, pitch_bends = note
  start_f = max(0.0, float(start))
  end_f = max(start_f, float(end))
  return {
    'startTimeSeconds': start_f,
    'durationSeconds': max(0.0, end_f - start_f),
    'pitchMidi': int(pitch),
    'amplitude': max(0.0, min(1.0, float(amplitude))),
    'pitchBends': [int(value) for value in pitch_bends] if pitch_bends else None,
  }


@app.get('/healthz')
def healthz() -> dict[str, Any]:
  return {
    'ok': True,
    'modelLoaded': _model is not None,
    'modelLoadSeconds': _model_load_seconds,
  }




@app.post('/import-youtube')
def import_youtube(payload: YoutubeImportRequest) -> FileResponse:
  if not payload.rightsAccepted:
    raise HTTPException(status_code=400, detail='Confirm you have rights or permission to process this media')
  url = validate_youtube_url(payload.url)

  try:
    import yt_dlp  # noqa: F401
  except Exception as exc:
    raise HTTPException(status_code=503, detail='yt-dlp is not installed on this self-hosted visualizer') from exc

  job_dir = YOUTUBE_TMP_DIR / uuid.uuid4().hex
  job_dir.mkdir(parents=True, exist_ok=False)
  output_template = job_dir / '%(title).160B-%(id)s.%(ext)s'
  command = yt_dlp_download_command(url, output_template)

  try:
    result = subprocess.run(
      command,
      cwd=job_dir,
      text=True,
      stdout=subprocess.PIPE,
      stderr=subprocess.PIPE,
      timeout=YOUTUBE_IMPORT_TIMEOUT_SECONDS,
      check=False,
    )
  except subprocess.TimeoutExpired as exc:
    cleanup_download_dir(job_dir)
    raise HTTPException(status_code=504, detail='YouTube import timed out') from exc
  except Exception as exc:
    cleanup_download_dir(job_dir)
    raise HTTPException(status_code=500, detail=f'Could not start YouTube import: {exc}') from exc

  audio_path = find_downloaded_mp3(job_dir, result.stdout)
  result_has_error = 'ERROR:' in f'{result.stderr}\n{result.stdout}'
  if result.returncode != 0 and (audio_path is None or result_has_error):
    cleanup_download_dir(job_dir)
    status_code, detail = youtube_import_failure(result.stderr, result.stdout)
    raise HTTPException(status_code=status_code, detail=detail)

  if audio_path is None or not audio_path.exists() or audio_path.stat().st_size <= 0:
    cleanup_download_dir(job_dir)
    raise HTTPException(
      status_code=422,
      detail=(
        'This YouTube URL could not be imported by this demo. '
        f'It may exceed the configured duration limit of {MAX_YOUTUBE_DURATION_SECONDS} seconds, '
        'have no importable audio, or be unavailable from this self-hosted instance.'
      ),
    )
  if audio_path.stat().st_size > MAX_UPLOAD_BYTES:
    cleanup_download_dir(job_dir)
    raise HTTPException(status_code=413, detail='Imported audio is too large for this visualizer')

  filename = safe_download_filename(audio_path.name)
  return FileResponse(
    audio_path,
    media_type='audio/mpeg',
    filename=filename,
    headers={
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Source-Title': filename,
    },
    background=BackgroundTask(cleanup_download_dir, job_dir),
  )


@app.post('/transcribe')
async def transcribe(file: UploadFile = File(...)) -> dict[str, Any]:
  contents = await file.read()
  if not contents:
    raise HTTPException(status_code=400, detail='Uploaded audio file is empty')
  if len(contents) > MAX_UPLOAD_BYTES:
    raise HTTPException(status_code=413, detail='Uploaded audio file is too large for this visualizer')

  suffix = safe_suffix(file.filename)
  temp_path: Path | None = None
  try:
    with tempfile.NamedTemporaryFile(dir=TMP_DIR, suffix=suffix, delete=False) as handle:
      handle.write(contents)
      temp_path = Path(handle.name)

    model = get_model()
    started = time.perf_counter()
    with _predict_lock:
      _, _, note_events = predict(
        temp_path,
        model,
        onset_threshold=0.25,
        frame_threshold=0.22,
        minimum_note_length=45,
      )
    prediction_seconds = time.perf_counter() - started
    notes = sorted((note_to_json(note) for note in note_events), key=lambda item: (item['startTimeSeconds'], item['pitchMidi']))
    return {
      'notes': notes,
      'analysis': {
        'transcriber': 'spotify-basic-pitch',
        'runtime': 'server',
        'model': 'Basic Pitch 0.4.0 ICASSP 2022 TensorFlow',
        'noteCount': len(notes),
        'predictionSeconds': prediction_seconds,
        'modelLoadSeconds': _model_load_seconds,
        'uploadBytes': len(contents),
        'filename': file.filename or 'audio',
      },
    }
  except HTTPException:
    raise
  except Exception as exc:
    raise HTTPException(status_code=500, detail=f'Basic Pitch transcription failed: {exc}') from exc
  finally:
    if temp_path is not None:
      try:
        temp_path.unlink(missing_ok=True)
      except Exception:
        pass
