/* Crokinole scorecard bubble reader, JavaScript port of reader/reader.py (runs in the phone's browser).
   Same pipeline and thresholds:  photo -> find corner markers -> pick the right four -> straighten ->
   correct for paper that isn't flat -> read bubbles -> decide 2 / 1 / 0 / blank / unsure per round.

   Use:  CrokReader.read(img, tpl)  where img = {width, height, data: RGBA bytes (ImageData)} and tpl is
   a template (marker + bubble positions in mm, plus `base`: empty-bubble patches 64x64 for 2, 1, 0).
   Returns null (card not found: ask for a retake) or {answers, align, warped, rotation, rectified}.
   Differences from the Python version are deliberate shortcuts for speed; tests/js_parity.py checks
   both give the same answers on the real and simulated photos. */
(function (root) {
  'use strict';
  const S = 10, PAD = 50, BASE_PATCH = 64;
  const SATURATED = 252, MIN_ALIGNMENT = 0.07, TOLERANT_MIN = 0.10;
  const BIG_RATIO = 1.12, SMALL_SPREAD = 2.6;
  const WARP_REACH = 4.0, WARP_STEP = 0.25;
  const BLANK_BELOW = 0.08, SURE_ABOVE = 0.15, LEAD_NEEDED = 0.08, SECOND_MARK = 0.12;
  const THIN_MIN = 0.10, THIN_LEAD = 0.08, HALO_MIN = 0.12;
  const NANG = 28, COS = [], SIN = [];
  for (let i = 0; i < NANG; i++) { COS.push(Math.cos(2 * Math.PI * i / NANG)); SIN.push(Math.sin(2 * Math.PI * i / NANG)); }

  /* ---------------- images: {w, h, d: Float32Array or Uint8Array} ---------------- */
  const img = (w, h, T = Float32Array) => ({w, h, d: new T(w * h)});

  function toGray(rgba) {                       // same weights and rounding as OpenCV BGR2GRAY
    const {width: w, height: h, data} = rgba, g = img(w, h, Uint8Array);
    for (let i = 0, j = 0; i < w * h; i++, j += 4) g.d[i] = Math.round(0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2]);
    return g;
  }

  function areaDown(g, f) {                     // INTER_AREA by a whole factor
    const w = Math.floor(g.w / f), h = Math.floor(g.h / f), o = img(w, h, Uint8Array);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = 0; dy < f; dy++) { const r = (y * f + dy) * g.w + x * f; for (let dx = 0; dx < f; dx++) s += g.d[r + dx]; }
      o.d[y * w + x] = Math.round(s / (f * f));
    }
    return o;
  }

  function medianBlur(g, k) {                   // Huang's sliding histogram, replicated border (as OpenCV)
    const {w, h} = g, r = k >> 1, o = img(w, h, Uint8Array), half = (k * k + 1) >> 1;
    const px = (x, y) => g.d[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
    for (let y = 0; y < h; y++) {
      const hist = new Int32Array(256);
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) hist[px(dx, y + dy)]++;
      for (let x = 0; x < w; x++) {
        if (x > 0) for (let dy = -r; dy <= r; dy++) { hist[px(x - r - 1, y + dy)]--; hist[px(x + r, y + dy)]++; }
        let c = 0, v = 0; while ((c += hist[v]) < half) v++;
        o.d[y * w + x] = v;
      }
    }
    return o;
  }

  function linearUp(s, w, h) {                  // INTER_LINEAR resize, pixel-centre convention, uint8 out
    const o = img(w, h, Uint8Array), fx = s.w / w, fy = s.h / h;
    for (let y = 0; y < h; y++) {
      let sy = (y + 0.5) * fy - 0.5; sy = Math.max(0, sy); const y0 = Math.min(s.h - 1, Math.floor(sy)), y1 = Math.min(s.h - 1, y0 + 1), ay = sy - y0;
      for (let x = 0; x < w; x++) {
        let sx = (x + 0.5) * fx - 0.5; sx = Math.max(0, sx); const x0 = Math.min(s.w - 1, Math.floor(sx)), x1 = Math.min(s.w - 1, x0 + 1), ax = sx - x0;
        const v = (s.d[y0 * s.w + x0] * (1 - ax) + s.d[y0 * s.w + x1] * ax) * (1 - ay) + (s.d[y1 * s.w + x0] * (1 - ax) + s.d[y1 * s.w + x1] * ax) * ay;
        o.d[y * w + x] = Math.round(v);
      }
    }
    return o;
  }

  function normalise(g) {                       // divide out uneven lighting: paper ~1.0, ink well below
    const bg = linearUp(medianBlur(areaDown(g, 4), 31), g.w, g.h), o = img(g.w, g.h);
    for (let i = 0; i < g.d.length; i++) o.d[i] = g.d[i] / Math.max(bg.d[i], 1);
    return o;
  }

  function bilinear(m, x, y) {                  // replicated border
    if (x < 0) x = 0; else if (x > m.w - 1) x = m.w - 1;
    if (y < 0) y = 0; else if (y > m.h - 1) y = m.h - 1;
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(m.w - 1, x0 + 1), y1 = Math.min(m.h - 1, y0 + 1), ax = x - x0, ay = y - y0;
    const d = m.d, w = m.w;
    return (d[y0 * w + x0] * (1 - ax) + d[y0 * w + x1] * ax) * (1 - ay) + (d[y1 * w + x0] * (1 - ax) + d[y1 * w + x1] * ax) * ay;
  }

  function gaussKernel(sigma) {
    const n = Math.max(1, Math.round(sigma * 8 + 1) | 1), r = n >> 1, k = []; let s = 0;
    for (let i = -r; i <= r; i++) { const v = Math.exp(-i * i / (2 * sigma * sigma)); k.push(v); s += v; }
    return k.map(v => v / s);
  }
  function gaussBlur(m, sigma) {                // separable, reflect-101 border (as OpenCV)
    const k = gaussKernel(sigma), r = k.length >> 1, {w, h} = m, t = img(w, h), o = img(w, h);
    const ref = (i, n) => { if (n === 1) return 0; while (i < 0 || i >= n) i = i < 0 ? -i : 2 * n - 2 - i; return i; };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0; for (let i = -r; i <= r; i++) s += k[i + r] * m.d[y * w + ref(x + i, w)]; t.d[y * w + x] = s; }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0; for (let i = -r; i <= r; i++) s += k[i + r] * t.d[ref(y + i, h) * w + x]; o.d[y * w + x] = s; }
    return o;
  }

  /* ---------------- geometry ---------------- */
  function solve(A, b) {                        // Gaussian elimination with partial pivoting
    const n = b.length, M = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      if (Math.abs(M[c][c]) < 1e-12) return null;
      for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
    }
    return M.map((r, i) => r[n] / r[i]);
  }
  function homography(src, dst) {               // getPerspectiveTransform: 4 point pairs -> 3x3
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -x * v, -y * v]); b.push(v);
    }
    const h = solve(A, b); return h && [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  }
  function invert3(m) {
    const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
    return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
  }
  const apply = (H, x, y) => { const z = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / z, (H[3] * x + H[4] * y + H[5]) / z]; };
  const polyArea = p => { let s = 0; for (let i = 0; i < p.length; i++) { const [x0, y0] = p[i], [x1, y1] = p[(i + 1) % p.length]; s += x0 * y1 - x1 * y0; } return Math.abs(s) / 2; };

  function convexHull(pts) {
    const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], hi = [];
    for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
    return lo.slice(0, -1).concat(hi.slice(0, -1));
  }
  function minAreaRect(pts) {                   // rotating calipers over the hull: [w, h]
    const hull = convexHull(pts); if (hull.length < 3) return [0, 0];
    let best = null;
    for (let i = 0; i < hull.length; i++) {
      const [x0, y0] = hull[i], [x1, y1] = hull[(i + 1) % hull.length], L = Math.hypot(x1 - x0, y1 - y0); if (!L) continue;
      const ux = (x1 - x0) / L, uy = (y1 - y0) / L;
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const [x, y] of hull) { const a = x * ux + y * uy, b = -x * uy + y * ux; a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b); }
      const ar = (a1 - a0) * (b1 - b0); if (!best || ar < best[0]) best = [ar, a1 - a0, b1 - b0];
    }
    return [best[1], best[2]];
  }
  function isConvex(q) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = q[i], [bx, by] = q[(i + 1) % 4], [cx, cy] = q[(i + 2) % 4];
      const z = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
      if (z === 0) return false;
      if (!sign) sign = Math.sign(z); else if (Math.sign(z) !== sign) return false;
    }
    return true;
  }

  /* ---------------- markers ---------------- */
  function minMax(mask, w, h, k, useMin) {      // separable erode (min) / dilate (max), square k x k
    const r = k >> 1, t = new Uint8Array(w * h), o = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = useMin ? 1 : 0; const a = Math.max(0, x - r), b = Math.min(w - 1, x + r);
      for (let i = a; i <= b; i++) { const m = mask[y * w + i]; if (useMin ? !m : m) { v = useMin ? 0 : 1; break; } }
      t[y * w + x] = v;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = useMin ? 1 : 0; const a = Math.max(0, y - r), b = Math.min(h - 1, y + r);
      for (let i = a; i <= b; i++) { const m = t[i * w + x]; if (useMin ? !m : m) { v = useMin ? 0 : 1; break; } }
      o[y * w + x] = v;
    }
    return o;
  }

  function traceOuter(mask, w, h, sx, sy) {     // Moore-neighbour boundary trace from the top-left pixel
    const DX = [1, 1, 0, -1, -1, -1, 0, 1], DY = [0, 1, 1, 1, 0, -1, -1, -1];
    const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x];
    const pts = [[sx, sy]]; let x = sx, y = sy, dir = 7, guard = 0;
    for (;;) {
      let found = false;
      for (let i = 0; i < 8; i++) {
        const d = (dir + 6 + i) % 8 /* start looking back-left of the last move */, nx = x + DX[d], ny = y + DY[d];
        if (on(nx, ny)) { x = nx; y = ny; dir = d; found = true; break; }
      }
      if (!found || (x === sx && y === sy) || ++guard > 200000) break;
      pts.push([x, y]);
    }
    return pts;
  }

  function markerCandidates(norm) {
    const {w: W, h: H} = norm, k = Math.max(3, Math.round(0.005 * W) | 1), found = [];
    const aMin = (0.009 * W) ** 2, aMax = (0.05 * W) ** 2;
    for (const level of [0.30, 0.42, 0.55]) {
      let mask = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i++) mask[i] = norm.d[i] < level ? 1 : 0;
      mask = minMax(minMax(mask, W, H, k, true), W, H, k, false);        // opening
      const lab = new Int32Array(W * H); let next = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x; if (!mask[i] || lab[i]) continue;
        next++; let n = 0, stack = [i]; lab[i] = next;
        while (stack.length) {                                             // 4-connected flood fill (count only)
          const j = stack.pop(); n++; const jx = j % W, jy = (j / W) | 0;
          if (jx > 0 && mask[j - 1] && !lab[j - 1]) { lab[j - 1] = next; stack.push(j - 1); }
          if (jx < W - 1 && mask[j + 1] && !lab[j + 1]) { lab[j + 1] = next; stack.push(j + 1); }
          if (jy > 0 && mask[j - W] && !lab[j - W]) { lab[j - W] = next; stack.push(j - W); }
          if (jy < H - 1 && mask[j + W] && !lab[j + W]) { lab[j + W] = next; stack.push(j + W); }
        }
        if (n < aMin * 0.8 || n > aMax * 1.3) continue;                  // clearly the wrong size: skip tracing
        const c = traceOuter(mask, W, H, x, y);
        const a = polyArea(c);
        if (a < aMin || a > aMax) continue;
        const [rw, rh] = minAreaRect(c);
        if (Math.min(rw, rh) < 0.006 * W) continue;
        const ar = Math.max(rw, rh) / Math.min(rw, rh), fill = a / (rw * rh);
        if (ar < 1.8 && fill > 0.84) {
          let sx = 0, sy = 0, s2 = 0;                                      // polygon centroid
          for (let i = 0; i < c.length; i++) { const [x0, y0] = c[i], [x1, y1] = c[(i + 1) % c.length], cr = x0 * y1 - x1 * y0; sx += (x0 + x1) * cr; sy += (y0 + y1) * cr; s2 += cr; }
          found.push({c: [sx / (3 * s2), sy / (3 * s2)], area: a, fill, cnt: c});
        }
      }
    }
    found.sort((a, b) => b.fill - a.fill);
    const out = [];
    for (const f of found) if (out.every(o => Math.hypot(f.c[0] - o.c[0], f.c[1] - o.c[1]) > 0.012 * W)) out.push(f);
    return out;
  }

  /* ---------------- template-space sampling ---------------- */
  const tplQuad = t => [t.markers.tl, t.markers.tr, t.markers.br, t.markers.bl].map(([x, y]) => [x * S + PAD, y * S + PAD]);
  const rectSize = t => [Math.floor(t.markers.tr[0] * S + 2 * PAD), Math.floor(t.markers.bl[1] * S + 2 * PAD)];

  /* sample the photo at straightened coordinates without building the whole straightened image */
  function viaH(photo, Hinv) { return (x, y) => { const [u, v] = apply(Hinv, x, y); return bilinear(photo, u, v); }; }
  function viaImg(m) { return (x, y) => m.d[Math.min(m.h - 1, Math.max(0, Math.round(y))) * m.w + Math.min(m.w - 1, Math.max(0, Math.round(x)))]; }

  function ringContrast(sample, cx, cy, r) {
    let ring = 0, out = 0;
    for (let i = 0; i < NANG; i++) { ring += sample(cx + (r - 1.2) * COS[i], cy + (r - 1.2) * SIN[i]); out += sample(cx + (r + 4) * COS[i], cy + (r + 4) * SIN[i]); }
    return (out - ring) / NANG;
  }
  function alignmentScore(sample, tpl) {
    let s = 0, n = 0;
    for (let i = 0; i < tpl.bubbles.length; i += 3) { const b = tpl.bubbles[i]; s += ringContrast(sample, b.cx * S + PAD, b.cy * S + PAD, b.d / 2 * S); n++; }
    return s / n;
  }

  function cells(tpl) {
    const m = new Map();
    for (const b of tpl.bubbles) { const k = b.game + '/' + b.round; if (!m.has(k)) m.set(k, []); m.get(k).push(b); }
    return [...m.values()];
  }
  function cellOffsets(sample, cs, reach = WARP_REACH, step = WARP_STEP) {
    const offs = []; for (let v = -reach; v <= reach + 1e-9; v += step) offs.push(v * S);
    const n = offs.length, out = [];
    for (const cell of cs) {
      const score = new Float64Array(n * n);
      for (const b of cell) {
        const cx = b.cx * S + PAD, cy = b.cy * S + PAD, r = b.d / 2 * S;
        for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
          const X = cx + offs[ix], Y = cy + offs[iy]; let ring = 0, outside = 0, gap = 0;
          for (let a = 0; a < NANG; a++) {
            ring += sample(X + (r - 1.2) * COS[a], Y + (r - 1.2) * SIN[a]);
            outside += sample(X + (r + 4) * COS[a], Y + (r + 4) * SIN[a]);
            gap += sample(X + (r + 1.6) * COS[a], Y + (r + 1.6) * SIN[a]);
          }
          score[iy * n + ix] += ((outside - ring) + 0.5 * (gap - ring)) / NANG;
        }
      }
      let k = 0; for (let i = 1; i < n * n; i++) if (score[i] > score[k]) k = i;
      out.push({x: cell.reduce((s, b) => s + b.cx, 0) / cell.length * S + PAD, y: cell.reduce((s, b) => s + b.cy, 0) / cell.length * S + PAD,
                dx: offs[k % n], dy: offs[(k / n) | 0], score: score[k] / cell.length});
    }
    return out;
  }

  const polyTerms = (x, y, w, h) => { const u = (x - w / 2) / w, v = (y - h / 2) / h; return [1, u, v, u * u, u * v, v * v, u * u * v, u * v * v]; };
  function lstsq(rows, ys) {                    // normal equations (8 terms, well conditioned on [-0.5, 0.5])
    const n = rows[0].length, A = Array.from({length: n}, () => new Array(n).fill(0)), b = new Array(n).fill(0);
    rows.forEach((r, k) => { for (let i = 0; i < n; i++) { b[i] += r[i] * ys[k]; for (let j = 0; j < n; j++) A[i][j] += r[i] * r[j]; } });
    for (let i = 0; i < n; i++) A[i][i] += 1e-9;
    return solve(A, b);
  }
  const median = a => { const s = Float64Array.from(a).sort(); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  function fitWarp(rectNorm, tpl, log) {
    const {w, h} = rectNorm;
    const offs = cellOffsets(viaImg(gaussBlur(rectNorm, 1.0)), cells(tpl));
    const good = offs.filter(o => o.score > 0.06);
    if (good.length < 12) return null;
    const T = good.map(o => polyTerms(o.x, o.y, w, h));
    let keep = good.map(() => true), cx, cy, res;
    for (let it = 0; it < 4; it++) {
      const R = T.filter((_, i) => keep[i]), G = good.filter((_, i) => keep[i]);
      cx = lstsq(R, G.map(o => o.dx)); cy = lstsq(R, G.map(o => o.dy));
      res = good.map((o, i) => Math.hypot(T[i].reduce((s, t, j) => s + t * cx[j], 0) - o.dx, T[i].reduce((s, t, j) => s + t * cy[j], 0) - o.dy));
      const lim = Math.max(6, 2.5 * median(res.filter((_, i) => keep[i])));
      const nk = res.map(r => r < lim);
      if (nk.filter(Boolean).length < 12 || nk.every((v, i) => v === keep[i])) break;
      keep = nk;
    }
    const spread = median(good.filter((_, i) => keep[i]).map(o => Math.hypot(o.dx, o.dy)));
    if (log) log.warp = {groups_used: keep.filter(Boolean).length, of: offs.length, median_shift_mm: +(spread / S).toFixed(2)};
    if (spread < 0.2 * S) return null;
    return (x, y) => { const t = polyTerms(x, y, w, h); let dx = 0, dy = 0; for (let j = 0; j < 8; j++) { dx += t[j] * cx[j]; dy += t[j] * cy[j]; } return [x + dx, y + dy]; };
  }

  /* straightened image built from the photo; `pre` maps straightened -> pre-warp straightened coords */
  function rectifyImage(photo, Hinv, tpl, pre) {
    const [w, h] = rectSize(tpl), o = img(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let X = x, Y = y; if (pre) [X, Y] = pre(x, y);
      const [u, v] = apply(Hinv, X, Y); o.d[y * w + x] = bilinear(photo, u, v);
    }
    return o;
  }

  function findCard(norm, tpl, log) {
    const cands = markerCandidates(norm);
    if (log) log.markers = cands.length;
    const want = tpl.markers.tr[0] / tpl.markers.bl[1], dst = tplQuad(tpl);
    let best = null; const plausible = [];
    const n = cands.length;
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++) for (let d = c + 1; d < n; d++) {
      const combo = [cands[a], cands[b], cands[c], cands[d]];
      const ctr = [0, 1].map(k => combo.reduce((s, m) => s + m.c[k], 0) / 4);
      const order = [0, 1, 2, 3].sort((i, j) => Math.atan2(combo[i].c[1] - ctr[1], combo[i].c[0] - ctr[0]) - Math.atan2(combo[j].c[1] - ctr[1], combo[j].c[0] - ctr[0]));
      const oriented = tpl.orientation_marker === 'tl_large';
      let tries;
      if (oriented) tries = [0, 1, 2, 3].map(s => [0, 1, 2, 3].map(i => combo[order[(s + i) % 4]]));
      else {                                                               // old cards: no orientation marker
        const sm = combo.map(m => m.c[0] + m.c[1]), df = combo.map(m => m.c[1] - m.c[0]);
        const am = a => a.indexOf(Math.min(...a)), aM = a => a.indexOf(Math.max(...a));
        const q = [combo[am(sm)].c, combo[am(df)].c, combo[aM(sm)].c, combo[aM(df)].c];
        tries = [q.map(p => combo.reduce((x, m) => Math.hypot(m.c[0] - p[0], m.c[1] - p[1]) < Math.hypot(x.c[0] - p[0], x.c[1] - p[1]) ? m : x))];
      }
      for (const ordered of tries) {
        const quad = ordered.map(m => m.c);
        if (!isConvex(quad)) continue;
        const D = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
        const w = (D(quad[0], quad[1]) + D(quad[3], quad[2])) / 2, h = (D(quad[0], quad[3]) + D(quad[1], quad[2])) / 2;
        if (h < 1 || !((w / h) / want > 0.65 && (w / h) / want < 1.5)) continue;
        const H = homography(quad, dst); if (!H) continue;
        const areas = ordered.map(m => polyArea(m.cnt.map(([x, y]) => apply(H, x, y))) / (S * S)), small = areas.slice(1);
        if (oriented && !(areas[0] >= BIG_RATIO * Math.max(...small) && Math.max(...small) <= SMALL_SPREAD * Math.min(...small))) continue;
        const Hinv = invert3(H), score = alignmentScore(viaH(norm, Hinv), tpl);
        const cand = {quad, H, Hinv, score}; plausible.push(cand);
        if (!best || score > best.score) best = cand;
      }
    }
    if (best && best.score >= MIN_ALIGNMENT) return best;
    let tol = null;                                                        // curled paper: allow each group to sit a few mm off
    const some = cells(tpl).filter((_, i) => i % 3 === 0);
    for (const c of plausible) {
      const t = median(cellOffsets(viaH(norm, c.Hinv), some, WARP_REACH, 0.5).map(o => o.score));
      if (!tol || t > tol.tol) tol = {...c, tol: t};
    }
    if (tol && tol.tol >= TOLERANT_MIN) return tol;
    if (log) { log.rejected_alignment = best ? best.score : null; log.rejected_tolerant = tol ? tol.tol : null; }
    return null;
  }

  /* ---------------- reading the bubbles ---------------- */
  function patchAround(m, cx, cy, P) {          // getRectSubPix
    const o = img(P, P), c = (P - 1) / 2;
    for (let y = 0; y < P; y++) for (let x = 0; x < P; x++) o.d[y * P + x] = bilinear(m, cx - c + x, cy - c + y);
    return o;
  }
  const pct = (a, q) => { const s = Float64Array.from(a).sort(); const p = (s.length - 1) * q, i = Math.floor(p); return i + 1 < s.length ? s[i] + (s[i + 1] - s[i]) * (p - i) : s[i]; };

  function readBubbles(rectNorm, rectGray, tpl, baseBlur) {
    const sN = viaImg(rectNorm), res = [], P = BASE_PATCH, pc = (P - 1) / 2;
    for (const b of tpl.bubbles) {
      const r = b.d / 2 * S; let cx = b.cx * S + PAD, cy = b.cy * S + PAD;
      let best = -9, bc = [cx, cy];
      for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) { const c = ringContrast(sN, cx + dx, cy + dy, r); if (c > best) { best = c; bc = [cx + dx, cy + dy]; } }
      [cx, cy] = bc;
      const gin = [], gout = [];
      for (let y = Math.trunc(cy - r - 10); y < Math.trunc(cy + r + 11); y++) for (let x = Math.trunc(cx - r - 10); x < Math.trunc(cx + r + 11); x++) {
        if (x < 0 || y < 0 || x >= rectGray.w || y >= rectGray.h) continue;
        const d2 = (x - cx) ** 2 + (y - cy) ** 2, v = rectGray.d[y * rectGray.w + x];
        if (d2 <= (r - 3.5) ** 2) gin.push(v); else if (d2 >= (r + 3) ** 2 && d2 <= (r + 9) ** 2) gout.push(v);
      }
      const paper = median(gout), medIn = median(gin);
      const patch = patchAround(rectGray, cx, cy, P), ring = [];
      for (let y = 0; y < P; y++) for (let x = 0; x < P; x++) { const d2 = (x - pc) ** 2 + (y - pc) ** 2; if (d2 >= (r + 3) ** 2 && d2 <= (r + 9) ** 2) ring.push(patch.d[y * P + x]); }
      const pp = Math.max(median(ring), 1);
      for (let i = 0; i < P * P; i++) patch.d[i] /= pp;
      const rel = gaussBlur(patch, 2.0), ref = baseBlur[b.value];
      let inN = 0, inInk = 0, haloN = 0, haloInk = 0;
      for (let y = 0; y < P; y++) for (let x = 0; x < P; x++) {
        const d2 = (x - pc) ** 2 + (y - pc) ** 2, e = Math.min(1, Math.max(0, ref.d[y * P + x] - rel.d[y * P + x]));
        if (d2 <= (r - 3.5) ** 2) { inN++; if (e > 0.12) inInk++; }
        else if (d2 >= (r + 2.5) ** 2 && d2 <= (r + 12) ** 2) { haloN++; if (e > 0.15) haloInk++; }
      }
      res.push({game: b.game, round: b.round, value: b.value, px: cx, py: cy, paper, sat: paper >= SATURATED,
                rel_med: medIn / Math.max(paper, 1), ink_frac: inInk / inN, halo: haloInk / haloN});
    }
    return res;
  }

  function decide(bubbles, games) {
    const out = {};
    for (let g = 1; g <= games; g++) {
      out[g] = [];
      for (let r = 1; r <= 4; r++) {
        const three = bubbles.filter(b => b.game === g && b.round === r);
        if (!three.length) { out[g].push({answer: null, guess: null, scores: []}); continue; }
        const dark = three.map(b => 1 - b.rel_med), ink = three.map(b => b.ink_frac);
        const order = [0, 1, 2].sort((i, j) => dark[j] - dark[i]), iorder = [0, 1, 2].sort((i, j) => ink[j] - ink[i]);
        const top = dark[order[0]], second = dark[order[1]];
        let ans, guess = null;
        if (three.some(b => b.sat)) ans = '?';
        else if (top < BLANK_BELOW) {
          if (ink[iorder[0]] >= THIN_MIN && ink[iorder[0]] - ink[iorder[1]] >= THIN_LEAD) { ans = '?'; guess = three[iorder[0]].value; }
          else if (Math.max(...three.map(b => b.halo)) >= HALO_MIN) { ans = '?'; guess = three.reduce((a, b) => b.halo > a.halo ? b : a).value; }
          else ans = null;
        } else if (second >= SECOND_MARK) ans = 'MULTI';
        else if (top < SURE_ABOVE || top - second < LEAD_NEEDED) { ans = '?'; guess = three[order[0]].value; }
        else ans = three[order[0]].value;
        out[g].push({answer: ans, guess, scores: dark.map(v => +v.toFixed(2)), ink: ink.map(v => +v.toFixed(2)), halo: three.map(b => +b.halo.toFixed(2))});
      }
    }
    return out;
  }

  /* ---------------- the whole thing ---------------- */
  function read(rgba, tpl, log) {
    const t0 = Date.now();
    const gray = toGray(rgba);
    const norm = normalise(gray);
    const card = findCard(norm, tpl, log);
    if (!card) return null;
    let rectNorm = rectifyImage(norm, card.Hinv, tpl), pre = null, score = card.score;
    const warp = fitWarp(rectNorm, tpl, log);
    if (warp) {
      const sc = alignmentScore((x, y) => { const [X, Y] = warp(x, y); const [u, v] = apply(card.Hinv, X, Y); return bilinear(norm, u, v); }, tpl);
      if (sc > score) { score = sc; pre = warp; rectNorm = rectifyImage(norm, card.Hinv, tpl, pre); }
    }
    if (score < MIN_ALIGNMENT) { if (log) log.rejected_after_warp = score; return null; }
    const grayF = {w: gray.w, h: gray.h, d: Float32Array.from(gray.d)};
    const rectGray = rectifyImage(grayF, card.Hinv, tpl, pre);
    if (!tpl._baseBlur) tpl._baseBlur = {};
    for (const v of [0, 1, 2]) if (!tpl._baseBlur[v]) tpl._baseBlur[v] = gaussBlur({w: BASE_PATCH, h: BASE_PATCH, d: Float32Array.from(tpl.base[v])}, 2.0);
    const bubbles = readBubbles(rectNorm, rectGray, tpl, tpl._baseBlur);
    const games = Math.max(...tpl.bubbles.map(b => b.game));
    const q = card.quad;
    if (log) log.ms = Date.now() - t0;
    return {answers: decide(bubbles, games), align: score, warped: !!pre, rotation: Math.atan2(q[1][1] - q[0][1], q[1][0] - q[0][0]) * 180 / Math.PI,
            rectGray, bubbles, games};
  }

  root.CrokReader = {read, normalise, markerCandidates, toGray};
  if (typeof module !== 'undefined') module.exports = root.CrokReader;
})(typeof window !== 'undefined' ? window : globalThis);
