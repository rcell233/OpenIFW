export class AudioEngine {
  constructor(patch) {
    this.patch = patch;
    this.dry = false;
    this.worker = new Worker(new URL('./render-worker.js', import.meta.url), { type: 'module' });
    this.requests = new Map();
    this.id = 0;
    this.worker.onmessage = ({ data }) => {
      const p = this.requests.get(data.id);
      if (!p) return;
      this.requests.delete(data.id);
      data.error ? p.reject(new Error(data.error)) : p.resolve(data);
    };
  }
  async start() {
    if (this.starting) return this.starting;
    if (this.context) {
      await this.context.resume();
      return;
    }
    this.starting = (async () => {
      const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Context) throw new Error('当前浏览器没有 Web Audio 支持');
      this.context = new Context({ sampleRate: 48000, latencyHint: 'interactive' });
      await this.context.audioWorklet.addModule(new URL('./dsp/worklet.js', import.meta.url));
      this.node = new AudioWorkletNode(this.context, 'ifw-engine', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { patch: this.patch, dry: this.dry },
      });
      this.gain = this.context.createGain();
      this.gain.gain.value = 1;
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 2048;
      this.node.connect(this.gain);
      this.gain.connect(this.analyser);
      this.analyser.connect(this.context.destination);
      this.node.port.onmessage = (e) => this.onMeter?.(e.data);
      this.node.onprocessorerror = () =>
        this.onError?.(new Error('音频处理器停止，请刷新页面重新启动音频。'));
      await this.context.resume();
    })();
    try {
      await this.starting;
    } catch (error) {
      if (this.context) await this.context.close();
      this.context = null;
      throw error;
    } finally {
      this.starting = null;
    }
  }
  send(event) {
    this.node?.port.postMessage({ command: 'event', event });
  }
  setPatch(patch) {
    this.patch = patch;
    this.node?.port.postMessage({ command: 'patch', patch });
  }
  setDry(dry) {
    this.dry = dry;
    this.node?.port.postMessage({ command: 'dry', dry });
  }
  panic() {
    this.node?.port.postMessage({ command: 'panic' });
  }
  render(events, options = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve, reject });
      this.worker.postMessage({
        id,
        patch: this.patch,
        events,
        options: { sampleRate: 48000, dry: this.dry, ...options },
      });
    });
  }
}

export function encodeWav({ left, right, sampleRate }, mono = false) {
  const channels = mono ? 1 : 2,
    n = left.length,
    buffer = new ArrayBuffer(44 + n * channels * 2),
    v = new DataView(buffer);
  let p = 0;
  const str = (s) => {
    for (const c of s) v.setUint8(p++, c.charCodeAt(0));
  };
  const u16 = (x) => {
    v.setUint16(p, x, true);
    p += 2;
  };
  const u32 = (x) => {
    v.setUint32(p, x, true);
    p += 4;
  };
  str('RIFF');
  u32(36 + n * channels * 2);
  str('WAVEfmt ');
  u32(16);
  u16(1);
  u16(channels);
  u32(sampleRate);
  u32(sampleRate * channels * 2);
  u16(channels * 2);
  u16(16);
  str('data');
  u32(n * channels * 2);
  for (let i = 0; i < n; i++) {
    const l = mono ? (left[i] + right[i]) * 0.5 : left[i];
    v.setInt16(p, Math.round(Math.max(-1, Math.min(1, l)) * 32767), true);
    p += 2;
    if (!mono) {
      v.setInt16(p, Math.round(Math.max(-1, Math.min(1, right[i])) * 32767), true);
      p += 2;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}
