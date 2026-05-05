export const LIBRARY_API_URL = new URL('../api/basic-pitch/library', import.meta.url).href;
export const LIBRARY_TOKEN_KEY = 'musicVisualizerLibraryToken';

function storageGet(storage, key) {
  if (!storage) return null;
  if (typeof storage.getItem === 'function') return storage.getItem(key);
  if (typeof storage.get === 'function') return storage.get(key);
  return storage[key] ?? null;
}

function storageSet(storage, key, value) {
  if (!storage) return;
  if (typeof storage.setItem === 'function') storage.setItem(key, value);
  else if (typeof storage.set === 'function') storage.set(key, value);
  else storage[key] = value;
}

function storageRemove(storage, key) {
  if (!storage) return;
  if (typeof storage.removeItem === 'function') storage.removeItem(key);
  else if (typeof storage.delete === 'function') storage.delete(key);
  else delete storage[key];
}

function defaultStorage() {
  try { return globalThis.localStorage || null; }
  catch (_) { return null; }
}

function apiUrl(path = '') {
  const normalized = String(path || '').replace(/^\/+/, '');
  return normalized ? `${LIBRARY_API_URL}/${normalized}` : LIBRARY_API_URL;
}

async function responseJson(response) {
  try { return await response.json(); }
  catch (_) { return null; }
}

async function requireOk(response, fallbackMessage) {
  if (response.ok) return response;
  const data = await responseJson(response);
  const detail = data?.detail || data?.message || fallbackMessage || `Request failed (${response.status})`;
  throw new Error(detail);
}

export function getLibraryToken({ storage = defaultStorage() } = {}) {
  return storageGet(storage, LIBRARY_TOKEN_KEY) || '';
}

export function setLibraryToken(token, { storage = defaultStorage() } = {}) {
  const value = String(token || '').trim();
  if (value) storageSet(storage, LIBRARY_TOKEN_KEY, value);
  else storageRemove(storage, LIBRARY_TOKEN_KEY);
  return value;
}

export function libraryAuthHeaders({ storage = defaultStorage(), token = null } = {}) {
  const value = String(token || getLibraryToken({ storage }) || '').trim();
  return value ? { Authorization: `Bearer ${value}` } : {};
}

export async function loginToLibrary({ passphrase, fetchImpl = globalThis.fetch, storage = defaultStorage() } = {}) {
  const trimmed = String(passphrase || '').trim();
  if (!trimmed) throw new Error('Enter the library passphrase');
  const response = await fetchImpl(apiUrl('login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passphrase: trimmed }),
  });
  await requireOk(response, 'Library login failed');
  const data = await response.json();
  if (!data?.token) throw new Error('Library login did not return a token');
  setLibraryToken(data.token, { storage });
  return data;
}

export async function listLibraryTracks({ fetchImpl = globalThis.fetch, storage = defaultStorage() } = {}) {
  const response = await fetchImpl(apiUrl('tracks'), {
    method: 'GET',
    headers: libraryAuthHeaders({ storage }),
  });
  await requireOk(response, 'Could not load library tracks');
  return response.json();
}

export async function saveLibraryTrack({ title, sourceFile = null, song, plan, fetchImpl = globalThis.fetch, storage = defaultStorage() } = {}) {
  if (!song?.tracks) throw new Error('No song is ready to save');
  if (!plan?.events) throw new Error('No precomputed plan is ready to save');
  const form = new FormData();
  form.set('title', String(title || 'Untitled track'));
  form.set('song_json', JSON.stringify(song));
  form.set('plan_json', JSON.stringify(plan));
  if (sourceFile) form.set('source_file', sourceFile, sourceFile.name || 'source-audio');
  const response = await fetchImpl(apiUrl('tracks'), {
    method: 'POST',
    headers: libraryAuthHeaders({ storage }),
    body: form,
  });
  await requireOk(response, 'Could not save track');
  return response.json();
}

export async function loadLibraryTrack({ trackId, fetchImpl = globalThis.fetch, storage = defaultStorage() } = {}) {
  const id = encodeURIComponent(String(trackId || '').trim());
  if (!id) throw new Error('Choose a saved track');
  const response = await fetchImpl(apiUrl(`tracks/${id}`), {
    method: 'GET',
    headers: libraryAuthHeaders({ storage }),
  });
  await requireOk(response, 'Could not load saved track');
  return response.json();
}

export async function createShareLink({ trackId, fetchImpl = globalThis.fetch, storage = defaultStorage() } = {}) {
  const id = encodeURIComponent(String(trackId || '').trim());
  if (!id) throw new Error('Save or choose a track first');
  const response = await fetchImpl(apiUrl(`tracks/${id}/share`), {
    method: 'POST',
    headers: libraryAuthHeaders({ storage }),
  });
  await requireOk(response, 'Could not create share link');
  return response.json();
}

export async function loadSharedTrack({ shareToken, fetchImpl = globalThis.fetch } = {}) {
  const token = encodeURIComponent(String(shareToken || '').trim());
  if (!token) throw new Error('Missing share token');
  const response = await fetchImpl(apiUrl(`share/${token}`), {
    method: 'GET',
    headers: {},
  });
  await requireOk(response, 'Could not load shared track');
  return response.json();
}
