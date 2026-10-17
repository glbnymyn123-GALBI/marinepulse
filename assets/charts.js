/* MarinePulse charts: small SVG builders. Colours are CSS variables, so a
   theme switch restyles every chart without re-rendering. Every chart also
   has a tooltip on hover/focus; values are always available in a table too. */
(function (root) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs = {}, parent) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
    if (parent) parent.appendChild(n);
    return n;
  }
  function svg(container, w, h, label) {
    container.innerHTML = '';
    const s = el('svg', { class: 'chart', viewBox: `0 0 ${w} ${h}`, width: w, height: h, role: 'img', 'aria-label': label });
    container.appendChild(s);
    return s;
  }
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---- tooltip ---------------------------------------------------------------
  const tip = {
    node: null,
    show(html, x, y) {
      this.node = this.node || document.getElementById('tooltip');
      const t = this.node;
      t.innerHTML = html;
      t.classList.add('show');
      const r = t.getBoundingClientRect();
      let left = x + 14, top = y + 14;
      if (left + r.width > innerWidth - 8) left = x - r.width - 14;
      if (top + r.height > innerHeight - 8) top = y - r.height - 14;
      t.style.left = Math.max(8, left) + 'px';
      t.style.top = Math.max(8, top) + 'px';
    },
    hide() { if (this.node) this.node.classList.remove('show'); },
  };
  function bindTip(node, html) {
    node.setAttribute('tabindex', '0');
    node.addEventListener('pointermove', e => tip.show(typeof html === 'function' ? html() : html, e.clientX, e.clientY));
    node.addEventListener('pointerleave', () => tip.hide());
    node.addEventListener('focus', () => {
      const r = node.getBoundingClientRect();
      tip.show(typeof html === 'function' ? html() : html, r.left + r.width / 2, r.top);
    });
    node.addEventListener('blur', () => tip.hide());
  }
  function tipRows(title, rows) {
    return `<div class="tt-title">${esc(title)}</div>` + rows.map(([k, v, color]) =>
      `<div class="tt-row"><span>${color ? `<i class="tt-key" style="background:${color}"></i>` : ''}${esc(k)}</span><span>${esc(v)}</span></div>`).join('');
  }

  function niceMax(v) {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }
  function ticks(max, count = 4) {
    const step = niceMax(max / count);
    const out = [];
    for (let v = 0; v <= max + 1e-9; v += step) out.push(+v.toFixed(6));
    return out;
  }

  /** Rounded data-end, square at the baseline. */
  function barPath(x, y, w, h, r = 3) {
    if (h <= 0) return '';
    r = Math.min(r, h, w / 2);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }
  function hBarPath(x, y, w, h, r = 3) {
    if (w <= 0) return '';
    r = Math.min(r, w, h / 2);
    return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
  }

  // ---- stacked columns (reports per year) ----------------------------------------
  /* data: [{ label, total, partial, note, segments: [{ key, value, color }] }] */
  function columns(container, data, opts = {}) {
    const w = Math.max(240, container.clientWidth || 400), h = opts.height || 150;
    const m = { t: 10, r: 4, b: 22, l: 28 };
    const s = svg(container, w, h, opts.label || 'Column chart');
    const max = niceMax(Math.max(1, ...data.map(d => d.total)));
    const iw = w - m.l - m.r, ih = h - m.t - m.b;
    const band = iw / data.length, bw = Math.min(22, band * 0.68);
    const y = v => m.t + ih - v / max * ih;
    ticks(max, 3).forEach(t => {
      el('line', { class: t === 0 ? 'axis' : 'grid', x1: m.l, x2: w - m.r, y1: y(t), y2: y(t) }, s);
      el('text', { class: 'tick-num', x: m.l - 6, y: y(t) + 3.5, 'text-anchor': 'end' }, s).textContent = t;
    });
    if (opts.partialPattern !== false) {
      const defs = el('defs', {}, s);
      const pat = el('pattern', { id: 'hatch' + (opts.id || ''), width: 4, height: 4, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
      el('rect', { width: 4, height: 4, style: 'fill:var(--surface)' }, pat);
      el('line', { x1: 0, y1: 0, x2: 0, y2: 4, style: 'stroke:var(--ink-4);stroke-width:1.6' }, pat);
    }
    const every = Math.ceil(data.length / Math.floor(iw / 34));
    data.forEach((d, i) => {
      const g = el('g', { class: 'col' }, s);
      const cx = m.l + band * i + band / 2;
      el('rect', { class: 'band', x: m.l + band * i, y: m.t, width: band, height: ih, rx: 3 }, g);
      let acc = 0;
      const live = d.segments.filter(sg => sg.value > 0);
      live.forEach((sg, k) => {
        const top = y(acc + sg.value), bottom = y(acc);
        const gap = k > 0 ? 1 : 0;   // 2px surface gap split across the joint
        const hh = bottom - top - gap;
        const isTop = k === live.length - 1;
        const fill = d.partial ? `url(#hatch${opts.id || ''})` : sg.color;
        const path = isTop ? barPath(cx - bw / 2, top, bw, hh) : `M${cx - bw / 2},${top}h${bw}v${hh}h${-bw}Z`;
        el('path', { d: path, style: d.partial ? `fill:${fill};stroke:${sg.color};stroke-width:1` : `fill:${sg.color}` }, g);
        acc += sg.value;
      });
      if (i % every === 0 || i === data.length - 1)
        el('text', { x: cx, y: h - 6, 'text-anchor': 'middle', class: 'tick-num' }, s).textContent = d.label;
      const hit = el('rect', { class: 'hit', x: m.l + band * i, y: m.t, width: band, height: ih + m.b }, g);
      bindTip(hit, tipRows(d.label + (d.note ? ` (${d.note})` : ''), [
        ...d.segments.map(sg => [sg.key, sg.value, sg.color]),
        ['Total', d.total],
      ]));
    });
    if (opts.endLabel) {
      const last = data[data.length - 1];
      el('text', { x: w - m.r, y: m.t + 2, 'text-anchor': 'end', class: 'label-strong' }, s).textContent = opts.endLabel;
      void last;
    }
    return s;
  }

  // ---- dot + confidence interval rows --------------------------------------------
  /* rows: [{ label, value, low, high, tip }], opts: { ref, refLabel, max, color } */
  function ciRows(container, rows, opts = {}) {
    const w = Math.max(200, container.clientWidth || 260);
    const rowH = opts.rowH || 26, m = { t: 6, r: 12, b: 22, l: opts.labelW || 78 };
    const h = m.t + rows.length * rowH + m.b;
    const s = svg(container, w, h, opts.label || 'Estimates with 95% intervals');
    const max = opts.max || niceMax(Math.max(...rows.map(r => r.high || r.value || 0), opts.ref || 0, 0.01));
    const x = v => m.l + Math.max(0, Math.min(1, v / max)) * (w - m.l - m.r);
    const fmt = opts.format || (v => Math.round(v * 100) + '%');
    ticks(max, opts.ticks || 2).forEach(t => {
      el('line', { class: t === 0 ? 'axis' : 'grid', x1: x(t), x2: x(t), y1: m.t, y2: h - m.b }, s);
      el('text', { class: 'tick-num', x: x(t), y: h - 6, 'text-anchor': t === 0 ? 'start' : 'middle' }, s).textContent = fmt(t);
    });
    if (opts.ref != null) {
      el('line', { x1: x(opts.ref), x2: x(opts.ref), y1: m.t - 2, y2: h - m.b, style: 'stroke:var(--ink-2);stroke-width:1.5' }, s);
    }
    rows.forEach((r, i) => {
      const cy = m.t + i * rowH + rowH / 2;
      const g = el('g', {}, s);
      el('text', { x: 0, y: cy + 4, class: r.strong ? 'label-strong' : '' }, g).textContent = r.label;
      if (Number.isFinite(r.low)) {
        el('line', { x1: x(r.low), x2: x(r.high), y1: cy, y2: cy, style: `stroke:${opts.color || 'var(--ink-2)'};stroke-width:2;stroke-linecap:round;opacity:.55` }, g);
      }
      el('circle', { cx: x(r.value), cy, r: 4.5, style: `fill:${opts.color || 'var(--ink)'};stroke:var(--surface);stroke-width:2` }, g);
      const hit = el('rect', { class: 'hit', x: 0, y: cy - rowH / 2, width: w, height: rowH }, g);
      if (r.tip) bindTip(hit, r.tip);
    });
    return s;
  }

  // ---- strip plot of group sizes (log scale) ------------------------------------------
  /* groups: [{ label, values, mean, low, high, median, n }] */
  function strip(container, groups, opts = {}) {
    const w = Math.max(260, container.clientWidth || 520);
    const rowH = 62, m = { t: 6, r: 16, b: 40, l: opts.labelW || 150 };
    const h = m.t + groups.length * rowH + m.b;
    const s = svg(container, w, h, opts.label || 'Group sizes');
    const maxV = Math.max(...groups.flatMap(g => g.values), 10);
    const lmax = Math.log(niceMax(maxV));
    const x = v => m.l + Math.log(Math.max(1, v)) / lmax * (w - m.l - m.r);
    [1, 2, 3, 5, 10, 20, 50, 100].filter(t => Math.log(t) <= lmax + 1e-9).forEach(t => {
      el('line', { class: t === 1 ? 'axis' : 'grid', x1: x(t), x2: x(t), y1: m.t, y2: h - m.b }, s);
      el('text', { class: 'tick-num', x: x(t), y: h - m.b + 15, 'text-anchor': 'middle' }, s).textContent = t;
    });
    el('text', { x: m.l + (w - m.l - m.r) / 2, y: h - 6, 'text-anchor': 'middle' }, s).textContent = opts.axisLabel || 'Animals per report (log scale)';
    let seed = 7;
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    groups.forEach((g, i) => {
      const top = m.t + i * rowH;
      const dotsY = top + 20, statY = top + 44;
      if (i > 0) el('line', { class: 'grid', x1: 0, x2: w - m.r, y1: top, y2: top }, s);
      el('text', { x: 0, y: top + 24, class: 'label-strong' }, s).textContent = g.label;
      el('text', { x: 0, y: top + 40, class: 'tick-num' }, s).textContent = `n = ${g.n}`;
      // One dot per report, jittered vertically so ties stay visible.
      g.values.forEach(v => {
        el('circle', { cx: x(v) + (rand() - 0.5) * 3, cy: dotsY + (rand() - 0.5) * 22, r: 2.7,
          style: `fill:${opts.color || 'var(--t-dolphin)'};opacity:.45` }, s);
      });
      // Summary row: mean with 95% CI (line + hollow dot) and median (tick).
      if (Number.isFinite(g.low)) {
        el('line', { x1: x(Math.max(1, g.low)), x2: x(g.high), y1: statY, y2: statY, style: 'stroke:var(--ink);stroke-width:2;stroke-linecap:round' }, s);
      }
      el('line', { x1: x(g.median), x2: x(g.median), y1: statY - 7, y2: statY + 7, style: 'stroke:var(--ink);stroke-width:2.5;stroke-linecap:round' }, s);
      el('circle', { cx: x(g.mean), cy: statY, r: 4.5, style: 'fill:var(--surface);stroke:var(--ink);stroke-width:2' }, s);
      const hit = el('rect', { class: 'hit', x: 0, y: top, width: w, height: rowH }, s);
      bindTip(hit, tipRows(g.label, [
        ['Reports', g.n], ['Mean', g.mean.toFixed(2)],
        ['95% CI of mean', Number.isFinite(g.low) ? `${g.low.toFixed(2)} to ${g.high.toFixed(2)}` : 'n/a'],
        ['Median', g.median], ['Solitary animals', Math.round(g.shareSolitary * 100) + '%'],
      ]));
    });
    return s;
  }

  // ---- small trend columns (one country) ---------------------------------------------
  function miniColumns(container, values, labels, opts = {}) {
    const w = Math.max(160, container.clientWidth || 220), h = opts.height || 92;
    const m = { t: 8, r: 2, b: 18, l: 22 };
    const s = svg(container, w, h, opts.label || 'Reports per year');
    const max = opts.max || niceMax(Math.max(1, ...values));
    const iw = w - m.l - m.r, ih = h - m.t - m.b;
    const band = iw / values.length, bw = Math.min(14, band * 0.7);
    const y = v => m.t + ih - v / max * ih;
    ticks(max, 2).forEach(t => {
      el('line', { class: t === 0 ? 'axis' : 'grid', x1: m.l, x2: w - m.r, y1: y(t), y2: y(t) }, s);
      el('text', { class: 'tick-num', x: m.l - 5, y: y(t) + 3.5, 'text-anchor': 'end' }, s).textContent = t;
    });
    values.forEach((v, i) => {
      const cx = m.l + band * i + band / 2;
      el('path', { d: barPath(cx - bw / 2, y(v), bw, ih + m.t - y(v), 2), style: `fill:${opts.color || 'var(--ink-2)'}` }, s);
      if (i === 0 || i === values.length - 1)
        el('text', { x: cx, y: h - 5, 'text-anchor': i === 0 ? 'start' : 'end', class: 'tick-num' }, s).textContent = labels[i];
      const hit = el('rect', { class: 'hit', x: m.l + band * i, y: m.t, width: band, height: ih }, s);
      bindTip(hit, tipRows(String(labels[i]), [['Reports', v]]));
    });
    if (opts.fitted) {
      const pts = opts.fitted.map((v, i) => `${m.l + band * i + band / 2},${y(v)}`).join(' ');
      el('polyline', { points: pts, style: 'fill:none;stroke:var(--ink);stroke-width:2;stroke-linejoin:round;stroke-linecap:round' }, s);
    }
    return s;
  }

  // ---- monthly columns with a uniform reference line ------------------------------------
  function months(container, counts, expected, opts = {}) {
    const names = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
    const full = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const w = Math.max(200, container.clientWidth || 300), h = opts.height || 130;
    const m = { t: 8, r: 2, b: 20, l: 24 };
    const s = svg(container, w, h, opts.label || 'Reports by month');
    const max = niceMax(Math.max(...counts, ...expected));
    const iw = w - m.l - m.r, ih = h - m.t - m.b;
    const band = iw / 12, bw = Math.min(16, band * 0.66);
    const y = v => m.t + ih - v / max * ih;
    ticks(max, 2).forEach(t => {
      el('line', { class: t === 0 ? 'axis' : 'grid', x1: m.l, x2: w - m.r, y1: y(t), y2: y(t) }, s);
      el('text', { class: 'tick-num', x: m.l - 5, y: y(t) + 3.5, 'text-anchor': 'end' }, s).textContent = t;
    });
    counts.forEach((v, i) => {
      const cx = m.l + band * i + band / 2;
      const summer = i >= 5 && i <= 7;
      el('path', { d: barPath(cx - bw / 2, y(v), bw, ih + m.t - y(v), 2), style: `fill:${summer ? 'var(--ink)' : 'var(--ink-4)'}` }, s);
      el('text', { x: cx, y: h - 6, 'text-anchor': 'middle', class: 'tick-num' }, s).textContent = names[i];
      const hit = el('rect', { class: 'hit', x: m.l + band * i, y: m.t, width: band, height: ih + m.b }, s);
      bindTip(hit, tipRows(full[i], [['Reports', v], ['If spread evenly', expected[i].toFixed(1)]]));
    });
    const pts = expected.map((v, i) => `${m.l + band * i + 2},${y(v)} ${m.l + band * (i + 1) - 2},${y(v)}`).join(' ');
    el('polyline', { points: pts, style: 'fill:none;stroke:var(--s-stranded);stroke-width:1.5' }, s);
    return s;
  }

  // ---- map site glyph ------------------------------------------------------------------
  /* parts: [{ value, color }] -> SVG markup string for a Leaflet divIcon. */
  const glyphRadius = n => (n <= 1 ? 6 : Math.min(26, 6.5 + 2.7 * Math.sqrt(n)));
  function siteGlyph(parts, n, selected, isCluster) {
    const r = glyphRadius(n);
    const pad = isCluster ? 6 : 3, size = Math.ceil(2 * r + 2 * pad), c = size / 2;
    const ring = selected ? 'var(--ink)' : 'var(--surface)';
    const ringW = selected ? 2.5 : 2;
    let body = '';
    const total = parts.reduce((s, p) => s + p.value, 0);
    // A cluster of several sites gets a faint outer halo.
    if (isCluster) body += `<circle cx="${c}" cy="${c}" r="${r + 4}" style="fill:var(--surface);fill-opacity:.55;stroke:var(--ink-3);stroke-width:1;stroke-opacity:.6"/>`;
    if (n <= 1) {
      body = `<circle cx="${c}" cy="${c}" r="${r}" style="fill:${parts[0].color};stroke:${ring};stroke-width:${ringW}"/>`;
    } else {
      // Ring split by species type (2px surface gaps), count in the centre.
      const inner = r * 0.58;
      body += `<circle cx="${c}" cy="${c}" r="${r + ringW / 2}" style="fill:${ring}"/>`;
      body += `<circle cx="${c}" cy="${c}" r="${inner}" style="fill:var(--surface)"/>`;
      if (parts.length === 1) {
        const mid = (r + inner) / 2;
        body += `<circle cx="${c}" cy="${c}" r="${mid}" style="fill:none;stroke:${parts[0].color};stroke-width:${r - inner}"/>`;
      } else {
        let a0 = -Math.PI / 2;
        const P = (rad, a) => `${(c + rad * Math.cos(a)).toFixed(2)},${(c + rad * Math.sin(a)).toFixed(2)}`;
        parts.forEach(p => {
          const a1 = a0 + p.value / total * Math.PI * 2;
          const gap = 1 / r;                      // ~1px each side
          const s0 = a0 + gap, s1 = a1 - gap;
          const large = s1 - s0 > Math.PI ? 1 : 0;
          body += `<path d="M${P(r, s0)}A${r},${r} 0 ${large} 1 ${P(r, s1)}L${P(inner, s1)}A${inner},${inner} 0 ${large} 0 ${P(inner, s0)}Z" style="fill:${p.color}"/>`;
          a0 = a1;
        });
      }
      const fs = n >= 100 ? 9 : 10;
      body += `<text x="${c}" y="${(c + fs * 0.36).toFixed(2)}" text-anchor="middle" style="font:600 ${fs}px var(--font-mono);fill:var(--ink)">${n}</text>`;
    }
    return { html: `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="overflow:visible">${body}</svg>`, size };
  }

  root.MPCharts = { columns, ciRows, strip, miniColumns, months, siteGlyph, glyphRadius, tip, tipRows, bindTip, esc, hBarPath, niceMax };
})(window);
