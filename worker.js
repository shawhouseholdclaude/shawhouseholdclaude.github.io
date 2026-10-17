/* Runs the bubble reader off the main thread so the page stays responsive. */
importScripts('/reader.js');
onmessage = e => {
  const {id, w, h, data, tpl} = e.data;
  try {
    const log = {};
    const r = CrokReader.read({width: w, height: h, data}, tpl, log);
    if (!r) { postMessage({id, ok: false, log}); return; }
    const g = r.rectGray, img = new Uint8ClampedArray(g.w * g.h);
    for (let i = 0; i < img.length; i++) img[i] = g.d[i];
    postMessage({id, ok: true, answers: r.answers, align: r.align, warped: r.warped, games: r.games, rect: {w: g.w, h: g.h, d: img}, log}, [img.buffer]);
  } catch (err) { postMessage({id, ok: false, error: String(err && err.stack || err)}); }
};
