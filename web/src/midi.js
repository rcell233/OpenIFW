export function decodeMidi(data, config = { breathCC: 7, vibratoCC: 9, glideCC: 5, channel: 0 }) {
  if (!data || data.length < 1) return null;
  const status = data[0],
    kind = status & 0xf0,
    channel = (status & 15) + 1;
  if (status >= 0xf0) return null;
  if (config.channel && channel !== Number(config.channel)) return null;
  const a = data[1] ?? 0,
    b = data[2] ?? 0;
  if (kind === 0x90)
    return b
      ? { type: 'noteOn', note: a, velocity: b / 127, channel }
      : { type: 'noteOff', note: a, channel };
  if (kind === 0x80) return { type: 'noteOff', note: a, channel };
  if (kind === 0xe0)
    return {
      type: 'bend',
      value: Math.max(
        -1,
        Math.min(
          1,
          ((b << 7) | a) - 8192 > 0
            ? (((b << 7) | a) - 8192) / 8191
            : (((b << 7) | a) - 8192) / 8192,
        ),
      ),
      channel,
    };
  if (kind === 0xd0)
    return config.breathCC === 'aftertouch'
      ? { type: 'breath', value: a / 127, channel }
      : { type: 'aftertouch', value: a / 127, channel };
  if (kind === 0xc0) return { type: 'program', program: a, channel };
  if (kind === 0xb0) {
    if (a === 120 || a === 123) return { type: 'panic', channel };
    if (a === Number(config.breathCC)) return { type: 'breath', value: b / 127, channel };
    if (a === Number(config.vibratoCC)) return { type: 'vibrato', value: b / 127, channel };
    if (a === Number(config.glideCC)) return { type: 'glide', value: b / 127, channel };
    return { type: 'cc', cc: a, value: b / 127, channel };
  }
  return null;
}

export function parseMidiFile(
  buffer,
  config = { breathCC: 7, vibratoCC: 9, glideCC: 5, channel: 0 },
) {
  const view = new DataView(buffer);
  let pos = 0;
  const need = (n) => {
    if (pos + n > view.byteLength) throw new Error('MIDI 文件被截断');
  };
  const u8 = () => {
    need(1);
    return view.getUint8(pos++);
  };
  const u16 = () => {
    need(2);
    const n = view.getUint16(pos);
    pos += 2;
    return n;
  };
  const u32 = () => {
    need(4);
    const n = view.getUint32(pos);
    pos += 4;
    return n;
  };
  const text = (n) => String.fromCharCode(...Array.from({ length: n }, u8));
  const variable = () => {
    let n = 0;
    for (let i = 0; i < 4; i++) {
      const b = u8();
      n = (n << 7) | (b & 127);
      if (!(b & 128)) return n;
    }
    throw new Error('无效 MIDI 变长整数');
  };
  if (text(4) !== 'MThd') throw new Error('这不是标准 MIDI 文件');
  const header = u32(),
    headerEnd = pos + header,
    format = u16(),
    tracks = u16(),
    division = u16();
  if (format > 1) throw new Error('目前支持 MIDI Type 0 / Type 1');
  if (division & 0x8000) throw new Error('目前支持 PPQN 时间格式；SMPTE MIDI 尚未实现');
  if (!division || header < 6) throw new Error('无效 MIDI 文件头');
  pos = headerEnd;
  const raw = [];
  let order = 0,
    maxTick = 0;
  for (let track = 0; track < tracks; track++) {
    if (text(4) !== 'MTrk') throw new Error('MIDI 缺少 MTrk 区块');
    const length = u32(),
      end = pos + length;
    need(length);
    let tick = 0,
      running = 0;
    while (pos < end) {
      tick += variable();
      maxTick = Math.max(maxTick, tick);
      let status = u8(),
        first;
      if (status < 0x80) {
        if (!running) throw new Error('无效 MIDI running status');
        first = status;
        status = running;
      }
      if (status === 0xff) {
        const type = u8(),
          len = variable();
        need(len);
        if (type === 0x51 && len === 3)
          raw.push({
            tick,
            type: 'tempo',
            value:
              (view.getUint8(pos) << 16) | (view.getUint8(pos + 1) << 8) | view.getUint8(pos + 2),
            order: order++,
          });
        pos += len;
        if (type === 0x2f) {
          pos = end;
          break;
        }
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        const len = variable();
        need(len);
        pos += len;
        running = 0;
        continue;
      }
      if (status >= 0xf0) throw new Error('MIDI 含不支持的系统事件');
      running = status;
      const type = status & 0xf0,
        a = first ?? u8(),
        bytes = type === 0xc0 || type === 0xd0 ? [status, a] : [status, a, u8()];
      const decoded = decodeMidi(bytes, config);
      if (decoded) raw.push({ ...decoded, tick, order: order++ });
    }
    pos = end;
  }
  raw.sort((a, b) => a.tick - b.tick || a.order - b.order);
  let tempo = 500000,
    tick = 0,
    time = 0;
  const events = [];
  for (const e of raw) {
    time += (((e.tick - tick) / division) * tempo) / 1e6;
    tick = e.tick;
    if (e.type === 'tempo') {
      if (e.value > 0) tempo = e.value;
    } else events.push({ ...e, time });
  }
  time += (((maxTick - tick) / division) * tempo) / 1e6;
  return { format, tracks, division, events, duration: time };
}

export class MidiInput {
  constructor(onEvent, onDevices) {
    this.onEvent = onEvent;
    this.onDevices = onDevices;
    this.config = { breathCC: 7, vibratoCC: 9, glideCC: 5, channel: 0 };
    this.selected = 'all';
  }
  async connect() {
    if (!navigator.requestMIDIAccess)
      throw new Error('当前浏览器不支持 Web MIDI，请使用 Chrome 或 Edge。');
    this.access = await navigator.requestMIDIAccess({ sysex: false });
    this.access.onstatechange = () => {
      this.bind();
      this.onEvent({ type: 'panic' });
    };
    this.bind();
    return this.devices();
  }
  devices() {
    return this.access
      ? [...this.access.inputs.values()].map((i) => ({
          id: i.id,
          name: i.name || i.manufacturer || 'MIDI input',
          state: i.state,
        }))
      : [];
  }
  bind() {
    for (const input of this.access.inputs.values())
      input.onmidimessage = (event) => {
        if (this.selected !== 'all' && input.id !== this.selected) return;
        const decoded = decodeMidi(event.data, this.config);
        if (decoded) this.onEvent({ ...decoded, device: input.name });
      };
    this.onDevices?.(this.devices());
  }
}
