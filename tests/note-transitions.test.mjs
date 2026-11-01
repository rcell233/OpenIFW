import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { Synth, renderSequence } from '../web/src/dsp/core.js';

const read = async (path) =>
  JSON.parse(await readFile(new URL('../web/' + path, import.meta.url), 'utf8'));
const factory = await read('assets/tresure-island.json');
const library = await read('assets/presets/index.json');
const presets = [factory, ...(await Promise.all(library.presets.map((p) => read(p.url.slice(1)))))];
const process = (s, length) => s.process(new Float32Array(length), new Float32Array(length));

for (const patch of presets) {
  test(`same-frame note replacement preserves legato regardless of MIDI event order: ${patch.name}`, () => {
    const head = [{ time: 0.01, type: 'noteOn', note: 60, velocity: 0.75 }];
    const off = { time: 0.2, type: 'noteOff', note: 60 };
    const on = { time: 0.2, type: 'noteOn', note: 67, velocity: 0.6 };
    const tail = [{ time: 0.45, type: 'noteOff', note: 67 }];
    const options = { duration: 0.6, breath: 0.7 };
    const offFirst = renderSequence(patch, [...head, off, on, ...tail], options);
    const onFirst = renderSequence(patch, [...head, on, off, ...tail], options);
    assert.deepEqual(offFirst.left, onFirst.left);
    assert.deepEqual(offFirst.right, onFirst.right);
  });
}

test('zero elapsed samples retain envelopes while honoring explicit retrigger parameters', () => {
  for (const patch of presets) {
    const s = new Synth(48000, patch);
    s.setBreath(1);
    s.noteOn(60);
    process(s, 4800);
    const before = s.env.map(({ level, stage, time }) => ({ level, stage, time }));
    s.noteOff(60);
    process(s, 0);
    s.noteOn(67);
    s.env.forEach((e, i) => {
      if (e.retrigger) {
        assert.equal(e.stage, 'attack');
        assert.equal(e.level, 0);
      } else {
        assert.equal(e.level, before[i].level);
        assert.equal(e.stage, before[i].stage);
        assert.equal(e.time, before[i].time);
      }
    });
    assert.equal(s.noteReleasePending, false);
  }
});

test('a real one-sample note gap commits release and the next note starts its attack', () => {
  for (const sampleRate of [44100, 48000, 96000]) {
    const s = new Synth(sampleRate, factory);
    s.setBreath(1);
    s.noteOn(60);
    process(s, Math.round(sampleRate * 0.1));
    s.noteOff(60);
    process(s, 1);
    assert.equal(s.gateTarget, 0);
    assert.equal(s.env[0].stage, 'release');
    assert.equal(s.noteReleasePending, false);
    s.noteOn(67);
    assert.equal(s.env[0].stage, 'attack');
    assert.equal(s.env[0].level, 0);
  }
});

test('unheld note-offs leave the active note and glide progress unchanged', () => {
  const s = new Synth(48000, factory);
  s.noteOn(60);
  process(s, 4800);
  s.noteOn(72);
  process(s, 32);
  const before = { elapsed: s.glideElapsed, from: s.glideFrom, target: s.pitchTarget };
  s.noteOff(10);
  assert.deepEqual({ elapsed: s.glideElapsed, from: s.glideFrom, target: s.pitchTarget }, before);
  assert.equal(s.notes.length, 2);
});

test('panic cancels a pending release so a new voice starts normally', () => {
  const s = new Synth(48000, factory);
  s.noteOn(60);
  process(s, 4800);
  s.noteOff(60);
  s.panic();
  assert.equal(s.noteReleasePending, false);
  s.noteOn(67);
  assert.equal(s.env[0].stage, 'attack');
  assert.equal(s.env[0].level, 0);
});

test('AudioWorklet note handoffs match offline rendering across block boundaries', async () => {
  const source = (
    await readFile(new URL('../web/src/dsp/worklet.js', import.meta.url), 'utf8')
  ).replace(/^import .*?;\s*/, '');
  for (const boundary of [1023, 1024, 1025]) {
    let Processor;
    const context = {
      Synth,
      sampleRate: 48000,
      currentTime: 0,
      AudioWorkletProcessor: class {
        constructor() {
          this.port = { postMessage() {} };
        }
      },
      registerProcessor(name, value) {
        Processor = value;
      },
    };
    vm.runInNewContext(source, context);
    const events = [
      { time: 0, type: 'breath', value: 0.7 },
      { time: 0.002, type: 'noteOn', note: 60, velocity: 0.7 },
      { time: boundary / 48000, type: 'noteOff', note: 60 },
      { time: boundary / 48000, type: 'noteOn', note: 67, velocity: 0.7 },
      { time: 0.06, type: 'noteOff', note: 67 },
    ];
    const expected = renderSequence(factory, events, { duration: 0.08, breath: 0 });
    const processor = new Processor({ processorOptions: { patch: factory } });
    processor.port.onmessage({ data: { command: 'schedule', events, delay: 0 } });
    const left = new Float32Array(expected.left.length);
    const right = new Float32Array(expected.right.length);
    for (let offset = 0; offset < left.length; offset += 128) {
      context.currentTime = offset / 48000;
      processor.process(
        [],
        [[left.subarray(offset, offset + 128), right.subarray(offset, offset + 128)]],
      );
    }
    assert.deepEqual(left, expected.left);
    assert.deepEqual(right, expected.right);
    assert.equal(processor.scheduled.length, 0);
  }
});
