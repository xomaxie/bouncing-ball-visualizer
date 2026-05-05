import { midiInstrumentName } from './music.js';

function readAscii(bytes, offset, length) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[offset + i]);
  return out;
}

function readU16(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readU32(bytes, offset) {
  return ((bytes[offset] << 24) >>> 0) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
}

function readVar(bytes, cursor) {
  let value = 0;
  let b = 0;
  do {
    b = bytes[cursor.offset++];
    value = (value << 7) | (b & 0x7f);
  } while (b & 0x80);
  return value;
}

function tempoAtTickToSeconds(tick, tempoMap, ticksPerQuarter) {
  let seconds = 0;
  let lastTick = 0;
  let tempo = 500000;
  for (const event of tempoMap) {
    if (event.tick > tick) break;
    seconds += ((event.tick - lastTick) * tempo) / ticksPerQuarter / 1000000;
    lastTick = event.tick;
    tempo = event.microsecondsPerQuarter;
  }
  seconds += ((tick - lastTick) * tempo) / ticksPerQuarter / 1000000;
  return seconds;
}

function parseTrack(bytes, offset, length, trackIndex) {
  const end = offset + length;
  const cursor = { offset };
  let tick = 0;
  let runningStatus = null;
  let name = `Track ${trackIndex + 1}`;
  const notes = [];
  const active = new Map();
  const channelPrograms = new Array(16).fill(0);
  const tempoEvents = [];
  const rawEvents = [];

  const activeKey = (channel, midi) => `${channel}:${midi}`;

  while (cursor.offset < end) {
    tick += readVar(bytes, cursor);
    let status = bytes[cursor.offset++];
    if (status < 0x80) {
      if (runningStatus === null) throw new Error(`Running status without previous status at track ${trackIndex}`);
      cursor.offset -= 1;
      status = runningStatus;
    } else if (status < 0xf0) {
      runningStatus = status;
    }

    if (status === 0xff) {
      const type = bytes[cursor.offset++];
      const len = readVar(bytes, cursor);
      const dataOffset = cursor.offset;
      const data = bytes.slice(dataOffset, dataOffset + len);
      cursor.offset += len;
      if (type === 0x03) name = readAscii(data, 0, data.length) || name;
      if (type === 0x51 && data.length === 3) {
        tempoEvents.push({
          tick,
          microsecondsPerQuarter: (data[0] << 16) | (data[1] << 8) | data[2],
        });
      }
      rawEvents.push({ tick, type: 'meta', metaType: type });
      if (type === 0x2f) break;
      continue;
    }

    if (status === 0xf0 || status === 0xf7) {
      const len = readVar(bytes, cursor);
      cursor.offset += len;
      continue;
    }

    const eventType = status & 0xf0;
    const channel = status & 0x0f;
    const data1 = bytes[cursor.offset++];
    const needsTwoDataBytes = eventType !== 0xc0 && eventType !== 0xd0;
    const data2 = needsTwoDataBytes ? bytes[cursor.offset++] : 0;

    if (eventType === 0xc0) {
      channelPrograms[channel] = data1;
    } else if (eventType === 0x90 && data2 > 0) {
      const key = activeKey(channel, data1);
      if (!active.has(key)) active.set(key, []);
      active.get(key).push({ tick, velocity: data2 / 127, channel, program: channelPrograms[channel] ?? 0 });
    } else if (eventType === 0x80 || (eventType === 0x90 && data2 === 0)) {
      const key = activeKey(channel, data1);
      const stack = active.get(key);
      if (stack && stack.length > 0) {
        const started = stack.shift();
        notes.push({
          midi: data1,
          velocity: started.velocity,
          channel,
          program: started.program ?? 0,
          startTick: started.tick,
          endTick: tick,
          durationTicks: Math.max(0, tick - started.tick),
        });
      }
    }
    rawEvents.push({ tick, type: 'midi', status, data1, data2, channel });
  }

  return { index: trackIndex, name, notes, tempoEvents, rawEvents, endTick: tick };
}

function shouldSplitTrackByInstrument(format, track, notes) {
  if (notes.length === 0) return false;
  const channelPrograms = new Set(notes.map((note) => `${note.channel}:${note.channel === 9 ? 'drums' : note.program ?? 0}`));
  return format === 0 || channelPrograms.size > 1;
}

function logicalTrackName(sourceTrack, group) {
  if (!group.split) return sourceTrack.name;
  return `Channel ${group.channel + 1} · ${group.instrumentName}`;
}

function splitIntoLogicalTracks(format, convertedTracks) {
  const logical = [];

  for (const sourceTrack of convertedTracks) {
    if (!shouldSplitTrackByInstrument(format, sourceTrack, sourceTrack.notes)) {
      const first = sourceTrack.notes[0];
      const program = first?.program ?? 0;
      const channel = first?.channel;
      logical.push({
        ...sourceTrack,
        sourceTrackIndex: sourceTrack.index,
        channel,
        program,
        instrumentName: first ? midiInstrumentName(program, channel) : undefined,
      });
      continue;
    }

    const groups = new Map();
    for (const note of sourceTrack.notes) {
      const program = note.channel === 9 ? 0 : (note.program ?? 0);
      const key = `${note.channel}:${program}`;
      if (!groups.has(key)) {
        groups.set(key, {
          split: true,
          sourceTrackIndex: sourceTrack.index,
          channel: note.channel,
          program,
          instrumentName: midiInstrumentName(program, note.channel),
          notes: [],
          rawEvents: sourceTrack.rawEvents,
        });
      }
      groups.get(key).notes.push(note);
    }

    for (const group of groups.values()) {
      logical.push({
        index: logical.length,
        sourceTrackIndex: sourceTrack.index,
        name: logicalTrackName(sourceTrack, group),
        channel: group.channel,
        program: group.program,
        instrumentName: group.instrumentName,
        notes: group.notes.sort((a, b) => a.time - b.time || a.midi - b.midi),
        rawEvents: group.rawEvents,
      });
    }
  }

  return logical.map((track, index) => ({
    ...track,
    id: index,
    index,
  }));
}

export function parseMidiFile(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (readAscii(bytes, 0, 4) !== 'MThd') throw new Error('Not a standard MIDI file: missing MThd header');
  const headerLength = readU32(bytes, 4);
  const format = readU16(bytes, 8);
  const trackCount = readU16(bytes, 10);
  const division = readU16(bytes, 12);
  if (division & 0x8000) throw new Error('SMPTE time division is not supported in this MVP');
  const ticksPerQuarter = division;
  let offset = 8 + headerLength;
  const parsedTracks = [];

  for (let trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
    if (readAscii(bytes, offset, 4) !== 'MTrk') throw new Error(`Missing MTrk header for track ${trackIndex}`);
    const length = readU32(bytes, offset + 4);
    parsedTracks.push(parseTrack(bytes, offset + 8, length, trackIndex));
    offset += 8 + length;
  }

  const tempoMap = parsedTracks
    .flatMap((track) => track.tempoEvents)
    .sort((a, b) => a.tick - b.tick);
  if (tempoMap.length === 0 || tempoMap[0].tick !== 0) tempoMap.unshift({ tick: 0, microsecondsPerQuarter: 500000 });

  const convertedTracks = parsedTracks.map((track) => {
    const notes = track.notes
      .map((note) => {
        const time = tempoAtTickToSeconds(note.startTick, tempoMap, ticksPerQuarter);
        const end = tempoAtTickToSeconds(note.endTick, tempoMap, ticksPerQuarter);
        const program = note.channel === 9 ? 0 : (note.program ?? 0);
        return {
          midi: note.midi,
          velocity: note.velocity,
          channel: note.channel,
          program,
          instrumentName: midiInstrumentName(program, note.channel),
          isDrum: note.channel === 9,
          startTick: note.startTick,
          endTick: note.endTick,
          durationTicks: note.durationTicks,
          time,
          duration: Math.max(0, end - time),
        };
      })
      .sort((a, b) => a.time - b.time || a.midi - b.midi);
    return {
      id: track.index,
      index: track.index,
      name: track.name,
      notes,
      rawEvents: track.rawEvents.length,
    };
  });
  const tracks = splitIntoLogicalTracks(format, convertedTracks);

  const duration = Math.max(0, ...tracks.flatMap((track) => track.notes.map((note) => note.time + note.duration)));
  return {
    format,
    ticksPerQuarter,
    tracks,
    tempoMap,
    duration,
  };
}

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

export function createDemoMidiBytes() {
  const leadName = ascii('Lead');
  const bassName = ascii('Bass');
  const lead = [
    ...vlq(0), 0xff, 0x03, leadName.length, ...leadName,
    ...vlq(0), 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,
    ...vlq(0), 0x90, 60, 100,
    ...vlq(480), 0x80, 60, 0,
    ...vlq(0), 0x90, 64, 100,
    ...vlq(480), 0x80, 64, 0,
    ...vlq(960), 0xff, 0x2f, 0x00,
  ];
  const bass = [
    ...vlq(0), 0xff, 0x03, bassName.length, ...bassName,
    ...vlq(0), 0x91, 43, 110,
    ...vlq(1920), 0x81, 43, 0,
    ...vlq(0), 0xff, 0x2f, 0x00,
  ];
  return new Uint8Array([
    ...ascii('MThd'), ...u32(6), ...u16(1), ...u16(2), ...u16(480),
    ...trackChunk(lead),
    ...trackChunk(bass),
  ]);
}

export function createDemoSong() {
  const palette = [
    { id: 0, name: 'Bass gravity', notes: [] },
    { id: 1, name: 'Glass lead', notes: [] },
    { id: 2, name: 'Counter pulse', notes: [] },
  ];
  const bass = [36, 38, 41, 43, 41, 38, 34, 36];
  bass.forEach((midi, i) => palette[0].notes.push({ time: 0.55 + i * 0.56, duration: 0.28, midi, velocity: 0.82 }));
  const lead = [60, 64, 67, 72, 76, 74, 69, 67, 72, 79, 76, 72];
  lead.forEach((midi, i) => palette[1].notes.push({ time: 0.85 + i * 0.28, duration: 0.16, midi, velocity: 0.72 + (i % 3) * 0.08 }));
  const pulse = [48, 55, 62, 55, 50, 57, 64, 57, 52, 59, 66, 59];
  pulse.forEach((midi, i) => palette[2].notes.push({ time: 1.0 + i * 0.21, duration: 0.11, midi, velocity: 0.62 }));
  return {
    format: 'generated',
    ticksPerQuarter: 480,
    duration: 5.1,
    tracks: palette,
  };
}
