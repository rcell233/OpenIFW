# OpenIFW

A browser-based wind synthesizer with a shared four-oscillator engine, expressive MIDI input, and `.ifwprog` preset import.

[Live demo](https://ifw-wind-synth-lab.rcell233.chatgpt.site)

## Run locally

Requires Node.js 22 or newer. There are no npm dependencies to install.

```sh
git clone https://github.com/rcell233/OpenIFW.git
cd OpenIFW
npm run dev
```

Open <http://localhost:5173> and click **启动音频** (Start audio). Play the 49-key keyboard with your mouse or the A W S E D F T G Y H U J K keys. Connect a MIDI controller through **连接 MIDI**; the browser will request device access.

## Features

- Four oscillators with sync, FM, pulse width, and noise.
- Three filters, four ADSR envelopes, two LFOs, and an eight-slot modulation matrix.
- Phaser, chorus, two delays, reverb, exciter, and stereo enhancement.
- Six built-in presets, editable parameters, and `.ifwprog` / JSON import.
- Live breath, vibrato, glide, pitch bend, and channel aftertouch input.
- Standard MIDI file playback and offline stereo WAV export.
- Compact fixed panels with a four-octave keyboard.

The default MIDI controls are CC7 for breath, CC9 for vibrato, and CC5 for glide. The MIDI panel lets you change these assignments and the input channel. The UI labels MIDI note 60 as C3.

All presets use the same synthesis engine. This is an independent approximation of IFW; it does not contain the original application's code and does not claim exact audio compatibility. External audio input is currently unsupported.

## Build and test

```sh
npm test
npm run build
```

The build produces a self-contained `dist/` directory. Serve it from the root of an HTTPS static site. Localhost also supports local audio and MIDI development. Uploaded presets and MIDI files are processed in the browser.

```text
web/                 Application and runtime presets
  src/dsp/           Shared synthesis engine and AudioWorklet
  src/               UI, MIDI, and offline rendering
  assets/            Built-in preset parameters
scripts/             Development server and static build
tests/               Functional tests and deterministic render fixtures
```

## License

Original project code is licensed under [MIT](LICENSE). IFW and the bundled factory presets are credited to STUDIO-R; see [third-party notices](THIRD_PARTY_NOTICES.md). OpenIFW is an independent project and is not affiliated with STUDIO-R.
