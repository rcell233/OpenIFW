import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Synth, renderSequence } from '../web/src/dsp/core.js';
const patch = JSON.parse(
  await readFile(new URL('../web/assets/tresure-island.json', import.meta.url), 'utf8'),
);
test('BR×EG release remains audible after the ordinary 15 ms note gate closes', () => {
  const p = structuredClone(patch);
  p.parameters.Amp1BreathSubMod = 'BRxEG1';
  p.parameters.Eg1Sustain = 10;
  p.parameters.Eg1Release = 3.4;
  p.parameters.Amp2Level = 0;
  const s = new Synth(48000, p);
  s.setDry(true);
  s.setBreath(1);
  s.noteOn(60);
  let l = new Float32Array(48000),
    r = new Float32Array(48000);
  s.process(l, r);
  s.noteOff(60);
  l = new Float32Array(7200);
  r = new Float32Array(7200);
  s.process(l, r);
  const rms = (a, b) => Math.sqrt(l.slice(a, b).reduce((sum, v) => sum + v * v, 0) / (b - a));
  assert.ok(rms(960, 1920) > 1e-4);
  assert.ok(rms(5760, 6720) < 1e-8);
});
test('shared engine responds to EG2 Attack edits through the actual audio filter', () => {
  const events = [
      { time: 0.2, type: 'noteOn', note: 65 },
      { time: 0.7, type: 'noteOff', note: 65 },
    ],
    p = structuredClone(patch);
  p.parameters.Eg2Attack = 6;
  const a = renderSequence(patch, events, { duration: 0.8, dry: true }),
    b = renderSequence(p, events, { duration: 0.8, dry: true });
  let diff = 0,
    power = 0;
  for (let i = 11040; i < 14400; i++) {
    diff += (a.left[i] - b.left[i]) ** 2;
    power += a.left[i] ** 2;
  }
  assert.ok(Math.sqrt(diff / power) > 0.05);
});
