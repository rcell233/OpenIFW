import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Synth, renderSequence } from '../web/src/dsp/core.js';
const factory = JSON.parse(
  await readFile(new URL('../web/assets/tresure-island.json', import.meta.url), 'utf8'),
);
function sinePatch() {
  const patch = structuredClone(factory),
    p = patch.parameters;
  for (let i = 1; i <= 4; i++) {
    for (const k of ['SawLevel', 'TriLevel', 'PwmLevel', 'NoiseLevel']) p['Osc' + i + k] = 0;
    p['Osc' + i + 'Output1'] = i === 1 ? 'On' : 'Off';
    p['Osc' + i + 'Output2'] = 'Off';
    p['Osc' + i + 'Sync'] = 'Off';
  }
  Object.assign(p, {
    Osc1TriLevel: 10,
    Osc1Waveform2: 'SIN',
    Filter1Frequency: 10,
    Filter1Resonance: 0,
    Filter1Breath: 0,
    Filter1KeyTrack: 0,
    Filter3Mix: 0,
    EqLowGain: 0,
    EqHighGain: 0,
    GlideMinimumSpeed: 0,
  });
  return patch;
}
const events = (note, duration = 0.4) => [
  { time: 0.02, type: 'noteOn', note, velocity: 1 },
  { time: 0.02 + duration, type: 'noteOff', note },
];
const rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
function frequency(x, sr) {
  let crossings = [];
  for (let i = 1; i < x.length; i++)
    if (x[i - 1] <= 0 && x[i] > 0) crossings.push(i - x[i] / (x[i] - x[i - 1]));
  return ((crossings.length - 1) * sr) / (crossings.at(-1) - crossings[0]);
}
test('MIDI 69 produces 440 Hz and note-off closes the audio gate', () => {
  const a = renderSequence(sinePatch(), events(69), { duration: 1, dry: true });
  const f = frequency(a.left.subarray(5000, 15000), a.sampleRate);
  assert.ok(Math.abs(f - 440) < 0.1, `measured ${f} Hz`);
  assert.ok(rms(a.left.subarray(10000, 15000)) > 0.01);
  assert.ok(rms(a.left.subarray(40000)) < 1e-7);
});
test('oscillator half-level preserves pitch and halves amplitude', () => {
  const p = sinePatch(),
    a = renderSequence(p, events(60), { duration: 0.45, dry: true });
  p.parameters.Osc1TriLevel = 5;
  const b = renderSequence(p, events(60), { duration: 0.45, dry: true });
  const ratio = rms(b.left.subarray(6000, 15000)) / rms(a.left.subarray(6000, 15000));
  assert.ok(Math.abs(ratio - 0.5) < 0.015, `gain ${ratio}`);
});
test('zero breath suppresses a wind voice and CC breath can reopen it', () => {
  const a = renderSequence(sinePatch(), events(60), { duration: 0.5, dry: true, breath: 0 });
  assert.equal(rms(a.left), 0);
  const b = renderSequence(sinePatch(), [...events(60), { time: 0.15, type: 'breath', value: 1 }], {
    duration: 0.5,
    dry: true,
    breath: 0,
  });
  assert.ok(rms(b.left.subarray(12000, 18000)) > 0.01);
});
test('silent oscillator output remains a working FM modulation source', () => {
  const p = sinePatch();
  Object.assign(p.parameters, {
    Osc1Output1: 'Off',
    Osc2Waveform2: 'SIN',
    Osc2Semi: 12,
    Osc2TriLevel: 0,
    Osc3Output1: 'On',
    Osc3PwmLevel: 3.1,
    Osc3PwmWidth: 5,
    Osc3Semi: 24,
    Osc3Sync: 'On',
    Mod1Source1: 'OSC 2 TRI (+-)',
    Mod1Destination: 'OSC 3 FM',
    Mod1Depth: 1.9,
  });
  const a = renderSequence(p, events(60), { duration: 0.45, dry: true });
  p.parameters.Mod1Depth = 0;
  const b = renderSequence(p, events(60), { duration: 0.45, dry: true });
  const delta = a.left.subarray(6000, 15000).map((v, i) => v - b.left[6000 + i]);
  assert.ok(rms(delta) > 0.001);
});
test('FM changes the read phase without contaminating the next oscillator sync clock', () => {
  const p = sinePatch();
  Object.assign(p.parameters, {
    Osc1Output1: 'Off',
    Osc2Semi: 12,
    Osc2Sync: 'On',
    Osc2Waveform2: 'SIN',
    Osc3Semi: 24,
    Osc3Sync: 'On',
    Osc4Semi: 36,
    Osc4Sync: 'On',
    Osc4SawLevel: 4.4,
    Osc4Output1: 'On',
    Mod1Source1: 'OSC 2 TRI (+-)',
    Mod1Destination: 'OSC 3 FM',
    Mod1Depth: 1.9,
  });
  const a = renderSequence(p, events(60), { duration: 0.45, dry: true });
  p.parameters.Mod1Depth = 0;
  const b = renderSequence(p, events(60), { duration: 0.45, dry: true });
  assert.deepEqual(a.left, b.left, 'isolated OSC4 should retain the same pure octave saw');
});
test('last-note priority returns to the held note and panic clears effect tails', () => {
  const s = new Synth(48000, sinePatch());
  s.setDry(true);
  s.setBreath(1);
  s.noteOn(69);
  s.noteOn(72);
  s.noteOff(72);
  const l = new Float32Array(16000),
    r = new Float32Array(16000);
  s.process(l, r);
  assert.ok(Math.abs(frequency(l.subarray(8000), 48000) - 440) < 0.2);
  s.panic();
  s.process(l, r);
  assert.equal(rms(l), 0);
});
test('shared engine stays finite and audible across the native reference note range', () => {
  for (const note of [48, 55, 60, 64, 67, 72, 76, 79, 84]) {
    const a = renderSequence(factory, events(note, 0.08), { duration: 0.18, dry: true });
    assert.ok(a.left.every(Number.isFinite));
    assert.ok(rms(a.left) > 0.001);
    assert.ok(Math.max(...a.left) < 1);
  }
});
