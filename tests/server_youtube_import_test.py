import asyncio
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

from server import transcribe_api


class YoutubeImportServerTest(unittest.TestCase):
  def test_youtube_import_requires_rights_checkbox(self):
    payload = transcribe_api.YoutubeImportRequest(
      url='https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      rightsAccepted=False,
    )
    with self.assertRaises(HTTPException) as raised:
      transcribe_api.import_youtube(payload)
    self.assertEqual(raised.exception.status_code, 400)
    self.assertIn('rights', raised.exception.detail)

  def test_youtube_import_rejects_non_youtube_url(self):
    payload = transcribe_api.YoutubeImportRequest(
      url='https://example.com/watch?v=dQw4w9WgXcQ',
      rightsAccepted=True,
    )
    with self.assertRaises(HTTPException) as raised:
      transcribe_api.import_youtube(payload)
    self.assertEqual(raised.exception.status_code, 400)
    self.assertIn('YouTube URL', raised.exception.detail)

  def test_youtube_import_streams_temporary_mp3_and_removes_job_dir(self):
    created_job_dirs = []

    def fake_run(command, cwd, text, stdout, stderr, timeout, check):
      job_dir = Path(cwd)
      created_job_dirs.append(job_dir)
      output = job_dir / 'small-demo.mp3'
      output.write_bytes(b'fake mp3 bytes')
      self.assertIn('--no-playlist', command)
      self.assertIn('--max-downloads', command)
      self.assertIn('--extract-audio', command)
      self.assertIn('--audio-format', command)
      self.assertIn('mp3', command)
      return SimpleNamespace(returncode=0, stdout=str(output), stderr='')

    payload = transcribe_api.YoutubeImportRequest(
      url='https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      rightsAccepted=True,
    )
    with patch('server.transcribe_api.subprocess.run', side_effect=fake_run):
      response = transcribe_api.import_youtube(payload)

    self.assertEqual(response.media_type, 'audio/mpeg')
    self.assertEqual(response.headers['cache-control'], 'no-store')
    self.assertTrue(Path(response.path).exists())
    self.assertEqual(Path(response.path).read_bytes(), b'fake mp3 bytes')
    self.assertTrue(created_job_dirs)
    asyncio.run(response.background())
    self.assertTrue(all(not path.exists() for path in created_job_dirs))

  def test_youtube_import_command_uses_available_node_js_runtime(self):
    with patch('server.transcribe_api.shutil.which', return_value='/usr/bin/node'):
      command = transcribe_api.yt_dlp_download_command(
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        Path('/tmp/%(title)s.%(ext)s'),
      )

    self.assertIn('--js-runtimes', command)
    runtime_index = command.index('--js-runtimes') + 1
    self.assertEqual(command[runtime_index], 'node:/usr/bin/node')

  def test_youtube_import_allows_max_downloads_exit_when_mp3_was_created(self):
    def fake_run(command, cwd, text, stdout, stderr, timeout, check):
      job_dir = Path(cwd)
      output = job_dir / 'complete-demo.mp3'
      output.write_bytes(b'complete mp3 bytes')
      return SimpleNamespace(
        returncode=101,
        stdout=str(output),
        stderr='Maximum number of downloads reached',
      )

    payload = transcribe_api.YoutubeImportRequest(
      url='https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      rightsAccepted=True,
    )
    with patch('server.transcribe_api.subprocess.run', side_effect=fake_run):
      response = transcribe_api.import_youtube(payload)

    self.assertEqual(response.media_type, 'audio/mpeg')
    self.assertTrue(Path(response.path).exists())
    asyncio.run(response.background())

  def test_youtube_import_bot_check_is_reported_as_user_visible_import_block(self):
    def fake_run(command, cwd, text, stdout, stderr, timeout, check):
      return SimpleNamespace(
        returncode=1,
        stdout='',
        stderr='ERROR: [youtube] TXXij4BY_PI: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.',
      )

    payload = transcribe_api.YoutubeImportRequest(
      url='https://youtu.be/TXXij4BY_PI',
      rightsAccepted=True,
    )
    with patch('server.transcribe_api.subprocess.run', side_effect=fake_run):
      with self.assertRaises(HTTPException) as raised:
        transcribe_api.import_youtube(payload)

    self.assertEqual(raised.exception.status_code, 424)
    self.assertIn('YouTube blocked this server with a bot check', raised.exception.detail)
    self.assertIn('self-hosted', raised.exception.detail)

  def test_youtube_import_no_output_reports_import_limit_instead_of_bad_gateway(self):
    def fake_run(command, cwd, text, stdout, stderr, timeout, check):
      return SimpleNamespace(returncode=0, stdout='', stderr='')

    payload = transcribe_api.YoutubeImportRequest(
      url='https://youtu.be/TXXij4BY_PI',
      rightsAccepted=True,
    )
    with patch('server.transcribe_api.subprocess.run', side_effect=fake_run):
      with self.assertRaises(HTTPException) as raised:
        transcribe_api.import_youtube(payload)

    self.assertEqual(raised.exception.status_code, 422)
    self.assertIn('could not be imported', raised.exception.detail)
    self.assertIn('duration', raised.exception.detail)

  def test_youtube_import_command_uses_configured_cookies_file_for_self_hosted_instances(self):
    with patch.dict('server.transcribe_api.os.environ', {
      'MUSIC_VISUALIZER_YOUTUBE_COOKIES_FILE': '/srv/music-visualizer/private/youtube-cookies.txt',
    }):
      command = transcribe_api.yt_dlp_download_command(
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        Path('/tmp/%(title)s.%(ext)s'),
      )

    self.assertIn('--cookies', command)
    cookies_index = command.index('--cookies') + 1
    self.assertEqual(command[cookies_index], '/srv/music-visualizer/private/youtube-cookies.txt')

  def test_youtube_import_command_uses_configured_proxy_for_self_hosted_instances(self):
    with patch.dict('server.transcribe_api.os.environ', {
      'MUSIC_VISUALIZER_YOUTUBE_PROXY_URL': 'socks5h://127.0.0.1:18885',
    }):
      command = transcribe_api.yt_dlp_download_command(
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        Path('/tmp/%(title)s.%(ext)s'),
      )

    self.assertIn('--proxy', command)
    proxy_index = command.index('--proxy') + 1
    self.assertEqual(command[proxy_index], 'socks5h://127.0.0.1:18885')

  def test_youtube_import_command_allows_youtube_remote_js_solver_with_node(self):
    with patch('server.transcribe_api.shutil.which', return_value='/usr/bin/node'):
      command = transcribe_api.yt_dlp_download_command(
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        Path('/tmp/%(title)s.%(ext)s'),
      )

    self.assertIn('--remote-components', command)
    remote_index = command.index('--remote-components') + 1
    self.assertEqual(command[remote_index], 'ejs:github')

  def test_youtube_import_defaults_allow_one_hour_and_250mb_audio(self):
    command = transcribe_api.yt_dlp_download_command(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      Path('/tmp/%(title)s.%(ext)s'),
    )

    filesize_index = command.index('--max-filesize') + 1
    match_filter_index = command.index('--match-filter') + 1
    self.assertEqual(command[filesize_index], '250M')
    self.assertEqual(command[match_filter_index], 'duration <= 3600')
    self.assertEqual(transcribe_api.MAX_UPLOAD_BYTES, 250 * 1024 * 1024)
    self.assertGreaterEqual(transcribe_api.YOUTUBE_IMPORT_TIMEOUT_SECONDS, 900)


if __name__ == '__main__':
  unittest.main()

class LibraryStorageServerTest(unittest.TestCase):
  def test_library_auth_requires_configured_bearer_token(self):
    with patch.dict('server.transcribe_api.os.environ', {'MUSIC_VISUALIZER_AUTH_TOKEN': 'secret'}, clear=False):
      with self.assertRaises(HTTPException) as raised:
        transcribe_api.require_library_auth(None)
      self.assertEqual(raised.exception.status_code, 401)
      self.assertTrue(transcribe_api.require_library_auth('Bearer secret'))

  def test_library_stores_source_song_and_precomputed_plan_then_lists_it(self):
    with tempfile.TemporaryDirectory() as tmp:
      with patch.dict('server.transcribe_api.os.environ', {'MUSIC_VISUALIZER_LIBRARY_DIR': tmp}, clear=False):
        stored = transcribe_api.store_library_track(
          title='Demo Track',
          source_filename='demo.mid',
          source_bytes=b'midi bytes',
          song={'format': 'midi', 'tracks': [{'name': 'lead', 'notes': [{'time': 0, 'midi': 60}]}]},
          plan={'totalBalls': 1, 'events': [{'id': '0:0'}], 'arena': {'cx': 500, 'cy': 500, 'radius': 390}},
        )
        self.assertEqual(stored['title'], 'Demo Track')
        self.assertTrue(stored['hasSource'])
        self.assertTrue(stored['hasPlan'])

        tracks = transcribe_api.list_library_tracks()
        self.assertEqual([track['id'] for track in tracks], [stored['id']])
        loaded = transcribe_api.read_library_track(stored['id'])
        self.assertEqual(loaded['song']['tracks'][0]['name'], 'lead')
        self.assertEqual(loaded['plan']['totalBalls'], 1)
        self.assertTrue(Path(loaded['sourcePath']).exists())

  def test_library_share_token_loads_track_without_auth(self):
    with tempfile.TemporaryDirectory() as tmp:
      with patch.dict('server.transcribe_api.os.environ', {'MUSIC_VISUALIZER_LIBRARY_DIR': tmp}, clear=False):
        stored = transcribe_api.store_library_track(
          title='Share Me',
          source_filename='share.mp3',
          source_bytes=b'mp3 bytes',
          song={'format': 'basic-pitch', 'tracks': []},
          plan={'totalBalls': 0, 'events': []},
        )
        share = transcribe_api.create_library_share(stored['id'])
        self.assertRegex(share['shareToken'], r'^[A-Za-z0-9_-]{18,}$')
        shared = transcribe_api.read_shared_library_track(share['shareToken'])
        self.assertEqual(shared['id'], stored['id'])
        self.assertEqual(shared['title'], 'Share Me')
        self.assertTrue(shared['audioUrl'].endswith(f"/library/share/{share['shareToken']}/audio"))
