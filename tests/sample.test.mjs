import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseMidiFile } from '../src/midi.js';
import { ROYALTY_FREE_SAMPLES, sampleLabel } from '../src/samples.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

test('bundled sample metadata identifies a public-domain Mutopia MIDI source', () => {
  const [sample] = ROYALTY_FREE_SAMPLES;

  assert.equal(sample.id, 'bach-bwv846-guitar-duo-mutopia');
  assert.match(sample.title, /BWV 846/);
  assert.equal(sample.composer, 'J. S. Bach');
  assert.equal(sample.licenseName, 'Public Domain');
  assert.equal(sample.sourceName, 'Mutopia Project');
  assert.equal(sample.sourceUrl, 'https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=2206');
  assert.equal(sample.licenseUrl, 'https://www.mutopiaproject.org/legal.html');
  assert.equal(sample.midiUrl, './assets/midi/bach-bwv846-guitar-duo.mid');
  assert.equal(sampleLabel(sample), 'J. S. Bach — BWV 846 Prelude I, guitar duo · Public Domain');
});

test('bundled public-domain MIDI parses into playable multi-track note data', async () => {
  const [sample] = ROYALTY_FREE_SAMPLES;
  const bytes = await readFile(resolve(root, sample.midiUrl.replace(/^\.\//, '')));
  const parsed = parseMidiFile(bytes);
  const playable = parsed.tracks.filter((track) => track.notes.length > 0);
  const totalNotes = playable.reduce((sum, track) => sum + track.notes.length, 0);

  assert.equal(parsed.format, 1);
  assert.ok(parsed.duration > 120, `expected a real multi-minute MIDI, got ${parsed.duration}s`);
  assert.equal(playable.length, 2);
  assert.ok(totalNotes > 500, `expected rich note data, got ${totalNotes} notes`);
  assert.deepEqual(playable.map((track) => track.name), ['upper:1', 'lower:2']);
});
