import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMidiFile, createDemoMidiBytes } from '../src/midi.js';

function vlq(value) {
  let buffer = value & 0x7f;
  const bytes = [];
  while ((value >>= 7)) {
    buffer <<= 8;
    buffer |= ((value & 0x7f) | 0x80);
  }
  while (true) {
    bytes.push(buffer & 0xff);
    if (buffer & 0x80) buffer >>= 8;
    else break;
  }
  return bytes;
}

function ascii(text) {
  return [...text].map((char) => char.charCodeAt(0));
}

function u16(value) {
  return [(value >> 8) & 0xff, value & 0xff];
}

function u32(value) {
  return [(value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function trackChunk(events) {
  return [...ascii('MTrk'), ...u32(events.length), ...events];
}

function createFormat0MultiChannelMidiBytes() {
  const events = [
    ...vlq(0), 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,
    ...vlq(0), 0xc0, 30,
    ...vlq(0), 0xc1, 34,
    ...vlq(0), 0xc9, 0,
    ...vlq(0), 0x90, 64, 100,
    ...vlq(120), 0x91, 40, 110,
    ...vlq(120), 0x99, 36, 120,
    ...vlq(120), 0x80, 64, 0,
    ...vlq(0), 0x81, 40, 0,
    ...vlq(0), 0x89, 36, 0,
    ...vlq(0), 0xff, 0x2f, 0x00,
  ];

  return new Uint8Array([
    ...ascii('MThd'), ...u32(6), ...u16(0), ...u16(1), ...u16(480),
    ...trackChunk(events),
  ]);
}

test('parseMidiFile reads tempo, track names, and paired note events from a standard MIDI file', () => {
  const midi = parseMidiFile(createDemoMidiBytes());

  assert.equal(midi.format, 1);
  assert.equal(midi.ticksPerQuarter, 480);
  assert.ok(midi.duration > 1.9 && midi.duration < 2.1, `unexpected duration ${midi.duration}`);
  assert.equal(midi.tracks.length, 2);
  assert.equal(midi.tracks[0].name, 'Lead');
  assert.equal(midi.tracks[0].notes.length, 2);
  assert.deepEqual(
    midi.tracks[0].notes.map((note) => ({ midi: note.midi, time: Number(note.time.toFixed(3)), duration: Number(note.duration.toFixed(3)) })),
    [
      { midi: 60, time: 0.000, duration: 0.500 },
      { midi: 64, time: 0.500, duration: 0.500 },
    ]
  );
  assert.equal(midi.tracks[1].name, 'Bass');
  assert.equal(midi.tracks[1].notes[0].midi, 43);
});

test('parseMidiFile splits format-0 multi-channel files into instrument-aware logical tracks', () => {
  const midi = parseMidiFile(createFormat0MultiChannelMidiBytes());

  assert.equal(midi.format, 0);
  assert.deepEqual(
    midi.tracks.map((track) => ({
      name: track.name,
      channel: track.channel,
      program: track.program,
      instrumentName: track.instrumentName,
      notes: track.notes.length,
    })),
    [
      { name: 'Channel 1 · Distortion Guitar', channel: 0, program: 30, instrumentName: 'Distortion Guitar', notes: 1 },
      { name: 'Channel 2 · Electric Bass (pick)', channel: 1, program: 34, instrumentName: 'Electric Bass (pick)', notes: 1 },
      { name: 'Channel 10 · Drums', channel: 9, program: 0, instrumentName: 'Drums', notes: 1 },
    ],
  );

  assert.equal(midi.tracks[0].notes[0].program, 30);
  assert.equal(midi.tracks[0].notes[0].instrumentName, 'Distortion Guitar');
  assert.equal(midi.tracks[2].notes[0].isDrum, true);
});
