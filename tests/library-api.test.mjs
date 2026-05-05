import test from 'node:test';
import assert from 'node:assert/strict';

class FakeFile extends Blob {
  constructor(parts, name, options = {}) {
    super(parts, options);
    this.name = name;
    this.lastModified = options.lastModified || Date.now();
  }
}

function formEntries(formData) {
  return Object.fromEntries([...formData.entries()].map(([key, value]) => [key, value instanceof Blob ? { name: value.name, size: value.size, type: value.type } : value]));
}

test('library client logs in, persists bearer token, and attaches auth to track calls', async () => {
  const module = await import('../src/library-api.js');
  const storage = new Map();
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : null });
    if (String(url).endsWith('/login')) {
      return { ok: true, status: 200, async json() { return { token: 'secret-token', authenticated: true }; } };
    }
    return { ok: true, status: 200, async json() { return { tracks: [] }; } };
  };

  const auth = await module.loginToLibrary({ passphrase: 'open sesame', fetchImpl, storage });
  assert.equal(auth.token, 'secret-token');
  assert.equal(storage.get('musicVisualizerLibraryToken'), 'secret-token');

  await module.listLibraryTracks({ fetchImpl, storage });
  assert.deepEqual(calls, [
    {
      url: new URL('../api/basic-pitch/library/login', import.meta.url).href,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { passphrase: 'open sesame' },
    },
    {
      url: new URL('../api/basic-pitch/library/tracks', import.meta.url).href,
      method: 'GET',
      headers: { Authorization: 'Bearer secret-token' },
      body: null,
    },
  ]);
});

test('library client saves source file with song and precomputed plan JSON', async () => {
  const module = await import('../src/library-api.js');
  const storage = new Map([['musicVisualizerLibraryToken', 'secret-token']]);
  const sourceFile = new FakeFile(['midi bytes'], 'demo.mid', { type: 'audio/midi' });
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method, headers: options.headers, entries: formEntries(options.body) });
    return { ok: true, status: 200, async json() { return { id: 'track-1', title: 'Demo', hasAudio: false, hasPlan: true }; } };
  };

  const saved = await module.saveLibraryTrack({
    title: 'Demo',
    sourceFile,
    song: { format: 'midi', tracks: [{ name: 'lead', notes: [{ time: 0, midi: 60 }] }] },
    plan: { totalBalls: 1, events: [{ id: '0:0' }], arena: { cx: 500, cy: 500, radius: 390 } },
    fetchImpl,
    storage,
  });

  assert.equal(saved.id, 'track-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, new URL('../api/basic-pitch/library/tracks', import.meta.url).href);
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].headers, { Authorization: 'Bearer secret-token' });
  assert.equal(calls[0].entries.title, 'Demo');
  assert.equal(calls[0].entries.song_json, JSON.stringify({ format: 'midi', tracks: [{ name: 'lead', notes: [{ time: 0, midi: 60 }] }] }));
  assert.equal(calls[0].entries.plan_json, JSON.stringify({ totalBalls: 1, events: [{ id: '0:0' }], arena: { cx: 500, cy: 500, radius: 390 } }));
  assert.deepEqual(calls[0].entries.source_file, { name: 'demo.mid', size: 10, type: 'audio/midi' });
});

test('library client reads share links without auth and exposes share URL', async () => {
  const module = await import('../src/library-api.js');
  const storage = new Map([['musicVisualizerLibraryToken', 'secret-token']]);
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', headers: options.headers || {} });
    if (String(url).endsWith('/share')) {
      return { ok: true, status: 200, async json() { return { shareToken: 'abc123', shareUrl: '/music-visualizer/?share=abc123' }; } };
    }
    return { ok: true, status: 200, async json() { return { id: 'track-1', title: 'Shared', song: { tracks: [] }, plan: { events: [] }, audioUrl: '/audio.mp3' }; } };
  };

  const share = await module.createShareLink({ trackId: 'track-1', fetchImpl, storage });
  const track = await module.loadSharedTrack({ shareToken: 'abc123', fetchImpl });

  assert.equal(share.shareUrl, '/music-visualizer/?share=abc123');
  assert.equal(track.title, 'Shared');
  assert.deepEqual(calls, [
    {
      url: new URL('../api/basic-pitch/library/tracks/track-1/share', import.meta.url).href,
      method: 'POST',
      headers: { Authorization: 'Bearer secret-token' },
    },
    {
      url: new URL('../api/basic-pitch/library/share/abc123', import.meta.url).href,
      method: 'GET',
      headers: {},
    },
  ]);
});
