import { analyzeAudioBufferToSong } from './audio-analysis.js';
import { clamp, midiInstrumentName, trackColor } from './music.js';

export const BASIC_PITCH_SAMPLE_RATE = 22050;
export const BASIC_PITCH_MODULE_URL = new URL('../vendor/basic-pitch.bundle.js', import.meta.url).href;
export const BASIC_PITCH_MODEL_URL = new URL('../vendor/basic-pitch/model/model.json', import.meta.url).href;
export const BASIC_PITCH_SERVER_URL = new URL('../api/basic-pitch/transcribe', import.meta.url).href;

const BASIC_PITCH_BANDS = [
  { id: 0, label: 'Basic Pitch bass', program: 38, channel: 0, minMidi: 0, maxMidi: 51 },
  { id: 1, label: 'Basic Pitch mid', program: 4, channel: 1, minMidi: 52, maxMidi: 71 },
  { id: 2, label: 'Basic Pitch treble', program: 11, channel: 2, minMidi: 72, maxMidi: 127 },
];

const DEFAULT_CONTENT_TRIM_OPTIONS = {
  activityFrameSeconds: 0.05,
  activityPeakRatio: 0.006,
  activityAverageRatio: 0.02,
  activityNoiseRatio: 4,
  activityFloor: 1e-5,
  leadingPaddingSeconds: 0.12,
  tailPaddingSeconds: 0.45,
  minimumClippedNoteSeconds: 0.04,
};

function bandForMidi(midi) {
  if (midi < 52) return 0;
  if (midi < 72) return 1;
  return 2;
}

function finiteNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function normalizeBasicPitchNote(note) {
  const midi = clamp(Math.round(finiteNumber(note.pitchMidi ?? note.pitch_midi ?? note.midi, 60)), 21, 108);
  const time = Math.max(0, finiteNumber(note.startTimeSeconds ?? note.start ?? note.time, 0));
  const duration = clamp(finiteNumber(note.durationSeconds ?? note.duration ?? 0.12, 0.12), 0.08, 2.5);
  const velocity = clamp(finiteNumber(note.amplitude ?? note.velocity, 0.55), 0.08, 1);
  return { time, duration, midi, velocity };
}

function audioDurationSeconds(audioInfo = {}) {
  const duration = finiteNumber(audioInfo.duration, 0);
  if (duration > 0) return duration;
  const length = finiteNumber(audioInfo.length, 0);
  const sampleRate = finiteNumber(audioInfo.sampleRate, 0);
  return length > 0 && sampleRate > 0 ? length / sampleRate : 0;
}

function quantile(sortedValues, q) {
  if (!sortedValues.length) return 0;
  const index = Math.max(0, Math.min(sortedValues.length - 1, Math.floor((sortedValues.length - 1) * q)));
  return sortedValues[index];
}

export function detectAudioActivityWindow(audioInfo = {}, options = {}) {
  const opts = { ...DEFAULT_CONTENT_TRIM_OPTIONS, ...options };
  const duration = audioDurationSeconds(audioInfo);
  const explicitEnd = finiteNumber(audioInfo.audioContentEndSeconds ?? audioInfo.activeEndSeconds, NaN);
  const explicitStart = finiteNumber(audioInfo.audioContentStartSeconds ?? audioInfo.activeStartSeconds, NaN);
  if (Number.isFinite(explicitEnd)) {
    return {
      start: Math.max(0, Number.isFinite(explicitStart) ? explicitStart : 0),
      end: Math.max(0, Math.min(duration || explicitEnd, explicitEnd)),
      duration,
      threshold: null,
      reliable: true,
      source: 'metadata',
    };
  }

  if (
    !audioInfo ||
    typeof audioInfo.getChannelData !== 'function' ||
    !Number.isFinite(audioInfo.sampleRate) ||
    audioInfo.sampleRate <= 0
  ) {
    return { start: 0, end: duration, duration, threshold: null, reliable: false, source: 'duration' };
  }

  const sampleRate = audioInfo.sampleRate;
  const length = Math.max(0, Math.floor(audioInfo.length || duration * sampleRate));
  const channelCount = Math.max(1, Math.floor(audioInfo.numberOfChannels || 1));
  if (length <= 0) return { start: 0, end: duration, duration, threshold: null, reliable: false, source: 'empty' };

  const frameSize = Math.max(8, Math.round((opts.activityFrameSeconds ?? 0.05) * sampleRate));
  const frameCount = Math.max(1, Math.ceil(length / frameSize));
  const rmsValues = [];

  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * frameSize;
    const end = Math.min(length, start + frameSize);
    let sum = 0;
    let count = 0;
    for (let channel = 0; channel < channelCount; channel += 1) {
      const data = audioInfo.getChannelData(channel);
      const stride = Math.max(1, Math.floor((end - start) / 512));
      for (let index = start; index < end; index += stride) {
        const value = data[index] || 0;
        sum += value * value;
        count += 1;
      }
    }
    rmsValues.push(Math.sqrt(sum / Math.max(1, count)));
  }

  const peak = Math.max(0, ...rmsValues);
  const average = rmsValues.reduce((sum, value) => sum + value, 0) / Math.max(1, rmsValues.length);
  const sorted = [...rmsValues].sort((a, b) => a - b);
  const noiseFloor = quantile(sorted, 0.1);
  const noiseAdaptiveThreshold = Math.min(
    peak * 0.1,
    noiseFloor * (opts.activityNoiseRatio ?? 4),
  );
  const threshold = Math.max(
    opts.activityFloor ?? 1e-5,
    peak * (opts.activityPeakRatio ?? 0.006),
    average * (opts.activityAverageRatio ?? 0.02),
    noiseAdaptiveThreshold,
  );

  let firstActive = -1;
  let lastActive = -1;
  for (let index = 0; index < rmsValues.length; index += 1) {
    if (rmsValues[index] < threshold) continue;
    if (firstActive === -1) firstActive = index;
    lastActive = index;
  }

  if (firstActive === -1) {
    return { start: 0, end: 0, duration, threshold, reliable: true, source: 'samples' };
  }

  return {
    start: Math.max(0, Math.min(duration, (firstActive * frameSize) / sampleRate)),
    end: Math.max(0, Math.min(duration, ((lastActive + 1) * frameSize) / sampleRate)),
    duration,
    threshold,
    reliable: true,
    source: 'samples',
  };
}

function normalizeAndClipBasicPitchNote(raw, trimWindow, stats) {
  const note = normalizeBasicPitchNote(raw);
  const noteEnd = note.time + note.duration;
  if (noteEnd < trimWindow.start) {
    stats.trimmedLeadingEvents += 1;
    return null;
  }
  if (note.time > trimWindow.end) {
    stats.trimmedTailEvents += 1;
    return null;
  }
  const clippedEnd = Math.min(noteEnd, trimWindow.end);
  const clippedDuration = clippedEnd - note.time;
  if (clippedDuration < trimWindow.minimumDuration) {
    stats.trimmedTailEvents += 1;
    return null;
  }
  if (clippedDuration < note.duration - 1e-9) {
    note.duration = clippedDuration;
    stats.clippedTailEvents += 1;
  }
  return note;
}

export function basicPitchNotesToSong(rawNotes, audioInfo = {}, options = {}) {
  const trimOptions = { ...DEFAULT_CONTENT_TRIM_OPTIONS, ...options };
  const activity = detectAudioActivityWindow(audioInfo, trimOptions);
  const audioDuration = audioDurationSeconds(audioInfo);
  const trimWindow = {
    start: Math.max(0, (activity.start || 0) - (trimOptions.leadingPaddingSeconds ?? 0.12)),
    end: Math.max(0, (activity.end || audioDuration || Infinity) + (trimOptions.tailPaddingSeconds ?? 0.45)),
    minimumDuration: trimOptions.minimumClippedNoteSeconds ?? 0.04,
  };
  if (Number.isFinite(audioDuration) && audioDuration > 0) trimWindow.end = Math.min(trimWindow.end, audioDuration);
  const trimStats = {
    trimmedLeadingEvents: 0,
    trimmedTailEvents: 0,
    clippedTailEvents: 0,
  };
  const tracks = BASIC_PITCH_BANDS.map((band, index) => {
    const instrumentName = midiInstrumentName(band.program, band.channel);
    return {
      id: band.id,
      index: band.id,
      name: `${band.label} · ${instrumentName}`,
      color: trackColor(index),
      channel: band.channel,
      program: band.program,
      instrumentName,
      notes: [],
    };
  });

  for (const raw of rawNotes ?? []) {
    const normalized = normalizeAndClipBasicPitchNote(raw, trimWindow, trimStats);
    if (!normalized) continue;
    const track = tracks[bandForMidi(normalized.midi)];
    track.notes.push({
      ...normalized,
      channel: track.channel,
      program: track.program,
      instrumentName: track.instrumentName,
      isDrum: false,
      source: 'basic-pitch',
    });
  }

  for (const track of tracks) track.notes.sort((a, b) => a.time - b.time || a.midi - b.midi);
  const playableTracks = tracks.filter((track) => track.notes.length > 0);
  const detectedEvents = playableTracks.reduce((count, track) => count + track.notes.length, 0);
  const durationFromNotes = playableTracks
    .flatMap((track) => track.notes)
    .reduce((last, note) => Math.max(last, note.time + note.duration), 0);
  const contentDuration = Math.max(durationFromNotes, Math.min(trimWindow.end, activity.end || trimWindow.end));

  return {
    format: 'basic-pitch',
    duration: Math.max(0, contentDuration),
    sampleRate: audioInfo.sampleRate,
    tracks: playableTracks,
    analysis: {
      transcriber: 'spotify-basic-pitch',
      detectedEvents,
      sourceEvents: (rawNotes ?? []).length,
      audioDurationSeconds: audioDuration,
      audioContentStartSeconds: activity.start,
      audioContentEndSeconds: activity.end,
      trimTailCutoffSeconds: trimWindow.end,
      ...trimStats,
      model: 'ICASSP 2022 Basic Pitch TensorFlow.js graph model',
    },
  };
}

function mixToMonoBuffer(audioBuffer, audioContext) {
  const sourceSampleRate = audioBuffer.sampleRate ?? BASIC_PITCH_SAMPLE_RATE;
  const length = audioBuffer.length ?? Math.max(1, Math.ceil((audioBuffer.duration ?? 0) * sourceSampleRate));
  const monoBuffer = audioContext.createBuffer(1, length, sourceSampleRate);
  const mono = monoBuffer.getChannelData(0);
  const channels = Math.max(1, audioBuffer.numberOfChannels ?? 1);

  for (let channel = 0; channel < channels; channel += 1) {
    const data = audioBuffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) mono[i] += (data[i] || 0) / channels;
  }

  return monoBuffer;
}


export function serverBasicPitchResponseToSong(response, audioInfo = {}) {
  const notes = (response?.notes ?? []).map((note) => ({
    startTimeSeconds: note.startTimeSeconds ?? note.start_time_seconds ?? note.start,
    durationSeconds: note.durationSeconds ?? note.duration_seconds ?? Math.max(0, (note.endTimeSeconds ?? note.end ?? 0) - (note.startTimeSeconds ?? note.start ?? 0)),
    pitchMidi: note.pitchMidi ?? note.pitch_midi ?? note.midi,
    amplitude: note.amplitude ?? note.velocity,
  }));
  const song = basicPitchNotesToSong(notes, audioInfo);
  song.analysis = {
    ...song.analysis,
    ...(response?.analysis ?? {}),
    transcriber: 'spotify-basic-pitch',
    runtime: response?.analysis?.runtime || 'server',
  };
  return song;
}

export async function transcribeAudioFileWithServerBasicPitch(file, audioInfo = {}, options = {}) {
  const endpointUrl = options.endpointUrl || BASIC_PITCH_SERVER_URL;
  const body = new FormData();
  body.append('file', file, file?.name || 'audio.mp3');
  const response = await fetch(endpointUrl, { method: 'POST', body });
  if (!response.ok) {
    let message = `Basic Pitch server returned ${response.status}`;
    try {
      const details = await response.json();
      message = details?.detail || details?.error || message;
    } catch (_) {
      try { message = await response.text(); } catch (_) { /* ignore */ }
    }
    throw new Error(message);
  }
  return serverBasicPitchResponseToSong(await response.json(), audioInfo);
}

export async function resampleAudioBufferForBasicPitch(audioBuffer, options = {}) {
  if (
    audioBuffer?.sampleRate === BASIC_PITCH_SAMPLE_RATE &&
    audioBuffer?.numberOfChannels === 1 &&
    typeof audioBuffer.getChannelData === 'function'
  ) {
    return audioBuffer;
  }

  const OfflineAudioContextCtor =
    options.OfflineAudioContextCtor ||
    globalThis.OfflineAudioContext ||
    globalThis.webkitOfflineAudioContext;
  if (!OfflineAudioContextCtor) {
    throw new Error('OfflineAudioContext is required for Basic Pitch resampling');
  }

  const duration = Math.max(0.001, audioBuffer.duration ?? ((audioBuffer.length ?? 1) / (audioBuffer.sampleRate ?? BASIC_PITCH_SAMPLE_RATE)));
  const targetLength = Math.max(1, Math.ceil(duration * BASIC_PITCH_SAMPLE_RATE));
  const offline = new OfflineAudioContextCtor(1, targetLength, BASIC_PITCH_SAMPLE_RATE);
  const monoSourceBuffer = mixToMonoBuffer(audioBuffer, offline);
  const source = offline.createBufferSource();
  source.buffer = monoSourceBuffer;
  source.connect(offline.destination);
  source.start(0);
  return offline.startRendering();
}

function pickBasicPitchExports(module) {
  const BasicPitch = module.BasicPitch;
  const outputToNotesPoly = module.outputToNotesPoly;
  const addPitchBendsToNoteEvents = module.addPitchBendsToNoteEvents;
  const noteFramesToTime = module.noteFramesToTime;
  if (!BasicPitch || !outputToNotesPoly || !addPitchBendsToNoteEvents || !noteFramesToTime) {
    throw new Error('Basic Pitch module did not expose the expected transcription API');
  }
  return { BasicPitch, outputToNotesPoly, addPitchBendsToNoteEvents, noteFramesToTime };
}

export async function transcribeAudioBufferWithBasicPitch(audioBuffer, options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  onProgress(0, 'loading-model');
  const basicPitchModule = pickBasicPitchExports(await import(options.moduleUrl || BASIC_PITCH_MODULE_URL));
  const modelUrl = options.modelUrl || BASIC_PITCH_MODEL_URL;
  const resampled = await resampleAudioBufferForBasicPitch(audioBuffer, options);
  const basicPitch = new basicPitchModule.BasicPitch(modelUrl);
  const frames = [];
  const onsets = [];
  const contours = [];

  await basicPitch.evaluateModel(
    resampled,
    (frameBatch, onsetBatch, contourBatch) => {
      frames.push(...frameBatch);
      onsets.push(...onsetBatch);
      contours.push(...contourBatch);
    },
    (progress) => onProgress(progress, 'transcribing'),
  );

  const noteEvents = basicPitchModule.outputToNotesPoly(
    frames,
    onsets,
    options.onsetThreshold ?? 0.25,
    options.frameThreshold ?? 0.22,
    options.minNoteLengthFrames ?? 3,
    true,
    options.maxFrequency ?? null,
    options.minFrequency ?? null,
    options.melodiaTrick ?? true,
  );
  const notesWithTime = basicPitchModule.noteFramesToTime(
    basicPitchModule.addPitchBendsToNoteEvents(contours, noteEvents),
  );
  const song = basicPitchNotesToSong(notesWithTime, audioBuffer);
  song.analysis.frames = frames.length;
  song.analysis.onsets = onsets.length;
  song.analysis.contours = contours.length;
  onProgress(1, 'complete');
  return song;
}

function hasPlayableTracks(song) {
  return Boolean(song?.tracks?.some((track) => (track.notes ?? []).length > 0));
}

export async function analyzeMp3WithPreferredTranscriber(audioBuffer, options = {}) {
  const fallback = options.fallback || ((buffer) => analyzeAudioBufferToSong(buffer));
  const highAccuracy = options.highAccuracy || ((buffer) => transcribeAudioBufferWithBasicPitch(buffer, options));

  try {
    const highAccuracySong = await highAccuracy(audioBuffer);
    if (!hasPlayableTracks(highAccuracySong)) throw new Error('Basic Pitch returned no playable note events');
    return highAccuracySong;
  } catch (error) {
    const fallbackSong = await fallback(audioBuffer);
    return {
      ...fallbackSong,
      analysis: {
        ...(fallbackSong.analysis ?? {}),
        highAccuracyError: error?.message || String(error),
      },
    };
  }
}
