export const ROYALTY_FREE_SAMPLES = [
  {
    id: 'bach-bwv846-guitar-duo-mutopia',
    title: 'BWV 846 Prelude I, guitar duo',
    composer: 'J. S. Bach',
    sourceName: 'Mutopia Project',
    sourceUrl: 'https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=2206',
    midiUrl: './assets/midi/bach-bwv846-guitar-duo.mid',
    licenseName: 'Public Domain',
    licenseUrl: 'https://www.mutopiaproject.org/legal.html',
    credit: 'Typeset for the Mutopia Project from D B Mus. ms. Bach P 202; maintained by Jeffrey Olson.',
  },
];

export function sampleLabel(sample) {
  return `${sample.composer} — ${sample.title} · ${sample.licenseName}`;
}

export async function fetchSampleMidi(sample, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('Fetch is not available for loading bundled samples');
  const response = await fetchImpl(sample.midiUrl);
  if (!response.ok) throw new Error(`Could not load bundled sample: HTTP ${response.status}`);
  return response.arrayBuffer();
}
