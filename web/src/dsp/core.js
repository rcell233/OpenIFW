// Independent approximation of the IFW signal path. No native IFW code.
// Shared by the real-time AudioWorklet and the deterministic Node/offline renderer.
import { Envelope } from './envelope.js';
import { destinationKey } from './modulation.js';
import {
  OSCILLATOR_GAIN,
  SECONDARY_WAVE_GAIN,
  NOISE_GAIN,
  PITCH_MOD_SEMITONES,
  AMP_MOD_GAIN,
  EG_RATE_LOG_SLOPE,
  filter3Hz,
  parameterCutoffHz,
} from './native-controls.js';
export { Envelope } from './envelope.js';
const TAU = 2 * Math.PI;
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const midiToHz = (n, tuning = 440) => tuning * 2 ** ((n - 69) / 12);
export const value = (p, key, fallback = 0) =>
  Number.isFinite(Number(p[key])) ? Number(p[key]) : fallback;
const on = (x) => x === true || x === 'On' || x === 1 || x === '1';
const soft = (x) => x / (1 + 0.015 * Math.abs(x));
function modulationReader(name) {
  const text = String(name).toUpperCase();
  if (text === 'NONE') return () => 1;
  const osc = text.match(/OSC\s*(\d)/);
  if (osc) {
    const i = Number(osc[1]) - 1,
      bipolar = text.includes('+-') || text.includes('-+');
    return (synth) => {
      const v = text.includes('SAW')
        ? synth.rawSaw[i]
        : text.includes('PWM')
          ? synth.rawPulse[i]
          : text.includes('NOISE')
            ? synth.noiseValue
            : synth.secondaryCv[i];
      return bipolar ? v : (v + 1) * 0.5;
    };
  }
  return (synth) => synth.source(name);
}
export function polyBlep(t, dt) {
  if (dt <= 0 || dt >= 0.5) return 0;
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}
export function oscillatorWave(phase, dt, type = 'SIN', width = 0.5) {
  const p = phase - Math.floor(phase);
  if (type === 'SIN' || type === 'SINE') return Math.sin(TAU * p) * SECONDARY_WAVE_GAIN;
  if (type === 'TRI') return ((SECONDARY_WAVE_GAIN * 2) / Math.PI) * Math.asin(Math.sin(TAU * p));
  if (type === 'SAW') return 2 * p - 1 - polyBlep(p, dt);
  if (type === 'SQU' || type === 'PWM' || type === 'PULSE') {
    width = clamp(width, 0.005, 0.995);
    return (
      (p < width ? 1 : -1) - (2 * width - 1) + polyBlep(p, dt) - polyBlep((p - width + 1) % 1, dt)
    );
  }
  if (type === 'Ext In') return 0;
  return 0;
}

class Filter {
  constructor(sr) {
    this.sr = sr;
    this.z = new Float64Array(4);
    this.last = 0;
    this.coeff = 0;
  }
  configure(type, frequency, resonance) {
    this.type = type;
    this.res = clamp(resonance / 10, 0, 0.995);
    // Native LPF12/24 use two/four ordinary exponential one-pole sections.
    this.coeff = 1 - Math.exp((-TAU * Math.max(0.1, frequency)) / this.sr);
  }
  tick(input) {
    let x = this.res ? soft(input - this.last * this.res * 3.85) : input,
      a = this.coeff,
      y = 0;
    const poles = this.type === 'LPF24' ? 4 : 2;
    for (let i = 0; i < poles; i++) {
      y = this.z[i] + (x - this.z[i]) * a;
      this.z[i] = y;
      if (this.type === 'HPF12') x = x - y;
      else x = y;
    }
    this.last = y;
    if (this.type === 'BPF12') return 2 * (this.z[0] - y);
    return x;
  }
  reset() {
    this.z.fill(0);
    this.last = 0;
  }
}

class Filter3 {
  constructor(sr) {
    this.sr = sr;
    this.z = new Float64Array(24);
    this.last = 0;
    this.enabled = false;
  }
  configure(p, mod) {
    this.enabled = on(p.Filter3Enabled);
    this.mix = (value(p, 'Filter3Mix') + (mod.Filter3Mix || 0)) / 10;
    this.stages = clamp(Math.round(value(p, 'Filter3Stage', 2)), 2, 24);
    this.feedback = clamp(
      (value(p, 'Filter3Resonance') + (mod.Filter3Resonance || 0)) / 10,
      -0.999,
      0.999,
    );
    const frequency = filter3Hz(
      value(p, 'Filter3Frequency') + (mod.Filter3Frequency || 0),
      this.sr,
    );
    const g = Math.tan((Math.PI * frequency) / this.sr);
    this.a = (g - 1) / (g + 1);
  }
  tick(input) {
    if (!this.enabled || this.mix === 0) return input;
    let y = input + this.last * this.feedback;
    for (let i = 0; i < this.stages; i++) {
      const v = this.a * y + this.z[i];
      this.z[i] = y - this.a * v;
      y = v;
    }
    const wet = this.last;
    this.last = y;
    // Limit resonance before the amplifier's breath and envelope gain.
    return clamp(input * (1 - Math.abs(this.mix)) + wet * this.mix, -5, 5);
  }
  reset() {
    this.z.fill(0);
    this.last = 0;
  }
}

class Biquad {
  constructor() {
    this.b0 = 1;
    this.b1 = this.b2 = this.a1 = this.a2 = this.z1 = this.z2 = 0;
  }
  shelf(sr, freq, gain, high = false) {
    const A = 10 ** (gain / 40),
      w = (TAU * freq) / sr,
      c = Math.cos(w),
      s = Math.sin(w),
      alpha = s / Math.sqrt(2),
      q = 2 * Math.sqrt(A) * alpha;
    let a0;
    if (high) {
      this.b0 = A * (A + 1 + (A - 1) * c + q);
      this.b1 = -2 * A * (A - 1 + (A + 1) * c);
      this.b2 = A * (A + 1 + (A - 1) * c - q);
      a0 = A + 1 - (A - 1) * c + q;
      this.a1 = 2 * (A - 1 - (A + 1) * c);
      this.a2 = A + 1 - (A - 1) * c - q;
    } else {
      this.b0 = A * (A + 1 - (A - 1) * c + q);
      this.b1 = 2 * A * (A - 1 - (A + 1) * c);
      this.b2 = A * (A + 1 - (A - 1) * c - q);
      a0 = A + 1 + (A - 1) * c + q;
      this.a1 = -2 * (A - 1 + (A + 1) * c);
      this.a2 = A + 1 + (A - 1) * c - q;
    }
    for (const k of ['b0', 'b1', 'b2', 'a1', 'a2']) this[k] /= a0;
  }
  tick(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

class DelayLine {
  constructor(length) {
    this.data = new Float32Array(length);
    this.head = 0;
  }
  read(samples) {
    const p =
      (this.head - clamp(samples, 1, this.data.length - 2) + this.data.length) % this.data.length;
    const i = Math.floor(p),
      f = p - i;
    return this.data[i] * (1 - f) + this.data[(i + 1) % this.data.length] * f;
  }
  push(v) {
    this.data[this.head] = Number.isFinite(v) ? v : 0;
    this.head = (this.head + 1) % this.data.length;
  }
}

// Independently written Schroeder/Freeverb-style sections. The historical tuning
// lengths and room/damping scaling are also documented in JUCE's Reverb API/source.
class ReverbComb {
  constructor(length) {
    this.data = new Float32Array(length);
    this.head = 0;
    this.store = 0;
  }
  tick(input, feedback, damp) {
    const y = this.data[this.head];
    this.store = y * (1 - damp) + this.store * damp;
    this.data[this.head] = input + this.store * feedback;
    this.head = (this.head + 1) % this.data.length;
    return y;
  }
}
class ReverbAllpass {
  constructor(length) {
    this.data = new Float32Array(length);
    this.head = 0;
  }
  tick(input) {
    const b = this.data[this.head],
      y = b - input;
    this.data[this.head] = input + b * 0.5;
    this.head = (this.head + 1) % this.data.length;
    return y;
  }
}

class Effects {
  constructor(sr) {
    this.sr = sr;
    this.phase = 0;
    this.chorus = new DelayLine(Math.ceil(sr * 0.1));
    this.enhancer = new DelayLine(Math.ceil(sr * 0.1));
    this.delays = Array.from({ length: 4 }, () => new DelayLine(Math.ceil(sr * 2.05)));
    this.delayLP = new Float64Array(4);
    this.delayHP = new Float64Array(4);
    const combLengths = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617],
      diffuserLengths = [556, 441, 341, 225];
    this.reverbL = combLengths.map((n) => new ReverbComb(Math.floor((n * sr) / 44100)));
    this.reverbR = combLengths.map((n) => new ReverbComb(Math.floor(((n + 23) * sr) / 44100)));
    this.diffuserL = diffuserLengths.map((n) => new ReverbAllpass(Math.floor((n * sr) / 44100)));
    this.diffuserR = diffuserLengths.map(
      (n) => new ReverbAllpass(Math.floor(((n + 23) * sr) / 44100)),
    );
    this.reverbDamp = new Float64Array(16);
    this.phaser = new Float64Array(12);
    this.phaserFeedback = new Float64Array(2);
    this.phaserLow = new Float64Array(2);
    this.allpass = new Float64Array(24);
    this.f3last = 0;
    this.lowL = new Biquad();
    this.lowR = new Biquad();
    this.highL = new Biquad();
    this.highR = new Biquad();
    this.exciter1 = new DelayLine(Math.ceil((sr * 22) / 48000) + 4);
    this.exciter2 = new DelayLine(Math.ceil((sr * 22) / 48000) + 4);
    this.left = this.right = 0;
  }
  configure(patch, dry) {
    const p = patch.parameters;
    this.p = p;
    this.dry = dry;
    this.fx = patch.fx.map((f, i) => ({
      name: f.name,
      parameters: f.parameters,
      active:
        f.parameters.Bypass === 'Off' &&
        !dry &&
        !on(
          patch.settings?.[
            [
              'FxBypassPhaser',
              'FxBypassChorus',
              'FxBypassDelay1',
              'FxBypassDelay2',
              'FxBypassReverb',
            ][i]
          ],
        ),
    }));
    this.chorusPhase = value(patch.modelTuning || {}, 'chorusPhase', 0);
    for (const eq of [this.lowL, this.lowR]) eq.shelf(this.sr, 350, value(p, 'EqLowGain'));
    for (const eq of [this.highL, this.highR])
      eq.shelf(this.sr, 6000, value(p, 'EqHighGain'), true);
  }
  tick(input, mod = {}) {
    const p = this.p,
      sr = this.sr;
    const cv = (key) => value(p, key) + (mod[key] || 0);
    let x = input;
    {
      // Two identical, linearly interpolated delay sections. With integer D,
      // H(z)=(1+2g)z^-D-g(1+z^-2D): a symmetric frequency boost, not saturation.
      // Delay and gain are controlled by D=21-2*F and g=.2*MIX.
      const delay = (clamp(21 - 2 * cv('ExciterFrequency'), 1, 21) * sr) / 48000,
        g = 0.2 * cv('ExciterMix');
      const center = this.exciter1.read(delay),
        end = this.exciter2.read(delay);
      this.exciter1.push(x);
      this.exciter2.push(center);
      x = (1 + 2 * g) * center - g * (x + end);
    }
    let l = x,
      r = x;
    if (cv('EnhancerMix')) {
      const mix = cv('EnhancerMix') / 10;
      l += this.enhancer.read(value(p, 'EnhancerDelayL') * 0.001 * sr) * mix;
      r += this.enhancer.read(value(p, 'EnhancerDelayR') * 0.001 * sr) * mix;
    }
    this.enhancer.push(x);
    this.phase = (this.phase + 1 / sr) % 10000;
    if (this.fx[0]?.active) {
      const q = this.fx[0].parameters,
        mix = value(q, 'WetDry') / 10,
        rate = value(q, 'Speed', 1),
        spread = value(q, 'Stereo') / 10;
      for (let ch = 0; ch < 2; ch++) {
        const freq =
          200 + 2500 * (0.5 + 0.5 * Math.sin(TAU * this.phase * rate + ch * spread * Math.PI));
        const g = Math.tan((Math.PI * freq) / sr),
          a = (g - 1) / (g + 1);
        let y = (ch ? r : l) + this.phaserFeedback[ch] * value(q, 'Feedback') * 0.075;
        for (let k = 0; k < 6; k++) {
          const i = ch * 6 + k,
            v = -a * y + this.phaser[i];
          this.phaser[i] = y + a * v;
          y = v;
        }
        const lowpass = clamp(midiToHz(12 + 10 * value(q, 'Lowpass', 4)), 10, sr * 0.45);
        this.phaserLow[ch] += (y - this.phaserLow[ch]) * (1 - Math.exp((-TAU * lowpass) / sr));
        y = this.phaserLow[ch];
        this.phaserFeedback[ch] = soft(y);
        if (ch) r += y * mix;
        else l += y * mix;
      }
    }
    if (this.fx[1]?.active) {
      const q = this.fx[1].parameters,
        rate = value(q, 'Rate', 0.3),
        depth = value(q, 'Depth', 7) / 10,
        mix = value(q, 'Mix', 2.7) / 10;
      // Opposing triangular delay sweeps with depth-scaled excursion.
      const amount = 0.0042 * depth * sr,
        base = 0.0016 * sr + amount;
      const phase = (rate * 1.00048 * this.phase + this.chorusPhase / TAU) % 1;
      const triangle = (2 / Math.PI) * Math.asin(Math.sin(TAU * phase));
      const cl = this.chorus.read(base + amount * triangle),
        cr = this.chorus.read(base - amount * triangle);
      this.chorus.push((l + r) * 0.5);
      l = l * (1 - mix * 0.5) + cl * mix * 0.5;
      r = r * (1 - mix * 0.5) + cr * mix * 0.5;
    } else this.chorus.push((l + r) * 0.5);
    for (let k = 0; k < 2; k++) {
      const effect = this.fx[k + 2];
      if (!effect?.active) continue;
      const q = effect.parameters,
        time = clamp(value(q, 'Time', 0.2), 0.001, 2) * sr;
      const fb = clamp(value(q, 'Depth') / 10, 0, 0.96),
        mix = value(q, 'WetDry') / 10;
      const gl = Math.tan((Math.PI * clamp(value(q, 'Lowpass', 15000), 10, sr * 0.45)) / sr),
        gh = Math.tan((Math.PI * clamp(value(q, 'Highpass', 10), 10, sr * 0.45)) / sr),
        lp = gl / (1 + gl),
        hp = gh / (1 + gh);
      for (let ch = 0; ch < 2; ch++) {
        const i = k * 2 + ch,
          d = this.delays[i].read(time),
          v = (d - this.delayLP[i]) * lp,
          low = v + this.delayLP[i];
        this.delayLP[i] = low + v;
        const hv = (low - this.delayHP[i]) * hp,
          hlo = hv + this.delayHP[i];
        this.delayHP[i] = hlo + hv;
        const wet = low - hlo,
          dry = ch ? r : l;
        this.delays[i].push(dry + soft(wet) * fb);
        if (ch) r = dry * (1 - mix) + wet * mix;
        else l = dry * (1 - mix) + wet * mix;
      }
    }
    if (this.fx[4]?.active) {
      const q = this.fx[4].parameters,
        size = clamp(value(q, 'Size', 6.6) / 10, 0, 1),
        damp = value(q, 'HighDamp', 3) / 10,
        width = value(q, 'Width', 6.4) / 10,
        mix = value(q, 'WetDry', 2) / 10;
      const mono = (l + r) * 0.015,
        feedback = 0.7 + size * 0.28;
      let wl = 0,
        wr = 0;
      for (let i = 0; i < 8; i++) {
        wl += this.reverbL[i].tick(mono, feedback, damp * 0.4);
        wr += this.reverbR[i].tick(mono, feedback, damp * 0.4);
      }
      for (const allpass of this.diffuserL) wl = allpass.tick(wl);
      for (const allpass of this.diffuserR) wr = allpass.tick(wr);
      // The width control redistributes wet energy between the stereo channels.
      const wet1 = mix * 2.25 * (1 + width),
        wet2 = mix * 2.25 * (1 - width),
        dryGain = 2 - mix;
      l = l * dryGain + wl * wet1 + wr * wet2;
      r = r * dryGain + wr * wet1 + wl * wet2;
    }
    {
      l = this.highL.tick(this.lowL.tick(l));
      r = this.highR.tick(this.lowR.tick(r));
    }
    this.left = Number.isFinite(l) ? l : 0;
    this.right = Number.isFinite(r) ? r : 0;
  }
}

export class Synth {
  constructor(sampleRate = 48000, patch = null) {
    this.sampleRate = sampleRate;
    this.internalRate = sampleRate * 2;
    this.phase = new Float64Array(4);
    this.secondary = new Float64Array(4);
    this.secondaryCv = new Float64Array(4);
    this.rawSaw = new Float64Array(4);
    this.rawPulse = new Float64Array(4);
    this.filters = [new Filter(sampleRate), new Filter(sampleRate)];
    this.env = Array.from({ length: 4 }, () => new Envelope(sampleRate));
    this.effects = new Effects(sampleRate);
    this.filter3 = new Filter3(sampleRate);
    this.notes = [];
    this.note = 60;
    this.pitch = 60;
    this.pitchTarget = 60;
    this.velocity = 1;
    this.breath = 0;
    this.breathTarget = 0;
    this.bend = 0;
    this.bendTarget = 0;
    this.vibrato = 0;
    this.glide = 0;
    this.gate = 0;
    this.gateTarget = 0;
    this.gateStep = 0;
    this.breathStep = 0;
    this.breathSamplesLeft = 0;
    this.time = 0;
    this.noteTime = 0;
    this.lfoPhase = new Float64Array(2);
    this.control = new Float64Array(4);
    this.masterPhase = 0;
    this.seed = 123456789;
    this.dry = false;
    this.blockCount = 0;
    this.noiseCounter = 0;
    this.noiseHeld = 0;
    this.glideElapsed = 0;
    this.glideFrom = 60;
    this.glideSmoothed = 0;
    if (patch) this.setPatch(patch);
  }
  setPatch(patch) {
    this.patch = JSON.parse(JSON.stringify(patch));
    this.p = this.patch.parameters;
    const p = this.p;
    this.osc = Array.from({ length: 4 }, (_, i) => {
      const n = i + 1,
        k = 'Osc' + n;
      return {
        sync: on(p[k + 'Sync']),
        semi: value(p, k + 'Semi'),
        tune: value(p, k + 'Tune'),
        saw: value(p, k + 'SawLevel') / 10,
        wave: value(p, k + 'TriLevel') / 10,
        pulse: value(p, k + 'PwmLevel') / 10,
        width: clamp(value(p, k + 'PwmWidth', 5) / 10, 0.005, 0.995),
        noise: value(p, k + 'NoiseLevel') / 10,
        lofi: value(p, k + 'NoiseLoFi'),
        waveform: p[k + 'Waveform2'] || 'TRI',
        out1: on(p[k + 'Output1']),
        out2: on(p[k + 'Output2']),
      };
    });
    for (let i = 0; i < 4; i++) {
      let k = 'Eg' + (i + 1);
      this.env[i].configure(
        value(p, k + 'Attack'),
        value(p, k + 'Decay', 5),
        value(p, k + 'Sustain', 10),
        value(p, k + 'Release'),
        on(p[k + 'Retrigger']),
      );
    }
    this.mods = Array.from({ length: 8 }, (_, i) => {
      const k = 'Mod' + (i + 1),
        dest = p[k + 'Destination'] || 'None';
      return {
        source1: p[k + 'Source1'] || 'None',
        source2: p[k + 'Source2'] || 'None',
        dest,
        key: destinationKey(dest),
        depth: value(p, k + 'Depth'),
      };
    }).filter((m) => m.source1.toUpperCase() !== 'NONE' && m.key && m.depth !== 0);
    this.modValues = {};
    this.fmMods = Array.from({ length: 4 }, (_, i) =>
      this.mods
        .filter((m) => m.key === 'Osc' + (i + 1) + 'FM')
        .map((m) => ({
          a: modulationReader(m.source1),
          b: modulationReader(m.source2),
          depth: m.depth * 0.1,
        })),
    );
    this.effects.configure(this.patch, this.dry);
    this.filter3.configure(p, this.modValues);
  }
  setDry(dry) {
    this.dry = !!dry;
    this.effects.configure(this.patch, this.dry);
  }
  setBreath(v) {
    v = clamp(v, 0, 1);
    if (v === this.breathTarget) return;
    this.breathTarget = v;
    this.breathSamplesLeft = Math.max(
      1,
      Math.round(this.sampleRate * value(this.p || {}, 'BreathSmoothTime', 12) * 0.001),
    );
    this.breathStep = (this.breathTarget - this.breath) / this.breathSamplesLeft;
  }
  noteOn(note, velocity = 1) {
    const legato = this.notes.length > 0;
    this.notes = this.notes.filter((n) => n.note !== note);
    this.notes.push({ note, velocity });
    this.note = note;
    this.pitchTarget = note;
    this.velocity = velocity;
    this.glideFrom = this.pitch;
    this.glideElapsed = 0;
    if (!legato && this.gate < 0.0001) this.pitch = this.glideFrom = note;
    this.gateTarget = 1;
    this.gateStep =
      (1 - this.gate) /
      Math.max(1, this.sampleRate * value(this.p, 'GateOpenSmoothTime', 2) * 0.001);
    if (!legato) this.noteTime = 0;
    for (const eg of this.env) eg.gate(true, legato);
    for (let i = 0; i < 2; i++) if (on(this.p['Lfo' + (i + 1) + 'KeySync'])) this.lfoPhase[i] = 0;
  }
  noteOff(note) {
    this.notes = this.notes.filter((n) => n.note !== note);
    if (this.notes.length) {
      const n = this.notes.at(-1);
      this.note = n.note;
      this.pitchTarget = n.note;
      this.velocity = n.velocity;
      this.glideFrom = this.pitch;
      this.glideElapsed = 0;
    } else {
      this.gateTarget = 0;
      this.gateStep =
        this.gate / Math.max(1, this.sampleRate * value(this.p, 'GateCloseSmoothTime', 15) * 0.001);
      for (const eg of this.env) eg.gate(false);
    }
  }
  panic() {
    this.notes = [];
    this.gate = this.gateTarget = this.gateStep = 0;
    this.breath = this.breathTarget = this.breathStep = this.breathSamplesLeft = 0;
    this.effects = new Effects(this.sampleRate);
    this.effects.configure(this.patch, this.dry);
    for (const f of [...this.filters, this.filter3]) f.reset();
    for (const e of this.env) {
      e.stage = 'idle';
      e.level = 0;
    }
  }
  source(name) {
    if (name === 'None') return 1;
    const s = name.toUpperCase();
    const bipolar = s.includes('+-') || s.includes('-+');
    if (s.includes('BREATH') || s === 'BR') return bipolar ? this.breath * 2 - 1 : this.breath;
    if (s.includes('VELOCITY')) return bipolar ? 2 * (this.velocity - 64 / 127) : this.velocity;
    if (s.includes('NOTE')) return bipolar ? (2 * (this.pitch - 64)) / 127 : this.note / 127;
    if (s.includes('PITCH BEND')) return this.bend;
    if (s.includes('VIBRATO')) return this.vibrato;
    if (s.includes('GLIDE')) return this.glide;
    if (s.includes('GATE')) return this.gate;
    const eg = s.match(/EG\s*(\d)/);
    if (eg) {
      const level = this.env[Number(eg[1]) - 1]?.level || 0;
      return bipolar ? 2 * level - 1 : level;
    }
    const lfo = s.match(/LFO\s*(\d)/);
    if (lfo) {
      const i = Number(lfo[1]) - 1,
        phase = this.lfoPhase[i],
        type = this.p['Lfo' + (i + 1) + 'Waveform'] || 'TRI';
      let v =
        oscillatorWave(phase, 0, type === 'SQU' ? 'PULSE' : type) / (type === 'TRI' ? 1.1785 : 1);
      return s.includes('+-') || s.includes('-+') ? v : (v + 1) * 0.5;
    }
    const osc = s.match(/OSC\s*(\d)/);
    if (osc) {
      const i = Number(osc[1]) - 1;
      let v = s.includes('SAW')
        ? this.rawSaw[i]
        : s.includes('PWM')
          ? this.rawPulse[i]
          : s.includes('NOISE')
            ? this.noiseValue
            : this.secondaryCv[i];
      return s.includes('+-') || s.includes('-+') ? v : (v + 1) * 0.5;
    }
    return 0;
  }
  breathSource(key) {
    const source = this.p[key] || 'BREATH';
    const eg = source.match(/EG\s*(\d)/i);
    return this.breath * (eg ? this.env[Number(eg[1]) - 1]?.level || 0 : 1);
  }
  updateControls() {
    const p = this.p;
    this.modValues = {};
    for (const m of this.mods) {
      if (/FM$/.test(m.key)) continue;
      const v = this.source(m.source1) * this.source(m.source2) * m.depth;
      this.modValues[m.key] = (this.modValues[m.key] || 0) + v;
    }
    const note =
      this.pitch +
      value(p, 'Transpose') +
      this.bend * value(p, 'PitchBendRange', 2) +
      value(p, 'MasterTune') / 100;
    this.frequency = midiToHz(note, value(this.patch.settings || {}, 'Tuning', 440));
    for (let i = 0; i < 2; i++) {
      const k = 'Filter' + (i + 1),
        mod = this.modValues[k + 'Frequency'] || 0;
      const frequency = parameterCutoffHz(
        value(p, k + 'Frequency') + mod,
        value(p, k + 'Breath'),
        this.breathSource(k + 'BreathSubMod'),
        value(p, k + 'KeyTrack'),
        note,
        this.sampleRate,
      );
      this.filters[i].configure(
        p[k + 'Type'] || 'LPF24',
        frequency,
        value(p, k + 'Resonance') + (this.modValues[k + 'Resonance'] || 0),
      );
    }
    this.filter3.configure(p, this.modValues);
  }
  ampGain(i) {
    const k = 'Amp' + (i + 1),
      depth = value(this.p, k + 'Breath', 10) / 10;
    const eg = String(this.p[k + 'BreathSubMod'] || 'BREATH').match(/EG\s*(\d)/i);
    const mod = this.breath * (eg ? this.env[Number(eg[1]) - 1].level : this.gate);
    const base = (value(this.p, k + 'Level', 10) / 10) * ((1 - depth) * this.gate + depth * mod);
    return (
      base +
      (this.modValues?.[k + 'Level'] || 0) *
        AMP_MOD_GAIN *
        (eg ? this.env[Number(eg[1]) - 1].level : this.gate)
    );
  }
  modelSample() {
    let sumBus1 = 0,
      sumBus2 = 0;
    const p = this.p;
    for (let sub = 0; sub < 2; sub++) {
      let bus1 = 0,
        bus2 = 0,
        previousWrap = false,
        previousElapsed = 0;
      const masterStep = this.frequency / this.internalRate;
      // Sync followers reset at the centre crossing of the phase ramp.
      const masterBefore = this.masterPhase;
      this.masterPhase = (masterBefore + masterStep) % 1;
      const masterWrap = masterBefore < 0.5 && masterBefore + masterStep >= 0.5;
      const masterElapsed = masterWrap ? (masterBefore + masterStep - 0.5) / masterStep : 0;
      for (let i = 0; i < 4; i++) {
        const o = this.osc[i];
        let fm = 0;
        // Audio oscillator sources must be evaluated at the internal sample rate,
        // including when their mixer level is zero; block-rate FM changes the tone.
        for (const m of this.fmMods[i]) fm += m.a(this) * m.b(this) * m.depth;
        const k = 'Osc' + (i + 1),
          cv = (suffix) => this.modValues[k + suffix] || 0;
        let step =
          (this.frequency *
            2 ** ((o.semi + o.tune / 100 + PITCH_MOD_SEMITONES * cv('Pitch')) / 12)) /
          this.internalRate;
        step = clamp(step, 0, 0.45);
        const before = this.phase[i],
          next = before + step;
        let wrap = before < 0.5 && next >= 0.5;
        this.phase[i] = next - Math.floor(next);
        let elapsed = wrap && step > 0 ? (next - 0.5) / step : 0;
        if (o.sync && (i === 0 ? masterWrap : previousWrap)) {
          elapsed = i === 0 ? masterElapsed : previousElapsed;
          this.phase[i] = 0.5 + step * elapsed;
          wrap = true;
        }
        // Phase modulation changes the read phase without changing the sync clock.
        const phase = this.phase[i] + fm,
          dt = Math.abs(step);
        this.rawSaw[i] = oscillatorWave(phase, dt, 'SAW');
        // Align the secondary wave's phase before summing the oscillator outputs.
        this.secondary[i] = oscillatorWave(
          phase + (['SIN', 'SINE', 'TRI'].includes(o.waveform) ? 0.5 : 0),
          dt,
          o.waveform,
        );
        // Audio SIN/TRI gain is distinct from the matrix's unit-amplitude CV.
        this.secondaryCv[i] =
          this.secondary[i] /
          (['SIN', 'SINE', 'TRI'].includes(o.waveform) ? SECONDARY_WAVE_GAIN : 1);
        const width = clamp(o.width + cv('PwmWidth') / 10, 0.005, 0.995);
        this.rawPulse[i] = oscillatorWave(phase + width, dt, 'PWM', width);
        this.seed ^= this.seed << 13;
        this.seed ^= this.seed >>> 17;
        this.seed ^= this.seed << 5;
        this.noiseValue = (this.seed >>> 0) / 2147483648 - 1;
        if (i === 3) {
          if (this.noiseCounter-- <= 0) {
            this.noiseHeld = this.noiseValue;
            this.noiseCounter = Math.floor(o.lofi * o.lofi * 2);
          }
          this.noiseValue = this.noiseHeld;
        }
        const signal =
          this.rawSaw[i] * clamp(o.saw + cv('SawLevel') / 10, 0, 1) +
          this.secondary[i] * clamp(o.wave + cv('TriLevel') / 10, 0, 1) +
          this.rawPulse[i] * clamp(o.pulse + cv('PwmLevel') / 10, 0, 1) +
          this.noiseValue * NOISE_GAIN * clamp(o.noise + cv('NoiseLevel') / 10, 0, 1);
        if (o.out1) bus1 += signal;
        if (o.out2) bus2 += signal;
        previousWrap = wrap;
        previousElapsed = elapsed;
      }
      sumBus1 += bus1;
      sumBus2 += bus2;
    }
    // Native LP sections and Filter 3 run on the output clock. Only oscillator
    // generation is oversampled; filtering twice per output sample changes HF.
    const bus1 = sumBus1 * 0.5,
      bus2 = sumBus2 * 0.5,
      route = p.FilterConnection || 'Parallel 2';
    let branch1 = 0,
      branch2 = 0;
    if (route === 'Serial') branch1 = this.filters[1].tick(this.filters[0].tick(bus1 + bus2));
    else if (route === 'Parallel 1')
      branch1 = this.filters[0].tick(bus1) + this.filters[1].tick(bus2);
    else {
      branch1 = this.filters[0].tick(bus1);
      branch2 = this.filters[1].tick(bus2);
    }
    return (
      (this.filter3.tick(branch1) * this.ampGain(0) + branch2 * this.ampGain(1)) * OSCILLATOR_GAIN
    );
  }
  process(left, right, length = left.length) {
    if (!this.patch) {
      left.fill(0);
      right.fill(0);
      return;
    }
    const sr = this.sampleRate,
      p = this.p;
    const bendK =
      1 - Math.exp(-1 / (sr * Math.max(0.0001, value(p, 'PitchBendSmoothTime', 5) * 0.001)));
    for (let i = 0; i < length; i++) {
      if (this.breathSamplesLeft > 0) {
        this.breath += this.breathStep;
        if (--this.breathSamplesLeft === 0) this.breath = this.breathTarget;
      }
      this.bend += (this.bendTarget - this.bend) * bendK;
      this.gate = this.gateTarget
        ? Math.min(1, this.gate + this.gateStep)
        : Math.max(0, this.gate - this.gateStep);
      const glideSmooth =
        1 - Math.exp(-1 / (sr * Math.max(0.0001, value(p, 'GlideSmoothTime', 5) * 0.001)));
      this.glideSmoothed += (this.glide - this.glideSmoothed) * glideSmooth;
      const glide =
        value(p, 'GlideMinimumSpeed', 0) +
        (on(p.GlideMidiEnabled) ? this.glideSmoothed : 1) * value(p, 'GlideSpeed', 0);
      const glideSeconds = glide > 0 ? 0.002 * 2 ** (glide * 1.2) : 0;
      this.glideElapsed += 1 / sr;
      if (glideSeconds > 0 && p.GlideMode === 'Rate')
        this.pitch += clamp(
          this.pitchTarget - this.pitch,
          -12 / (sr * glideSeconds),
          12 / (sr * glideSeconds),
        );
      else if (glideSeconds > 0)
        this.pitch =
          this.glideFrom +
          (this.pitchTarget - this.glideFrom) * clamp(this.glideElapsed / glideSeconds, 0, 1);
      else this.pitch = this.pitchTarget;
      this.env.forEach((e, j) =>
        e.tick(
          Math.exp(
            EG_RATE_LOG_SLOPE * clamp(this.modValues?.['Eg' + (j + 1) + 'Rate'] || 0, -10, 10),
          ),
        ),
      );
      for (let j = 0; j < 2; j++) {
        const k = 'Lfo' + (j + 1);
        let hz = 0.02 * 2 ** (value(p, k + 'Speed', 2) + (this.modValues?.[k + 'Rate'] || 0));
        if (on(p[k + 'BPMSync']) || on(p[k + 'BpmSync'])) {
          const beat = (p[k + 'Beat'] || '1/4').split('/').map(Number);
          hz = 2 / ((beat[0] / beat[1]) * 4);
        }
        this.lfoPhase[j] = (this.lfoPhase[j] + hz / sr) % 1;
      }
      if ((this.blockCount++ & 15) === 0) this.updateControls();
      this.effects.tick(this.modelSample(), this.modValues);
      const master = (value(p, 'MasterLevel', 10) / 10) ** 2;
      left[i] = clamp(this.effects.left * master, -1, 1);
      right[i] = clamp(this.effects.right * master, -1, 1);
      this.time += 1 / sr;
      if (this.gateTarget) this.noteTime += 1 / sr;
    }
  }
}

export function renderSequence(
  patch,
  events,
  { sampleRate = 48000, duration = 10, dry = false, breath = 1, chorusPhase } = {},
) {
  if (Number.isFinite(chorusPhase)) {
    patch = JSON.parse(JSON.stringify(patch));
    patch.modelTuning = { ...patch.modelTuning, chorusPhase };
  }
  const synth = new Synth(sampleRate, patch);
  synth.setDry(dry);
  synth.setBreath(breath);
  const total = Math.ceil(duration * sampleRate),
    left = new Float32Array(total),
    right = new Float32Array(total);
  const scheduled = events
    .map((e, index) => ({ ...e, index, frame: Math.max(0, Math.round(e.time * sampleRate)) }))
    .sort((a, b) => a.frame - b.frame || a.index - b.index);
  let offset = 0;
  const dispatch = (e) => {
    if (e.type === 'noteOn') synth.noteOn(e.note, e.velocity ?? 1);
    if (e.type === 'noteOff') synth.noteOff(e.note);
    if (e.type === 'breath') synth.setBreath(e.value);
    if (e.type === 'bend') synth.bendTarget = e.value;
    if (e.type === 'glide') synth.glide = e.value;
    if (e.type === 'vibrato') synth.vibrato = e.value;
    if (e.type === 'panic') synth.panic();
  };
  for (const e of [...scheduled, { frame: total }]) {
    const end = Math.min(total, e.frame);
    if (end > offset) synth.process(left.subarray(offset, end), right.subarray(offset, end));
    offset = end;
    if (e.type) dispatch(e);
    if (offset >= total) break;
  }
  return { left, right, sampleRate };
}
