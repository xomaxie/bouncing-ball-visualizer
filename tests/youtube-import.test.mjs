import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

async function projectFiles() {
  const [html, css, app, server] = await Promise.all([
    readFile(resolve(root, 'index.html'), 'utf8'),
    readFile(resolve(root, 'styles.css'), 'utf8'),
    readFile(resolve(root, 'src/app.js'), 'utf8'),
    readFile(resolve(root, 'server/transcribe_api.py'), 'utf8'),
  ]);
  return { html, css, app, server };
}

test('demo upload prompt includes a rights-gated YouTube import option', async () => {
  const { html, css, app } = await projectFiles();

  assert.match(html, /id="youtubeForm"/);
  assert.match(html, /id="youtubeUrl"[^>]*type="url"/);
  assert.match(html, /id="youtubeRights"[^>]*type="checkbox"/);
  assert.match(html, /I have rights or permission to process this media/);
  assert.match(html, /id="youtubeImportBtn"/);
  assert.match(css, /\.urlImport/);
  assert.match(app, /const youtubeForm = document\.querySelector\('#youtubeForm'\)/);
  assert.match(app, /handleYoutubeImport/);
  assert.match(app, /rightsAccepted/);
});

test('YouTube import client posts JSON and returns an audio file object', async () => {
  const module = await import('../src/youtube-import.js');
  const calls = [];
  class FakeFile extends Blob {
    constructor(parts, name, options = {}) {
      super(parts, options);
      this.name = name;
      this.lastModified = options.lastModified || Date.now();
    }
  }
  const fakeFetch = async (url, options) => {
    calls.push({ url, method: options.method, headers: options.headers, body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      headers: {
        get(name) {
          if (name.toLowerCase() === 'content-type') return 'audio/mpeg';
          if (name.toLowerCase() === 'content-disposition') return 'attachment; filename="example-track.mp3"';
          return null;
        },
      },
      async blob() { return new Blob(['mp3-bytes'], { type: 'audio/mpeg' }); },
    };
  };

  const file = await module.fetchYoutubeAudio({
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    rightsAccepted: true,
    endpointUrl: '/music-visualizer/api/basic-pitch/import-youtube',
    fetchImpl: fakeFetch,
    FileCtor: FakeFile,
  });

  assert.equal(file.name, 'example-track.mp3');
  assert.equal(file.type, 'audio/mpeg');
  assert.deepEqual(calls, [{
    url: '/music-visualizer/api/basic-pitch/import-youtube',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', rightsAccepted: true },
  }]);
});

test('YouTube import client rejects unsupported URLs and unchecked rights before fetching', async () => {
  const { fetchYoutubeAudio, isLikelyYouTubeUrl } = await import('../src/youtube-import.js');
  let fetchCalls = 0;
  const fetchImpl = async () => { fetchCalls += 1; throw new Error('should not fetch'); };

  assert.equal(isLikelyYouTubeUrl('https://youtu.be/dQw4w9WgXcQ'), true);
  assert.equal(isLikelyYouTubeUrl('https://music.youtube.com/watch?v=dQw4w9WgXcQ'), true);
  assert.equal(isLikelyYouTubeUrl('https://example.com/watch?v=dQw4w9WgXcQ'), false);

  await assert.rejects(
    fetchYoutubeAudio({ url: 'https://example.com/watch?v=dQw4w9WgXcQ', rightsAccepted: true, fetchImpl }),
    /YouTube URL/,
  );
  await assert.rejects(
    fetchYoutubeAudio({ url: 'https://youtu.be/dQw4w9WgXcQ', rightsAccepted: false, fetchImpl }),
    /rights or permission/,
  );
  assert.equal(fetchCalls, 0);
});

test('server exposes a temporary no-storage yt-dlp import endpoint with bounded downloads', async () => {
  const { server } = await projectFiles();

  assert.match(server, /@app\.post\('\/import-youtube'\)/);
  assert.match(server, /rightsAccepted/);
  assert.match(server, /validate_youtube_url/);
  assert.match(server, /YOUTUBE_ALLOWED_HOSTS/);
  assert.match(server, /--no-playlist/);
  assert.match(server, /--max-downloads/);
  assert.match(server, /--max-filesize/);
  assert.match(server, /--extract-audio/);
  assert.match(server, /--audio-format/);
  assert.match(server, /mp3/);
  assert.match(server, /BackgroundTask/);
  assert.match(server, /shutil\.rmtree/);
  assert.doesNotMatch(server, /cookies-from-browser/);
});
