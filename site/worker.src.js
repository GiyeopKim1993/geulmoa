// Run generation off the UI thread so writing and progress remain responsive.
const { buildScreenFont } = require('../src/engine');
const { supportsVectorRaster } = require('../src/vector-correction');
if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = { from: (u8) => new Uint8Array(u8) };
}
self.onmessage = async ({ data }) => {
  try {
    // Some browsers can start a Worker but cannot draw to a canvas there.
    // Ask the page to use its cooperative DOM-canvas engine before starting
    // the job; do not silently produce an uncorrected font or retry a job.
    if (data.design?.vectorCorrection !== false && (data.samples || []).some((s) => s.strokes?.length) && !supportsVectorRaster()) {
      self.postMessage({ type: 'compat-required' }); return;
    }
    const out = await buildScreenFont(data.samples || [], data.name,
      (message) => self.postMessage({ type: 'progress', message }), data.design || {});
    const copy = out.ttf.slice();
    const { ttf, ...meta } = out;
    self.postMessage({ type: 'done', ...meta, ttf: copy.buffer }, [copy.buffer]);
  } catch (error) {
    self.postMessage({ type: 'error', message: error && error.message ? error.message : '폰트를 만드는 중 오류가 발생했어요.' });
  }
};
