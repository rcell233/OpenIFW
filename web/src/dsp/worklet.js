import { Synth } from './core.js';
class IFWProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { patch, dry = false } = options.processorOptions;
    this.synth = new Synth(sampleRate, patch);
    this.synth.setDry(dry);
    this.blocks = 0;
    this.scheduled = [];
    this.port.onmessage = ({ data }) => {
      if (data.command === 'patch') this.synth.setPatch(data.patch);
      if (data.command === 'dry') this.synth.setDry(data.dry);
      if (data.command === 'event') this.dispatch(data.event);
      if (data.command === 'schedule')
        (this.scheduled.push(
          ...data.events.map((e) => ({ ...e, at: currentTime + (data.delay ?? 0.03) + e.time })),
        ),
          this.scheduled.sort((a, b) => a.at - b.at));
      if (data.command === 'panic') {
        this.scheduled = [];
        this.synth.panic();
      }
    };
  }
  dispatch(e) {
    const s = this.synth;
    if (e.type === 'noteOn') s.noteOn(e.note, e.velocity ?? 1);
    if (e.type === 'noteOff') s.noteOff(e.note);
    if (e.type === 'breath') s.setBreath(e.value);
    if (e.type === 'bend') s.bendTarget = e.value;
    if (e.type === 'vibrato') s.vibrato = e.value;
    if (e.type === 'glide') s.glide = e.value;
    if (e.type === 'panic') s.panic();
  }
  process(inputs, outputs) {
    const out = outputs[0];
    if (out.length < 2) return true;
    let offset = 0;
    const endTime = currentTime + out[0].length / sampleRate;
    while (this.scheduled.length && this.scheduled[0].at < endTime) {
      const e = this.scheduled.shift(),
        frame = Math.max(
          offset,
          Math.min(out[0].length, Math.round((e.at - currentTime) * sampleRate)),
        );
      if (frame > offset)
        this.synth.process(out[0].subarray(offset, frame), out[1].subarray(offset, frame));
      offset = frame;
      this.dispatch(e);
    }
    if (offset < out[0].length)
      this.synth.process(out[0].subarray(offset), out[1].subarray(offset));
    if ((this.blocks++ & 31) === 0) {
      let peak = 0;
      for (const v of out[0]) peak = Math.max(peak, Math.abs(v));
      this.port.postMessage({
        type: 'meter',
        peak,
        breath: this.synth.breath,
        note: this.synth.note,
        gate: this.synth.gate,
      });
    }
    return true;
  }
}
registerProcessor('ifw-engine', IFWProcessor);
