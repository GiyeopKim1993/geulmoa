// Run generation off the UI thread so writing and progress remain responsive.
const { buildScreenFont } = require('../src/engine');
if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = { from: (u8) => new Uint8Array(u8) };
}
self.onmessage = async ({ data }) => {
  try {
    const out = await buildScreenFont(data.samples || [], data.name,
      (message) => self.postMessage({ type: 'progress', message }));
    const copy = out.ttf.slice();
    const { ttf, ...meta } = out;
    self.postMessage({ type: 'done', ...meta, ttf: copy.buffer }, [copy.buffer]);
  } catch (error) {
    self.postMessage({ type: 'error', message: error && error.message ? error.message : '폰트를 만드는 중 오류가 발생했어요.' });
  }
};
