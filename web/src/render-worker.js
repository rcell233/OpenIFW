import { renderSequence } from './dsp/core.js';
self.onmessage = ({ data }) => {
  try {
    const audio = renderSequence(data.patch, data.events, data.options);
    self.postMessage({ id: data.id, ...audio }, [audio.left.buffer, audio.right.buffer]);
  } catch (error) {
    self.postMessage({ id: data.id, error: error.message });
  }
};
