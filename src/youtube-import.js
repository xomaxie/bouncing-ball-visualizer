export const YOUTUBE_IMPORT_URL = new URL('../api/basic-pitch/import-youtube', import.meta.url).href;

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
]);

export function isLikelyYouTubeUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === 'https:' && (YOUTUBE_HOSTS.has(host) || host.endsWith('.youtube.com'));
  } catch (_) {
    return false;
  }
}

function filenameFromContentDisposition(header) {
  const value = String(header || '');
  const star = value.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (star) {
    try { return decodeURIComponent(star[1].replace(/^"|"$/g, '')); } catch (_) { return star[1]; }
  }
  const quoted = value.match(/filename\s*=\s*"([^"]+)"/i);
  if (quoted) return quoted[1];
  const plain = value.match(/filename\s*=\s*([^;]+)/i);
  return plain ? plain[1].trim().replace(/^"|"$/g, '') : '';
}

function safeAudioFilename(name) {
  const cleaned = String(name || 'youtube-audio.mp3')
    .replace(/[\\/\0-\x1f\x7f]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  if (!cleaned) return 'youtube-audio.mp3';
  return /\.mp3$/i.test(cleaned) ? cleaned : `${cleaned}.mp3`;
}

async function errorMessageFromResponse(response) {
  try {
    const data = await response.json();
    return data?.detail || data?.error || `YouTube import returned ${response.status}`;
  } catch (_) {
    try { return await response.text(); } catch (_) { return `YouTube import returned ${response.status}`; }
  }
}

export async function fetchYoutubeAudio({
  url,
  rightsAccepted,
  endpointUrl = YOUTUBE_IMPORT_URL,
  fetchImpl = globalThis.fetch,
  FileCtor = globalThis.File,
} = {}) {
  const trimmedUrl = String(url || '').trim();
  if (!isLikelyYouTubeUrl(trimmedUrl)) {
    throw new Error('Paste a valid YouTube URL');
  }
  if (!rightsAccepted) {
    throw new Error('Confirm you have rights or permission to process this media');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('Fetch is required for YouTube import');
  }

  const response = await fetchImpl(endpointUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: trimmedUrl, rightsAccepted: true }),
  });
  if (!response.ok) throw new Error(await errorMessageFromResponse(response));

  const contentType = response.headers?.get?.('content-type') || 'audio/mpeg';
  if (!/^audio\//i.test(contentType)) {
    throw new Error('YouTube import did not return an audio file');
  }

  const blob = await response.blob();
  const filename = safeAudioFilename(
    filenameFromContentDisposition(response.headers?.get?.('content-disposition')) ||
    response.headers?.get?.('x-source-title') ||
    'youtube-audio.mp3',
  );

  if (typeof FileCtor === 'function') {
    return new FileCtor([blob], filename, { type: contentType, lastModified: Date.now() });
  }
  blob.name = filename;
  return blob;
}
