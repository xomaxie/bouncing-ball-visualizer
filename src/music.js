export const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

export const GM_PROGRAM_NAMES = [
  'Acoustic Grand Piano', 'Bright Acoustic Piano', 'Electric Grand Piano', 'Honky-tonk Piano',
  'Electric Piano 1', 'Electric Piano 2', 'Harpsichord', 'Clavinet',
  'Celesta', 'Glockenspiel', 'Music Box', 'Vibraphone',
  'Marimba', 'Xylophone', 'Tubular Bells', 'Dulcimer',
  'Drawbar Organ', 'Percussive Organ', 'Rock Organ', 'Church Organ',
  'Reed Organ', 'Accordion', 'Harmonica', 'Tango Accordion',
  'Acoustic Guitar (nylon)', 'Acoustic Guitar (steel)', 'Electric Guitar (jazz)', 'Electric Guitar (clean)',
  'Electric Guitar (muted)', 'Overdriven Guitar', 'Distortion Guitar', 'Guitar Harmonics',
  'Acoustic Bass', 'Electric Bass (finger)', 'Electric Bass (pick)', 'Fretless Bass',
  'Slap Bass 1', 'Slap Bass 2', 'Synth Bass 1', 'Synth Bass 2',
  'Violin', 'Viola', 'Cello', 'Contrabass',
  'Tremolo Strings', 'Pizzicato Strings', 'Orchestral Harp', 'Timpani',
  'String Ensemble 1', 'String Ensemble 2', 'Synth Strings 1', 'Synth Strings 2',
  'Choir Aahs', 'Voice Oohs', 'Synth Voice', 'Orchestra Hit',
  'Trumpet', 'Trombone', 'Tuba', 'Muted Trumpet',
  'French Horn', 'Brass Section', 'Synth Brass 1', 'Synth Brass 2',
  'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Baritone Sax',
  'Oboe', 'English Horn', 'Bassoon', 'Clarinet',
  'Piccolo', 'Flute', 'Recorder', 'Pan Flute',
  'Blown Bottle', 'Shakuhachi', 'Whistle', 'Ocarina',
  'Lead 1 (square)', 'Lead 2 (sawtooth)', 'Lead 3 (calliope)', 'Lead 4 (chiff)',
  'Lead 5 (charang)', 'Lead 6 (voice)', 'Lead 7 (fifths)', 'Lead 8 (bass + lead)',
  'Pad 1 (new age)', 'Pad 2 (warm)', 'Pad 3 (polysynth)', 'Pad 4 (choir)',
  'Pad 5 (bowed)', 'Pad 6 (metallic)', 'Pad 7 (halo)', 'Pad 8 (sweep)',
  'FX 1 (rain)', 'FX 2 (soundtrack)', 'FX 3 (crystal)', 'FX 4 (atmosphere)',
  'FX 5 (brightness)', 'FX 6 (goblins)', 'FX 7 (echoes)', 'FX 8 (sci-fi)',
  'Sitar', 'Banjo', 'Shamisen', 'Koto',
  'Kalimba', 'Bag pipe', 'Fiddle', 'Shanai',
  'Tinkle Bell', 'Agogo', 'Steel Drums', 'Woodblock',
  'Taiko Drum', 'Melodic Tom', 'Synth Drum', 'Reverse Cymbal',
  'Guitar Fret Noise', 'Breath Noise', 'Seashore', 'Bird Tweet',
  'Telephone Ring', 'Helicopter', 'Applause', 'Gunshot',
];

export function midiInstrumentName(program = 0, channel = 0) {
  if (channel === 9) return 'Drums';
  return GM_PROGRAM_NAMES[Math.max(0, Math.min(127, Math.round(program ?? 0)))] || `Program ${program}`;
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function noteName(midi) {
  const rounded = Math.round(midi);
  const pitch = NOTE_NAMES[((rounded % 12) + 12) % 12];
  const octave = Math.floor(rounded / 12) - 1;
  return `${pitch}${octave}`;
}

export function frequencyForMidi(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

const DEFAULT_MIN_WALL_MIDI = 36;
const DEFAULT_MAX_WALL_MIDI = 84;

function finiteMidi(value) {
  const midi = Number(value);
  return Number.isFinite(midi) ? midi : null;
}

function looksPercussiveTrack(track = {}) {
  const firstNote = track.notes?.[0] || {};
  const channel = Number.isFinite(track.channel) ? track.channel : firstNote.channel;
  const text = `${track.name || ''} ${track.instrumentName || ''}`.toLowerCase();
  return (
    channel === 9 ||
    track.isDrum ||
    firstNote.isDrum ||
    includesAny(text, ['drum', 'percussion', 'kick', 'snare', 'hat', 'cymbal', 'tom'])
  );
}

function midiValuesForTracks(tracks = [], { preferMelodic = true } = {}) {
  const all = [];
  const melodic = [];
  for (const track of tracks) {
    const isPercussive = looksPercussiveTrack(track);
    for (const note of track.notes || []) {
      const midi = finiteMidi(note.midi);
      if (midi === null) continue;
      all.push(midi);
      if (!preferMelodic || (!isPercussive && !note.isDrum && note.channel !== 9)) melodic.push(midi);
    }
  }
  return preferMelodic && melodic.length >= 3 ? melodic : all;
}

export function createAdaptivePitchRange(tracks = [], options = {}) {
  const fallbackMin = Number.isFinite(options.minMidi) ? Number(options.minMidi) : DEFAULT_MIN_WALL_MIDI;
  const fallbackMax = Number.isFinite(options.maxMidi) ? Number(options.maxMidi) : DEFAULT_MAX_WALL_MIDI;
  const explicitRange = Number.isFinite(options.minMidi) && Number.isFinite(options.maxMidi);
  const fixedRange = {
    minMidi: Math.min(fallbackMin, fallbackMax - 1),
    maxMidi: Math.max(fallbackMax, fallbackMin + 1),
    source: 'fixed',
    noteCount: 0,
  };

  if (options.adaptivePitchRange === false || (explicitRange && options.adaptivePitchRange !== true)) {
    return fixedRange;
  }

  const values = midiValuesForTracks(tracks, { preferMelodic: options.excludeDrumsFromPitchRange === true })
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!values.length) return fixedRange;

  const actualMinMidi = values[0];
  const actualMaxMidi = values[values.length - 1];
  const padding = Math.max(0, Number(options.pitchRangePaddingSemitones ?? 3));
  const minimumSpan = Math.max(12, Number(options.minimumPitchSpanSemitones ?? 36));
  let minMidi = Math.floor(actualMinMidi - padding);
  let maxMidi = Math.ceil(actualMaxMidi + padding);

  if (maxMidi - minMidi < minimumSpan) {
    const center = (actualMinMidi + actualMaxMidi) / 2;
    minMidi = Math.floor(center - minimumSpan / 2);
    maxMidi = Math.ceil(center + minimumSpan / 2);
  }

  minMidi = clamp(minMidi, 0, 126);
  maxMidi = clamp(maxMidi, minMidi + 1, 127);

  return {
    minMidi,
    maxMidi,
    source: 'adaptive',
    noteCount: values.length,
    actualMinMidi,
    actualMaxMidi,
    paddingSemitones: padding,
    minimumSpanSemitones: minimumSpan,
    excludedDrums: options.excludeDrumsFromPitchRange === true,
  };
}

export function pitchToUnit(midi, options = {}) {
  const minMidi = options.minMidi ?? DEFAULT_MIN_WALL_MIDI;
  const maxMidi = options.maxMidi ?? DEFAULT_MAX_WALL_MIDI;
  return clamp((midi - minMidi) / Math.max(1, maxMidi - minMidi), 0, 1);
}

export function pitchToWallTarget(midi, arena, lanePhase = 0, options = {}) {
  const radius = arena.radius;
  const t = pitchToUnit(midi, options);
  const y = arena.cy + radius - t * radius * 2;
  const dy = y - arena.cy;
  const halfWidth = Math.sqrt(Math.max(0, radius * radius - dy * dy));
  const side = Math.floor(Math.abs(lanePhase)) % 2 === 0 ? 1 : -1;
  const x = arena.cx + side * halfWidth;
  const angle = Math.atan2(y - arena.cy, x - arena.cx);

  return {
    x,
    y,
    angle,
    midi,
    name: noteName(midi),
    unit: t,
  };
}

export function insetPoint(point, arena, inset = 12) {
  const dx = point.x - arena.cx;
  const dy = point.y - arena.cy;
  const dist = Math.hypot(dx, dy) || 1;
  return {
    x: point.x - (dx / dist) * inset,
    y: point.y - (dy / dist) * inset,
  };
}

export function wallColorUnitForTarget(point, arena) {
  const radius = Math.max(1, arena?.radius || 1);
  const relativeY = (point?.y ?? arena?.cy ?? 0) - (arena?.cy ?? 0);
  return clamp(1 - ((relativeY + radius) / (radius * 2)), 0, 1);
}

export function wallColorForTarget(point, arena, alpha = 1) {
  const unit = wallColorUnitForTarget(point, arena);
  const hue = 210 + unit * 190;
  const lightness = 42 + unit * 16;
  const safeAlpha = clamp(Number(alpha), 0, 1);
  return `hsla(${hue.toFixed(1)}, 92%, ${lightness.toFixed(1)}%, ${safeAlpha})`;
}

export function trackColor(index) {
  const colors = ['#ff5a2f', '#52d6ff', '#ffd36a', '#8cff9a', '#c189ff', '#ff8ac7', '#9ef0ff', '#f0ff8c'];
  return colors[index % colors.length];
}

const BALL_PERSONALITIES = Object.freeze({
  default: Object.freeze({
    name: 'default',
    label: 'balanced',
    radiusScale: 1,
    visualRadiusScale: 0.86,
    bodyAlphaScale: 0.94,
    gravityScale: 1,
    maxSpeedScale: 1,
    lightMultiplier: 1,
    sparkMultiplier: 1,
    impactRadiusScale: 1,
    trailAlpha: 0.22,
  }),
  bass: Object.freeze({
    name: 'bass',
    label: 'heavy bass',
    radiusScale: 1.22,
    visualRadiusScale: 0.74,
    bodyAlphaScale: 0.76,
    gravityScale: 1.16,
    maxSpeedScale: 0.94,
    lightMultiplier: 0.74,
    sparkMultiplier: 0.82,
    impactRadiusScale: 1.04,
    trailAlpha: 0.11,
  }),
  drums: Object.freeze({
    name: 'drums',
    label: 'percussive',
    radiusScale: 0.98,
    visualRadiusScale: 0.68,
    bodyAlphaScale: 0.78,
    gravityScale: 1.08,
    maxSpeedScale: 1.25,
    lightMultiplier: 0.86,
    sparkMultiplier: 1.55,
    impactRadiusScale: 1.28,
    trailAlpha: 0.15,
  }),
  treble: Object.freeze({
    name: 'treble',
    label: 'glass treble',
    radiusScale: 0.78,
    visualRadiusScale: 0.88,
    bodyAlphaScale: 0.96,
    gravityScale: 0.82,
    maxSpeedScale: 1.16,
    lightMultiplier: 1.16,
    sparkMultiplier: 1.18,
    impactRadiusScale: 0.92,
    trailAlpha: 0.30,
  }),
  guitar: Object.freeze({
    name: 'guitar',
    label: 'string attack',
    radiusScale: 1.02,
    visualRadiusScale: 0.82,
    bodyAlphaScale: 0.90,
    gravityScale: 1.02,
    maxSpeedScale: 1.06,
    lightMultiplier: 1.02,
    sparkMultiplier: 1.14,
    impactRadiusScale: 1.10,
    trailAlpha: 0.24,
  }),
});

function includesAny(haystack, needles) {
  return needles.some((needle) => haystack.includes(needle));
}

export function personalityForTrack(track = {}) {
  const firstNote = track.notes?.[0] || {};
  const channel = Number.isFinite(track.channel) ? track.channel : firstNote.channel;
  const program = Number.isFinite(track.program) ? track.program : firstNote.program;
  const text = `${track.name || ''} ${track.instrumentName || ''} ${firstNote.instrumentName || ''}`.toLowerCase();

  if (
    channel === 9 ||
    track.isDrum ||
    firstNote.isDrum ||
    includesAny(text, ['drum', 'percussion', 'kick', 'snare', 'hat', 'cymbal', 'tom'])
  ) {
    return { ...BALL_PERSONALITIES.drums };
  }

  if (
    (Number.isFinite(program) && program >= 32 && program <= 39) ||
    includesAny(text, ['bass', 'contrabass', 'tuba'])
  ) {
    return { ...BALL_PERSONALITIES.bass };
  }

  if (
    (Number.isFinite(program) && program >= 24 && program <= 31) ||
    includesAny(text, ['guitar', 'banjo', 'shamisen', 'koto', 'harp'])
  ) {
    return { ...BALL_PERSONALITIES.guitar };
  }

  if (
    (Number.isFinite(program) && ((program >= 8 && program <= 15) || (program >= 72 && program <= 87))) ||
    includesAny(text, ['treble', 'lead', 'glass', 'vibraphone', 'glockenspiel', 'celesta', 'flute', 'piccolo', 'whistle'])
  ) {
    return { ...BALL_PERSONALITIES.treble };
  }

  return { ...BALL_PERSONALITIES.default };
}

export function summarizeTracks(tracks) {
  return tracks.map((track, index) => {
    const notes = [...(track.notes ?? [])].sort((a, b) => a.time - b.time || a.midi - b.midi);
    const first = notes[0]?.time ?? 0;
    const last = notes.reduce((max, note) => Math.max(max, note.time + (note.duration || 0)), first);
    const minMidi = notes.reduce((min, note) => Math.min(min, note.midi), Infinity);
    const maxMidi = notes.reduce((max, note) => Math.max(max, note.midi), -Infinity);
    return {
      ...track,
      id: track.id ?? index,
      name: track.name || `Track ${index + 1}`,
      notes,
      first,
      last,
      minMidi: Number.isFinite(minMidi) ? minMidi : 0,
      maxMidi: Number.isFinite(maxMidi) ? maxMidi : 0,
      color: track.color || trackColor(index),
    };
  }).filter((track) => track.notes.length > 0);
}
