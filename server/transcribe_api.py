import os
import hmac
import json
import mimetypes
import re
import secrets
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

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from basic_pitch import ICASSP_2022_MODEL_PATH
from basic_pitch.inference import Model, predict

MAX_UPLOAD_BYTES = 250 * 1024 * 1024
MAX_YOUTUBE_DURATION_SECONDS = int(os.environ.get('MUSIC_VISUALIZER_YOUTUBE_MAX_DURATION_SECONDS', '3600'))
MAX_YOUTUBE_AUDIO_SIZE = os.environ.get('MUSIC_VISUALIZER_YOUTUBE_MAX_FILESIZE', '250M')
YOUTUBE_IMPORT_TIMEOUT_SECONDS = int(os.environ.get('MUSIC_VISUALIZER_YOUTUBE_IMPORT_TIMEOUT_SECONDS', '900'))
YOUTUBE_COOKIES_FILE_ENV = 'MUSIC_VISUALIZER_YOUTUBE_COOKIES_FILE'
YOUTUBE_PROXY_URL_ENV = 'MUSIC_VISUALIZER_YOUTUBE_PROXY_URL'
TMP_DIR = Path('/tmp/music-visualizer-basic-pitch')
LIBRARY_DIR_ENV = 'MUSIC_VISUALIZER_LIBRARY_DIR'
LIBRARY_AUTH_TOKEN_ENV = 'MUSIC_VISUALIZER_AUTH_TOKEN'
DEFAULT_LIBRARY_DIR = Path('/var/lib/music-visualizer/library')
MAX_LIBRARY_JSON_BYTES = int(os.environ.get('MUSIC_VISUALIZER_MAX_LIBRARY_JSON_BYTES', '60000000'))
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



class LibraryLoginRequest(BaseModel):
  passphrase: str


def library_root() -> Path:
  return Path(os.environ.get(LIBRARY_DIR_ENV, str(DEFAULT_LIBRARY_DIR))).expanduser()


def library_tracks_root() -> Path:
  root = library_root() / 'tracks'
  root.mkdir(parents=True, exist_ok=True)
  return root


def library_auth_token() -> str:
  token = os.environ.get(LIBRARY_AUTH_TOKEN_ENV, '').strip()
  if not token:
    raise HTTPException(status_code=503, detail=f'Library auth is not configured. Set {LIBRARY_AUTH_TOKEN_ENV} for this self-hosted instance.')
  return token


def require_library_auth(authorization: str | None = Header(default=None)) -> bool:
  expected = library_auth_token()
  raw = str(authorization or '').strip()
  prefix = 'Bearer '
  supplied = raw[len(prefix):].strip() if raw.lower().startswith(prefix.lower()) else raw
  if not supplied or not hmac.compare_digest(supplied, expected):
    raise HTTPException(status_code=401, detail='Library authentication required')
  return True


def safe_track_component(value: str, fallback: str = 'track') -> str:
  cleaned = re.sub(r'[^A-Za-z0-9._ -]+', '-', str(value or fallback)).strip(' .-_')
  cleaned = re.sub(r'\s+', ' ', cleaned)[:160].strip()
  return cleaned or fallback


def safe_track_id(value: str) -> str:
  track_id = str(value or '').strip()
  if not re.fullmatch(r'[a-f0-9]{24,40}', track_id):
    raise HTTPException(status_code=404, detail='Track not found')
  return track_id


def safe_share_token(value: str) -> str:
  token = str(value or '').strip()
  if not re.fullmatch(r'[A-Za-z0-9_-]{18,80}', token):
    raise HTTPException(status_code=404, detail='Shared track not found')
  return token


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
  path.parent.mkdir(parents=True, exist_ok=True)
  tmp_path = path.with_suffix(path.suffix + '.tmp')
  tmp_path.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True), encoding='utf-8')
  tmp_path.replace(path)


def read_json(path: Path) -> dict[str, Any]:
  try:
    return json.loads(path.read_text(encoding='utf-8'))
  except FileNotFoundError as exc:
    raise HTTPException(status_code=404, detail='Track not found') from exc
  except json.JSONDecodeError as exc:
    raise HTTPException(status_code=500, detail='Stored track metadata is corrupt') from exc


def count_song_notes(song: dict[str, Any]) -> int:
  tracks = song.get('tracks') if isinstance(song, dict) else []
  if not isinstance(tracks, list):
    return 0
  return sum(len(track.get('notes') or []) for track in tracks if isinstance(track, dict))


def track_dir(track_id: str) -> Path:
  return library_tracks_root() / safe_track_id(track_id)


def meta_path_for(track_id: str) -> Path:
  return track_dir(track_id) / 'meta.json'


def source_filename_for(filename: str | None) -> str:
  suffix = Path(filename or '').suffix.lower()
  if suffix not in {'.mid', '.midi', '.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac'}:
    suffix = '.bin'
  stem = safe_track_component(Path(filename or 'source').stem, 'source')
  return f'{stem}{suffix}'


def store_library_track(
  *,
  title: str,
  source_filename: str | None = None,
  source_bytes: bytes | None = None,
  song: dict[str, Any],
  plan: dict[str, Any],
) -> dict[str, Any]:
  track_id = secrets.token_hex(16)
  root = track_dir(track_id)
  root.mkdir(parents=True, exist_ok=False)
  safe_title = safe_track_component(title, 'Untitled track')
  created_at = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())

  source_name = None
  source_rel = None
  has_audio = False
  if source_bytes:
    source_name = source_filename_for(source_filename)
    source_path = root / source_name
    source_path.write_bytes(source_bytes)
    source_rel = source_name
    has_audio = source_path.suffix.lower() in {'.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac'}

  write_json_atomic(root / 'song.json', song)
  write_json_atomic(root / 'plan.json', plan)
  meta = {
    'id': track_id,
    'title': safe_title,
    'createdAt': created_at,
    'updatedAt': created_at,
    'sourceFilename': source_name,
    'sourceRelPath': source_rel,
    'hasSource': bool(source_rel),
    'hasAudio': bool(has_audio),
    'hasPlan': True,
    'noteCount': count_song_notes(song),
    'ballCount': int(plan.get('totalBalls') or 0) if isinstance(plan, dict) else 0,
    'duration': float(plan.get('duration') or 0) if isinstance(plan, dict) else 0,
  }
  write_json_atomic(root / 'meta.json', meta)
  return meta


def list_library_tracks() -> list[dict[str, Any]]:
  root = library_tracks_root()
  tracks = []
  for path in root.glob('*/meta.json'):
    try:
      tracks.append(read_json(path))
    except HTTPException:
      continue
  return sorted(tracks, key=lambda item: item.get('createdAt', ''), reverse=True)


def read_library_track(track_id: str) -> dict[str, Any]:
  root = track_dir(track_id)
  meta = read_json(root / 'meta.json')
  song = read_json(root / 'song.json')
  plan = read_json(root / 'plan.json')
  source_path = root / meta['sourceRelPath'] if meta.get('sourceRelPath') else None
  payload = {
    **meta,
    'song': song,
    'plan': plan,
    'audioUrl': f'/music-visualizer/api/basic-pitch/library/tracks/{meta["id"]}/audio' if meta.get('hasAudio') else None,
  }
  if source_path is not None:
    payload['sourcePath'] = str(source_path)
  return payload


def create_library_share(track_id: str) -> dict[str, Any]:
  root = track_dir(track_id)
  meta = read_json(root / 'meta.json')
  token = meta.get('shareToken') or secrets.token_urlsafe(24)
  now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
  meta = {**meta, 'shareToken': token, 'shareCreatedAt': meta.get('shareCreatedAt') or now, 'updatedAt': now}
  write_json_atomic(root / 'meta.json', meta)
  return {
    'id': meta['id'],
    'title': meta['title'],
    'shareToken': token,
    'shareUrl': f'/music-visualizer/?share={token}',
  }


def find_track_id_by_share_token(share_token: str) -> str:
  token = safe_share_token(share_token)
  for meta in list_library_tracks():
    if hmac.compare_digest(str(meta.get('shareToken') or ''), token):
      return meta['id']
  raise HTTPException(status_code=404, detail='Shared track not found')


def read_shared_library_track(share_token: str) -> dict[str, Any]:
  token = safe_share_token(share_token)
  track_id = find_track_id_by_share_token(token)
  payload = read_library_track(track_id)
  payload['shareToken'] = token
  payload['audioUrl'] = f'/music-visualizer/api/basic-pitch/library/share/{token}/audio' if payload.get('hasAudio') else None
  return payload


def source_path_for_track(track_id: str) -> Path:
  payload = read_library_track(track_id)
  path = payload.get('sourcePath')
  if not path:
    raise HTTPException(status_code=404, detail='Track has no stored audio')
  source = Path(path)
  if not source.exists():
    raise HTTPException(status_code=404, detail='Stored audio is missing')
  return source


def public_library_track_payload(payload: dict[str, Any]) -> dict[str, Any]:
  return {key: value for key, value in payload.items() if key != 'sourcePath'}


def parse_library_json_field(value: str, field_name: str) -> dict[str, Any]:
  raw = str(value or '')
  if len(raw.encode('utf-8')) > MAX_LIBRARY_JSON_BYTES:
    raise HTTPException(status_code=413, detail=f'{field_name} is too large to store')
  try:
    parsed = json.loads(raw)
  except json.JSONDecodeError as exc:
    raise HTTPException(status_code=400, detail=f'{field_name} must be valid JSON') from exc
  if not isinstance(parsed, dict):
    raise HTTPException(status_code=400, detail=f'{field_name} must be a JSON object')
  return parsed


def file_response_for_source(source_path: Path) -> FileResponse:
  media_type = mimetypes.guess_type(str(source_path))[0] or 'application/octet-stream'
  return FileResponse(
    source_path,
    media_type=media_type,
    filename=source_path.name,
    headers={
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    },
  )



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

@app.post('/library/login')
def library_login(payload: LibraryLoginRequest) -> dict[str, Any]:
  expected = library_auth_token()
  supplied = str(payload.passphrase or '').strip()
  if not supplied or not hmac.compare_digest(supplied, expected):
    raise HTTPException(status_code=401, detail='Invalid library passphrase')
  return {'authenticated': True, 'token': expected}


@app.get('/library/tracks')
def library_tracks(_: bool = Depends(require_library_auth)) -> dict[str, Any]:
  return {'tracks': list_library_tracks()}


@app.post('/library/tracks')
async def create_library_track(
  title: str = Form(...),
  song_json: str = Form(...),
  plan_json: str = Form(...),
  source_file: UploadFile | None = File(default=None),
  _: bool = Depends(require_library_auth),
) -> dict[str, Any]:
  song = parse_library_json_field(song_json, 'song_json')
  plan = parse_library_json_field(plan_json, 'plan_json')
  source_bytes = None
  source_filename = None
  if source_file is not None:
    source_bytes = await source_file.read()
    if len(source_bytes) > MAX_UPLOAD_BYTES:
      raise HTTPException(status_code=413, detail='Stored source file is too large for this visualizer')
    source_filename = source_file.filename or 'source'
  return store_library_track(
    title=title,
    source_filename=source_filename,
    source_bytes=source_bytes,
    song=song,
    plan=plan,
  )


@app.get('/library/tracks/{track_id}')
def get_library_track(track_id: str, _: bool = Depends(require_library_auth)) -> dict[str, Any]:
  return public_library_track_payload(read_library_track(track_id))


@app.get('/library/tracks/{track_id}/audio')
def get_library_track_audio(track_id: str, _: bool = Depends(require_library_auth)) -> FileResponse:
  return file_response_for_source(source_path_for_track(track_id))


@app.post('/library/tracks/{track_id}/share')
def share_library_track(track_id: str, _: bool = Depends(require_library_auth)) -> dict[str, Any]:
  return create_library_share(track_id)


@app.get('/library/share/{share_token}')
def get_shared_library_track(share_token: str) -> dict[str, Any]:
  return public_library_track_payload(read_shared_library_track(share_token))


@app.get('/library/share/{share_token}/audio')
def get_shared_library_track_audio(share_token: str) -> FileResponse:
  shared = read_shared_library_track(share_token)
  return file_response_for_source(source_path_for_track(shared['id']))



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
