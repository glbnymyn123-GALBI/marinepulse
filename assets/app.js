/* MarinePulse app: state, map, side panel, Analysis and Report views. */
(function () {
  'use strict';
  const D = window.MPData, S = window.MPStats, A = window.MPAnalysis, C = window.MPCharts;
  const esc = C.esc;

  const TYPE_ORDER = ['Dolphin', 'Whale', 'Monk seal', 'Dugong', 'Unidentified'];
  const TYPE_COLOR = {
    Dolphin: 'var(--t-dolphin)', Whale: 'var(--t-whale)', 'Monk seal': 'var(--t-seal)',
    Dugong: 'var(--t-dugong)', Unidentified: 'var(--t-unid)',
  };
  const TYPE_PLURAL = { Dolphin: 'dolphins', Whale: 'whales', 'Monk seal': 'monk seals', Dugong: 'dugongs', Unidentified: 'unidentified' };
  const COUNTRY_BOUNDS = {
    Lebanon: [[33.03, 35.05], [34.72, 36.0]],
    Syria: [[34.62, 35.55], [36.0, 36.05]],
    Gaza: [[31.2, 34.18], [31.62, 34.58]],
    Egypt: [[23.9, 26.9], [31.75, 35.8]],
  };
  const LEVANT = [[23.9, 26.9], [36.3, 36.4]];

  const state = {
    records: [], dataset: '',
    filters: { country: null, type: null, species: null, status: null },
    site: null, recordIndex: 0, record: null,
    view: 'map', heat: false,
    analysisOpts: { ...A.DEFAULTS },
    analysis: null, analysisKey: '', analysisRuns: 0,
  };

  // ---- helpers ---------------------------------------------------------------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const swatch = t => `<i class="swatch sw-${t.replace(/\s/g, '-')}" aria-hidden="true"></i>`;
  const pct = (x, d = 0) => (Number.isFinite(x) ? (x * 100).toFixed(d) + '%' : 'n/a');
  const fx = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');
  const signed = (x, d = 2) => (Number.isFinite(x) ? (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(d) : 'n/a');
  const pText = p => (!Number.isFinite(p) ? 'p n/a' : p < 0.001 ? 'p < 0.001' : 'p = ' + p.toFixed(3));
  const pCell = p => (!Number.isFinite(p) ? '' : p < 0.001 ? '< 0.001' : p.toFixed(3));
  const safeUrl = u => (/^https?:\/\/[^\s]+$/i.test(u || '') ? u : null);
  const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };
  const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
  const listJoin = xs => xs.length <= 1 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1];
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  function toast(msg, isError) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('error', !!isError);
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('show'), isError ? 5200 : 2800);
  }

  function filtered(except) {
    const f = state.filters;
    return state.records.filter(r =>
      (except === 'country' || !f.country || r.country === f.country) &&
      (except === 'type' || ((!f.type || r.type === f.type) && (!f.species || r.speciesKey === f.species))) &&
      (except === 'status' || !f.status || (f.status === 'stranded') === r.stranded));
  }
  const hasFilters = () => Object.values(state.filters).some(Boolean);
  const byRecent = (a, b) => ((b.year || 0) - (a.year || 0)) || ((b.month || 0) - (a.month || 0)) || (((b.date && b.date.d) || 0) - ((a.date && a.date.d) || 0));

  function siteKey(r) { return r.coords ? r.coords.lat.toFixed(3) + ',' + r.coords.lng.toFixed(3) : null; }
  function buildSites(recs) {
    const sites = new Map();
    recs.forEach(r => {
      const k = siteKey(r);
      if (!k) return;
      if (!sites.has(k)) sites.set(k, { key: k, lat: r.coords.lat, lng: r.coords.lng, records: [] });
      sites.get(k).records.push(r);
    });
    sites.forEach(s => {
      s.records.sort(byRecent);
      const names = {};
      s.records.forEach(r => { const n = r.city || r.country; names[n] = (names[n] || 0) + 1; });
      s.name = Object.entries(names).sort((a, b) => b[1] - a[1])[0][0];
      s.country = s.records[0].country;
      s.counts = {};
      s.records.forEach(r => { s.counts[r.type] = (s.counts[r.type] || 0) + 1; });
    });
    return sites;
  }

  // ---- theme -------------------------------------------------------------------
  function effectiveTheme() {
    const t = document.documentElement.dataset.theme;
    if (t === 'light' || t === 'dark') return t;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function applyThemeChrome() {
    const dark = effectiveTheme() === 'dark';
    $('#themeBtn').innerHTML = `<i class="ph ph-${dark ? 'sun' : 'moon'}"></i>`;
    $('#themeBtn').setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    document.querySelector('meta[name="theme-color"]').setAttribute('content', dark ? '#1a1a19' : '#fcfcfb');
    setTiles();
  }
  function toggleTheme() {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('mp-theme', next); } catch (e) { /* storage unavailable */ }
    applyThemeChrome();
  }

  // ---- map ---------------------------------------------------------------------------
  let map, tileBase, tileLabels, markerLayer, heatLayer;
  const markers = new Map();
  let currentSites = new Map();

  function initMap() {
    // Whole zoom levels keep raster tiles sharp and avoid seams between tile sets.
    map = L.map('mapCanvas', { zoomControl: false, minZoom: 4, maxZoom: 16, zoomSnap: 1, zoomDelta: 1, worldCopyJump: false });
    map.attributionControl.setPrefix(false);
    map.createPane('labels');
    map.getPane('labels').style.zIndex = 450;
    map.getPane('labels').style.pointerEvents = 'none';
    map.fitBounds(LEVANT, { padding: [20, 20] });
    setTiles();
    markerLayer = L.layerGroup().addTo(map);
    $('#zoomIn').onclick = () => map.zoomIn();
    $('#zoomOut').onclick = () => map.zoomOut();
    $('#zoomFit').onclick = () => fitToSites(true);
    map.on('click', () => C.tip.hide());
    map.on('zoomend', () => { if (currentSites.size) drawClusters(false); });
  }

  function setTiles() {
    if (!map) return;
    const dark = effectiveTheme() === 'dark';
    const base = dark ? 'World_Dark_Gray_Base' : 'World_Light_Gray_Base';
    const ref = dark ? 'World_Dark_Gray_Reference' : 'World_Light_Gray_Reference';
    if (tileBase) map.removeLayer(tileBase);
    if (tileLabels) map.removeLayer(tileLabels);
    tileBase = L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${base}/MapServer/tile/{z}/{y}/{x}`, {
      maxZoom: 16, attribution: 'Basemap &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
    }).addTo(map);
    tileLabels = L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${ref}/MapServer/tile/{z}/{y}/{x}`, {
      maxZoom: 16, pane: 'labels', opacity: 0.9,
    }).addTo(map);
  }

  function siteParts(site) {
    return TYPE_ORDER.filter(t => site.counts[t]).map(t => ({ value: site.counts[t], color: TYPE_COLOR[t] }));
  }
  function siteTip(site) {
    const rows = TYPE_ORDER.filter(t => site.counts[t]).map(t => [t === 'Unidentified' ? 'Not identified' : t, site.counts[t], TYPE_COLOR[t]]);
    const stranded = site.records.filter(r => r.stranded).length;
    if (stranded) rows.push(['Stranded', stranded]);
    return C.tipRows(`${site.name}, ${site.country}`, [['Reports', site.records.length], ...rows]);
  }

  /* Greedy screen-space clustering: sites whose rings would overlap at the current
     zoom merge into one ring anchored on the busiest site. Zooming in splits them. */
  let clusters = new Map();
  const siteToCluster = new Map();
  function clusterSites(zoom) {
    const list = [...currentSites.values()]
      .map(s => ({ s, p: map.project([s.lat, s.lng], zoom), r: C.glyphRadius(s.records.length) }))
      .sort((a, b) => b.s.records.length - a.s.records.length);
    const used = new Set();
    clusters = new Map();
    siteToCluster.clear();
    list.forEach(a => {
      if (used.has(a.s.key)) return;
      used.add(a.s.key);
      const members = [a.s];
      let n = a.s.records.length;
      list.forEach(b => {
        if (used.has(b.s.key)) return;
        if (a.p.distanceTo(b.p) < C.glyphRadius(n) + b.r + 3) {
          used.add(b.s.key); members.push(b.s); n += b.s.records.length;
        }
      });
      const counts = {};
      members.forEach(s => Object.entries(s.counts).forEach(([t, v]) => { counts[t] = (counts[t] || 0) + v; }));
      const cl = { key: 'c:' + a.s.key, anchor: a.s, sites: members, n, counts, lat: a.s.lat, lng: a.s.lng };
      clusters.set(cl.key, cl);
      members.forEach(s => siteToCluster.set(s.key, cl.key));
    });
  }
  const clusterParts = cl => TYPE_ORDER.filter(t => cl.counts[t]).map(t => ({ value: cl.counts[t], color: TYPE_COLOR[t] }));
  function clusterIcon(cl, animate, delay) {
    const selected = !!(state.site && cl.sites.some(s => s.key === state.site.key));
    const g = C.siteGlyph(clusterParts(cl), cl.n, selected, cl.sites.length > 1);
    const style = animate ? `style="animation-delay:${delay}ms"` : '';
    return L.divIcon({
      className: 'site-icon' + (animate ? ' site-in' : ''),
      html: `<div ${style}>${g.html}</div>`, iconSize: [g.size, g.size], iconAnchor: [g.size / 2, g.size / 2],
    });
  }
  function clusterTip(cl) {
    if (cl.sites.length === 1) return siteTip(cl.anchor);
    const rows = TYPE_ORDER.filter(t => cl.counts[t]).map(t => [t === 'Unidentified' ? 'Not identified' : t, cl.counts[t], TYPE_COLOR[t]]);
    return C.tipRows(`${cl.sites.length} sites around ${cl.anchor.name}`, [['Reports', cl.n], ...rows]) +
      '<div class="tt-row" style="margin-top:4px;opacity:.75"><span>Select to zoom in</span><span></span></div>';
  }

  function renderMarkers(animate) {
    currentSites = buildSites(filtered());
    drawClusters(animate);
    const empty = $('#mapEmpty');
    const total = filtered().length;
    if (!currentSites.size) {
      empty.hidden = false;
      empty.textContent = total ? `None of the ${plural(total, 'matching report has', 'matching reports have')} coordinates.` : 'No reports match these filters.';
    } else empty.hidden = true;
  }

  function drawClusters(animate) {
    markerLayer.clearLayers();
    markers.clear();
    clusterSites(map.getZoom());
    const c = map.getCenter();
    const anim = animate && !reduceMotion();
    [...clusters.values()].sort((a, b) => a.n - b.n).forEach(cl => {
      const delay = anim ? Math.min(260, Math.hypot(cl.lat - c.lat, cl.lng - c.lng) * 28) : 0;
      const selected = !!(state.site && cl.sites.some(s => s.key === state.site.key));
      const m = L.marker([cl.lat, cl.lng], {
        icon: clusterIcon(cl, anim, delay), keyboard: true, riseOnHover: true,
        title: cl.sites.length > 1 ? `${cl.sites.length} sites, ${cl.n} reports` : `${cl.anchor.name}: ${plural(cl.n, 'report', 'reports')}`,
        zIndexOffset: selected ? 1000 : cl.n,
      });
      m.on('click', () => {
        C.tip.hide();
        if (cl.sites.length > 1 && map.getZoom() < map.getMaxZoom() - 1) {
          const b = L.latLngBounds(cl.sites.map(s => [s.lat, s.lng]));
          map.flyToBounds(b, { padding: [70, 70], maxZoom: Math.min(14, map.getZoom() + 4), duration: reduceMotion() ? 0 : 0.7 });
        } else selectSite(cl.anchor.key, 0, { pan: false });
      });
      const show = e => C.tip.show(clusterTip(cl), e.originalEvent.clientX, e.originalEvent.clientY);
      m.on('mouseover', show);
      m.on('mousemove', show);
      m.on('mouseout', () => C.tip.hide());
      m.addTo(markerLayer);
      markers.set(cl.key, m);
    });
    renderHeat();
  }

  function refreshMarker(siteKeyValue) {
    const ck = siteToCluster.get(siteKeyValue);
    const cl = clusters.get(ck), m = markers.get(ck);
    if (!cl || !m) return;
    const selected = !!(state.site && cl.sites.some(s => s.key === state.site.key));
    m.setIcon(clusterIcon(cl, false, 0));
    m.setZIndexOffset(selected ? 1000 : cl.n);
  }

  function renderHeat() {
    if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }
    if (!state.heat || typeof L.heatLayer !== 'function') return;
    const pts = filtered().filter(r => r.coords).map(r => [r.coords.lat, r.coords.lng, 0.7]);
    heatLayer = L.heatLayer(pts, {
      radius: 28, blur: 22, maxZoom: 9, minOpacity: 0.25,
      gradient: { 0.25: 'rgba(253,224,71,0.55)', 0.55: '#f59e0b', 0.85: '#dc2626' },
    }).addTo(map);
  }

  function fitToSites(animate) {
    const c = state.filters.country;
    let b;
    if (c && COUNTRY_BOUNDS[c]) b = L.latLngBounds(COUNTRY_BOUNDS[c]);
    else {
      const pts = [...currentSites.values()].map(s => [s.lat, s.lng]);
      b = pts.length ? L.latLngBounds(pts).pad(0.015) : L.latLngBounds(LEVANT);
    }
    const opt = { padding: [14, 14], maxZoom: 11 };
    if (animate && !reduceMotion()) map.flyToBounds(b, { ...opt, duration: 0.9 });
    else map.fitBounds(b, opt);
  }

  function renderLegend() {
    const recs = filtered();
    const counts = {};
    recs.forEach(r => { if (r.coords) counts[r.type] = (counts[r.type] || 0) + 1; });
    const rows = TYPE_ORDER.filter(t => counts[t]).map(t =>
      `<div class="legend-row">${swatch(t)}<span>${t === 'Unidentified' ? 'Not identified' : t}</span><span class="n">${counts[t]}</span></div>`).join('');
    const glyph = (n, cluster) => C.siteGlyph([{ value: n, color: 'var(--ink-4)' }], n, false, cluster).html.replace('<svg', '<svg aria-hidden="true"');
    $('#legend').innerHTML = `
      <h3>Reports on the map</h3>
      ${rows || '<div class="legend-row"><span></span><span class="muted">None</span><span></span></div>'}
      <div class="legend-sizes">
        <span class="glyphs">${glyph(1)}${glyph(5)}${glyph(20)}</span><span>Reports per site</span>
        <span class="glyphs">${glyph(8, true)}</span><span>Nearby sites, grouped until you zoom in</span>
      </div>
      <div class="legend-toggle"><span>Density layer</span>
        <button class="switch" id="heatSwitch" role="switch" aria-checked="${state.heat}" aria-label="Show density layer"></button></div>
      ${state.heat ? '<div class="heat-scale" aria-hidden="true"></div>' : ''}`;
    $('#heatSwitch').onclick = () => { state.heat = !state.heat; renderLegend(); renderHeat(); };
  }

  // ---- selection ------------------------------------------------------------------------
  function selectSite(key, index = 0, { pan = true } = {}) {
    const prev = state.site && state.site.key;
    const site = currentSites.get(key);
    if (!site) return;
    state.site = site;
    state.recordIndex = Math.max(0, Math.min(index, site.records.length - 1));
    state.record = site.records[state.recordIndex];
    if (prev && prev !== key) refreshMarker(prev);
    refreshMarker(key);
    if (pan) map.flyTo([site.lat, site.lng], Math.max(map.getZoom(), 9), { duration: reduceMotion() ? 0 : 0.8 });
    renderRecord();
  }
  function selectRecordWithoutSite(r) {
    const prev = state.site && state.site.key;
    state.site = null; state.recordIndex = 0; state.record = r;
    if (prev) refreshMarker(prev);
    renderRecord();
  }
  function defaultSelection() {
    const recs = filtered().sort(byRecent);
    // Open on the latest identified, mapped report; fall back to any mapped one.
    const withCoords = recs.find(r => r.coords && r.species) || recs.find(r => r.coords);
    if (withCoords) {
      const site = currentSites.get(siteKey(withCoords));
      selectSite(site.key, site.records.indexOf(withCoords), { pan: false });
    } else if (recs.length) selectRecordWithoutSite(recs[0]);
    else { state.site = null; state.record = null; renderRecord(); }
  }

  // ---- record card ------------------------------------------------------------------------
  function groupText(r) {
    const g = r.groupRaw;
    if (!g || /^(n\/a|na|-)$/i.test(g)) return 'Not recorded';
    let t = g.startsWith('>') ? `${g.slice(1)} or more` : g.startsWith('~') ? `About ${g.slice(1)}` : g.replace(/\s*-\s*/, ' to ');
    if (/^1$/.test(g)) t = '1 (solitary)';
    const calves = r.calves && !/^0$/.test(r.calves) && !/^n\/?a$/i.test(r.calves)
      ? `, ${r.calves.startsWith('>') ? r.calves.slice(1) + '+' : r.calves} ${r.calves === '1' ? 'calf' : 'calves'}` : '';
    return t + calves;
  }
  const credText = { high: 'High', medium: 'Medium', low: 'Low', unrated: 'Not rated' };

  function renderRecord() {
    const box = $('#record'), r = state.record;
    if (!r) {
      box.innerHTML = `<div class="record-top"></div><h3>No matching reports</h3>
        <p class="muted" style="margin-top:6px">Try another country, species or status, or clear the filters.</p>
        <div class="record-actions"><button class="btn" id="emptyClear">Clear filters</button></div>`;
      $('#emptyClear').onclick = clearFilters;
      return;
    }
    const sp = r.species;
    const site = state.site;
    const n = site ? site.records.length : 1;
    const place = [r.city, r.country].filter(Boolean).join(', ') || 'Not recorded';
    const coastNote = r.country === 'Egypt' && /Red Sea|Mediterranean|Suez/.test(r.coast) ? r.coast.replace('Egypt (', '').replace(')', '') + (r.coast.includes('Suez') ? '' : ' coast') : '';
    const coords = r.coords
      ? `<span class="mono">${r.coords.lat.toFixed(4)}, ${r.coords.lng.toFixed(4)}</span>${r.coords.estimated ? '<small>Estimated from the place name</small>' : ''}`
      : 'Not recorded<small>Not shown on the map</small>';
    const url = safeUrl(r.source);
    const platform = r.platformRaw && !/^n\/?a$/i.test(r.platformRaw) ? r.platformRaw.charAt(0).toUpperCase() + r.platformRaw.slice(1) : 'Not stated';
    box.innerHTML = `
      <div class="record-top">
        <span class="chip">${swatch(r.type)}${r.type === 'Unidentified' ? 'Not identified' : r.type}</span>
        ${r.stranded
          ? '<span class="chip stranded"><i class="ph ph-warning" aria-hidden="true"></i>Stranded</span>'
          : '<span class="chip"><i class="ph ph-waves" aria-hidden="true"></i>In water</span>'}
        ${n > 1 ? `<div class="record-nav" aria-label="Reports at this site">
            <button id="recPrev" aria-label="Previous report at this site" ${state.recordIndex === 0 ? 'disabled' : ''}><i class="ph ph-caret-left"></i></button>
            <span class="mono">${state.recordIndex + 1} / ${n}</span>
            <button id="recNext" aria-label="Next report at this site" ${state.recordIndex >= n - 1 ? 'disabled' : ''}><i class="ph ph-caret-right"></i></button>
          </div>` : ''}
      </div>
      <h3>${sp ? esc(sp.common) : 'Species not identified'}</h3>
      <p class="latin">${sp ? esc(sp.latin) : (r.speciesRaw && !/^(n\/a|-)?$/i.test(r.speciesRaw) ? esc(r.speciesRaw) : 'Reported as an unidentified marine mammal')}</p>
      ${sp ? `<p class="iucn">IUCN Red List (global): <strong>${D.IUCN[sp.iucn]}</strong> <span class="mono">${sp.iucn}</span></p>` : ''}
      <dl class="facts">
        <div><dt>Date</dt><dd>${D.formatDate(r.date)}</dd></div>
        <div><dt>Place</dt><dd>${esc(place)}${coastNote ? `<small>${esc(coastNote)}</small>` : ''}</dd></div>
        <div><dt>Coordinates</dt><dd>${coords}</dd></div>
        <div><dt>Group size</dt><dd>${esc(groupText(r))}</dd></div>
        <div><dt>Observed from</dt><dd>${esc(platform)}</dd></div>
        <div><dt>Evidence</dt><dd>${r.media ? esc(r.media.charAt(0).toUpperCase() + r.media.slice(1).toLowerCase()) : 'Post'}<small>${credText[r.credibility] === 'Not rated' ? 'Credibility not rated' : credText[r.credibility] + ' credibility'}</small></dd></div>
      </dl>
      ${r.notes || r.arabic ? `<div class="record-notes">${r.notes ? esc(r.notes.charAt(0).toUpperCase() + r.notes.slice(1)) : ''}${r.arabic ? `<span class="ar" dir="rtl" lang="ar">${esc(r.arabic)}</span>` : ''}</div>` : ''}
      ${url ? `<div class="record-actions"><a class="btn" href="${esc(url)}" target="_blank" rel="noopener noreferrer"><i class="ph ph-arrow-square-out" aria-hidden="true"></i>Open the original post on ${esc(hostOf(url))}</a></div>` : ''}`;
    if (n > 1) {
      $('#recPrev').onclick = () => selectSite(site.key, state.recordIndex - 1, { pan: false });
      $('#recNext').onclick = () => selectSite(site.key, state.recordIndex + 1, { pan: false });
    }
  }

  // ---- side panel summaries ---------------------------------------------------------------------
  function renderKpis() {
    const recs = filtered();
    const mapped = recs.filter(r => r.coords).length;
    const stranded = recs.filter(r => r.stranded).length;
    const species = new Set(recs.map(r => r.speciesKey).filter(Boolean)).size;
    const share = x => (recs.length ? pct(x / recs.length) : '0%');
    $('#kpis').innerHTML = `
      <div class="kpi"><div class="kpi-label">Reports</div><div class="kpi-value">${recs.length.toLocaleString('en-US')}</div><div class="kpi-sub">${hasFilters() ? `of ${state.records.length}` : 'all reports'}</div></div>
      <div class="kpi"><div class="kpi-label">On the map</div><div class="kpi-value">${mapped}</div><div class="kpi-sub">${share(mapped)}</div></div>
      <div class="kpi"><div class="kpi-label">Stranded</div><div class="kpi-value">${stranded}</div><div class="kpi-sub">${share(stranded)}</div></div>
      <div class="kpi"><div class="kpi-label">Species</div><div class="kpi-value">${species}</div><div class="kpi-sub">identified</div></div>`;
  }

  function yearSeries(recs) {
    const years = state.records.map(r => r.year).filter(Boolean);
    if (!years.length) return { data: [], partialNote: '' };
    const y0 = Math.min(...years), y1 = Math.max(...years);
    const lastMonth = Math.max(...state.records.filter(r => r.year === y1).map(r => r.month || 1));
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const partial = lastMonth < 12;
    const data = [];
    for (let y = y0; y <= y1; y++) {
      const inYear = recs.filter(r => r.year === y);
      const s = inYear.filter(r => r.stranded).length;
      data.push({
        label: String(y), total: inYear.length, partial: partial && y === y1,
        note: partial && y === y1 ? `January to ${months[lastMonth - 1]} only` : '',
        segments: [
          { key: 'In water', value: inYear.length - s, color: 'var(--s-water)' },
          { key: 'Stranded', value: s, color: 'var(--s-stranded)' },
        ],
      });
    }
    return { data, partialNote: partial ? `${y1} covers January to ${months[lastMonth - 1]}` : '' };
  }

  function renderYearChart() {
    const { data, partialNote } = yearSeries(filtered());
    const box = $('#yearChart');
    C.columns(box, data, { height: 150, id: 'p', label: 'Reports per year, in water and stranded' });
    if (partialNote) {
      const p = document.createElement('p');
      p.className = 'footnote';
      p.style.marginTop = '6px';
      p.textContent = `Hatched: ${partialNote}, so it is not comparable with full years.`;
      box.appendChild(p);
    }
  }

  function rowButton({ key, label, value, total, color, pressed, title }) {
    const share = total ? value / total : 0;
    return `<button class="row-btn" data-key="${esc(key)}" aria-pressed="${pressed}" title="${esc(title || '')}">
      <i class="swatch" style="background:${color}" aria-hidden="true"></i>
      <span class="label"><span>${esc(label)}</span><span class="bar-track"><span class="bar-fill" style="width:${(share * 100).toFixed(1)}%;background:${color}"></span></span></span>
      <span class="v">${value}</span><span class="pct">${pct(share)}</span></button>`;
  }

  function renderStatusRows() {
    const recs = filtered('status');
    const s = recs.filter(r => r.stranded).length;
    const f = state.filters.status;
    $('#statusRows').innerHTML =
      rowButton({ key: 'water', label: 'In water', value: recs.length - s, total: recs.length, color: 'var(--s-water)', pressed: f === 'water', title: 'Show only animals seen alive in the water' }) +
      rowButton({ key: 'stranded', label: 'Stranded or found dead', value: s, total: recs.length, color: 'var(--s-stranded)', pressed: f === 'stranded', title: 'Show only stranded animals' });
    $$('#statusRows .row-btn').forEach(b => {
      b.onclick = () => setFilter('status', state.filters.status === b.dataset.key ? null : b.dataset.key);
    });
  }

  function renderTypeRows() {
    const recs = filtered('type');
    const counts = {};
    recs.forEach(r => { counts[r.type] = (counts[r.type] || 0) + 1; });
    const f = state.filters;
    $('#typeRows').innerHTML = TYPE_ORDER.map(t => rowButton({
      key: t, label: t === 'Unidentified' ? 'Not identified' : t, value: counts[t] || 0, total: recs.length,
      color: TYPE_COLOR[t], pressed: f.type === t && !f.species, title: `Show only ${TYPE_PLURAL[t]}`,
    })).join('');
    $('#typeNote').textContent = f.species ? 'Species filter active' : '';
    $$('#typeRows .row-btn').forEach(b => {
      b.onclick = () => {
        const same = state.filters.type === b.dataset.key && !state.filters.species;
        state.filters.species = null;
        setFilter('type', same ? null : b.dataset.key);
      };
    });
  }

  function renderPanelFoot() {
    $('#panelFoot').innerHTML = `Data: <span class="mono">${esc(state.dataset)}</span>, ${plural(state.records.length, 'report', 'reports')}. Coordinates marked estimated were placed from the town or beach named in the post.`;
  }

  // ---- filter bar -------------------------------------------------------------------------------------
  function renderFilterBar() {
    const f = state.filters;
    const cRecs = filtered('country');
    const countries = D.COUNTRIES.filter(c => state.records.some(r => r.country === c));
    const extra = [...new Set(state.records.map(r => r.country))].filter(c => c && !countries.includes(c)).sort();
    const cBtn = (key, label, n) => `<button data-key="${esc(key)}" aria-pressed="${(f.country || '') === key}">${esc(label)}<span class="count">${n}</span></button>`;
    $('#countrySeg').innerHTML = cBtn('', 'All', cRecs.length) +
      [...countries, ...extra].map(c => cBtn(c, c, cRecs.filter(r => r.country === c).length)).join('');
    $$('#countrySeg button').forEach(b => { b.onclick = () => setFilter('country', b.dataset.key || null); });

    const sRecs = filtered('status');
    const ns = sRecs.filter(r => r.stranded).length;
    const sBtn = (key, label, n) => `<button data-key="${key}" aria-pressed="${(f.status || '') === key}">${label}<span class="count">${n}</span></button>`;
    $('#statusSeg').innerHTML = sBtn('', 'All', sRecs.length) + sBtn('water', 'In water', sRecs.length - ns) + sBtn('stranded', 'Stranded', ns);
    $$('#statusSeg button').forEach(b => { b.onclick = () => setFilter('status', b.dataset.key || null); });

    let label = 'All species';
    if (f.species) label = `${swatch(D.SPECIES[f.species].type)}${esc(D.SPECIES[f.species].common)}`;
    else if (f.type) label = `${swatch(f.type)}${f.type === 'Unidentified' ? 'Not identified' : f.type + 's'}`;
    $('#typeBtnLabel').innerHTML = label;

    const n = filtered().length;
    $('#filterCount').innerHTML = hasFilters()
      ? `<strong>${n}</strong> of ${state.records.length} reports`
      : `<strong>${state.records.length}</strong> reports`;
    $('#clearFilters').hidden = !hasFilters();
  }

  function renderCatalog() {
    const recs = filtered('type');
    const f = state.filters;
    const typeCount = t => recs.filter(r => r.type === t).length;
    const spCount = k => recs.filter(r => r.speciesKey === k).length;
    let html = `<div class="catalog-group"><button class="catalog-item is-type" role="option" data-type="" aria-checked="${!f.type && !f.species}">
        <span></span><span>All species</span><span class="n">${recs.length}</span></button></div>`;
    TYPE_ORDER.forEach(t => {
      const species = Object.entries(D.SPECIES).filter(([, s]) => s.type === t);
      html += `<div class="catalog-group">
        <button class="catalog-item is-type ${typeCount(t) ? '' : 'is-empty'}" role="option" data-type="${t}" aria-checked="${f.type === t && !f.species}">
          ${swatch(t)}<span>${t === 'Unidentified' ? 'Not identified' : t + 's'}</span><span class="n">${typeCount(t)}</span></button>
        ${species.map(([k, s]) => `<button class="catalog-item is-species ${spCount(k) ? '' : 'is-empty'}" role="option" data-species="${k}" aria-checked="${f.species === k}">
          <span>${esc(s.common)}<span class="latin">${esc(s.latin)}</span></span><span class="n">${spCount(k)}</span></button>`).join('')}
      </div>`;
    });
    const pop = $('#catalog');
    pop.innerHTML = html;
    $$('.catalog-item', pop).forEach(b => {
      b.onclick = () => {
        if (b.dataset.species) {
          state.filters.type = null;
          setFilter('species', state.filters.species === b.dataset.species ? null : b.dataset.species);
        } else {
          state.filters.species = null;
          setFilter('type', b.dataset.type || null);
        }
        closeCatalog();
      };
    });
  }
  function openCatalog() {
    renderCatalog();
    const pop = $('#catalog'), btn = $('#typeBtn');
    pop.hidden = false;
    const r = btn.getBoundingClientRect();
    pop.style.top = r.bottom + 6 + 'px';
    pop.style.left = Math.min(r.left, innerWidth - pop.offsetWidth - 12) + 'px';
    btn.setAttribute('aria-expanded', 'true');
    const first = pop.querySelector('[aria-checked="true"]') || pop.querySelector('button');
    if (first) first.focus();
  }
  function closeCatalog() {
    $('#catalog').hidden = true;
    $('#typeBtn').setAttribute('aria-expanded', 'false');
  }

  function setFilter(key, value) {
    state.filters[key] = value;
    applyFilters({ refit: key === 'country' });
  }
  function clearFilters() {
    state.filters = { country: null, type: null, species: null, status: null };
    applyFilters({ refit: true });
  }

  function applyFilters({ refit = false, animate = true } = {}) {
    renderFilterBar();
    renderMarkers(animate);
    renderLegend();
    renderKpis();
    renderYearChart();
    renderStatusRows();
    renderTypeRows();
    // Keep the selected report if it still matches, otherwise pick the latest one.
    const keep = state.record && filtered().includes(state.record) && state.site && currentSites.has(state.site.key);
    if (keep) {
      const site = currentSites.get(state.site.key);
      selectSite(site.key, Math.max(0, site.records.indexOf(state.record)), { pan: false });
    } else defaultSelection();
    if (refit) fitToSites(true);
  }

  // ---- search -----------------------------------------------------------------------------------------
  let searchItems = [], searchActive = -1;
  function searchQuery(q) {
    q = q.trim().toLowerCase();
    if (!q) return [];
    const out = [];
    const m = q.match(/^(-?\d{1,2}(?:\.\d+)?)[,\s]+(-?\d{1,3}(?:\.\d+)?)$/);
    if (m) out.push({ kind: 'coords', lat: +m[1], lng: +m[2], title: `Go to ${(+m[1]).toFixed(3)}, ${(+m[2]).toFixed(3)}`, sub: 'Coordinates' });
    const species = Object.entries(D.SPECIES).filter(([k, s]) => s.common.toLowerCase().includes(q) || k.includes(q));
    species.forEach(([k, s]) => {
      const n = state.records.filter(r => r.speciesKey === k).length;
      if (n) out.push({ kind: 'species', key: k, type: s.type, title: s.common, sub: s.latin, n });
    });
    const sites = buildSites(state.records);
    const places = {};
    sites.forEach(s => {
      const hay = (s.name + ' ' + s.country).toLowerCase();
      if (hay.includes(q)) {
        const k = s.name + '|' + s.country;
        if (!places[k] || places[k].site.records.length < s.records.length) places[k] = { site: s };
      }
    });
    Object.values(places).sort((a, b) => b.site.records.length - a.site.records.length).slice(0, 6).forEach(({ site }) => {
      const top = TYPE_ORDER.find(t => site.counts[t]);
      out.push({ kind: 'site', key: site.key, type: top, title: site.name, sub: site.country, n: site.records.length });
    });
    return out.slice(0, 8);
  }
  function renderSearch() {
    const box = $('#searchResults'), input = $('#searchInput');
    searchItems = searchQuery(input.value);
    if (!input.value.trim()) { box.hidden = true; input.setAttribute('aria-expanded', 'false'); return; }
    box.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (!searchItems.length) { box.innerHTML = '<div class="search-empty">No places or species match. Try a town, a species, or "33.9, 35.5".</div>'; return; }
    box.innerHTML = searchItems.map((it, i) => `<button role="option" data-i="${i}" aria-selected="${i === searchActive}">
      ${it.type ? swatch(it.type) : '<i class="ph ph-crosshair" aria-hidden="true"></i>'}
      <span><span class="r-title">${esc(it.title)}</span> <span class="r-sub">${esc(it.sub)}</span></span>
      <span class="r-meta">${it.n ? plural(it.n, 'report', 'reports') : ''}</span></button>`).join('');
    $$('button', box).forEach(b => { b.onmousedown = e => { e.preventDefault(); chooseSearch(+b.dataset.i); }; });
  }
  function chooseSearch(i) {
    const it = searchItems[i];
    if (!it) return;
    $('#searchResults').hidden = true;
    $('#searchInput').value = '';
    $('#searchInput').blur();
    $('#search').classList.remove('open');
    showView('map');
    if (it.kind === 'coords') { map.flyTo([it.lat, it.lng], 11, { duration: reduceMotion() ? 0 : 0.9 }); return; }
    if (it.kind === 'species') {
      state.filters = { country: null, type: null, species: it.key, status: null };
      applyFilters({ refit: true });
      return;
    }
    if (!currentSites.has(it.key)) { state.filters = { country: null, type: null, species: null, status: null }; applyFilters(); }
    selectSite(it.key, 0, { pan: true });
  }

  // ---- views --------------------------------------------------------------------------------------------
  function showView(v, { push = true } = {}) {
    if (!['map', 'analysis', 'report'].includes(v)) v = 'map';
    state.view = v;
    $$('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.view === v)));
    $('#view-map').hidden = v !== 'map';
    $('#view-analysis').hidden = v !== 'analysis';
    $('#view-report').hidden = v !== 'report';
    if (push && location.hash !== '#' + v) history.replaceState(null, '', '#' + v);
    if (v === 'map') setTimeout(() => map.invalidateSize(), 0);
    if (v === 'analysis') renderAnalysis();
    if (v === 'report') renderReport();
    C.tip.hide();
  }

  // ---- analysis ------------------------------------------------------------------------------------------
  function getAnalysis(opts) {
    const key = JSON.stringify(opts) + '|' + state.analysisRuns;
    if (state.analysisKey === key && state.analysis) return state.analysis;
    state.analysis = A.run(state.records, opts);
    state.analysisKey = key;
    return state.analysis;
  }
  const baselineAnalysis = () => A.run(state.records, { ...A.DEFAULTS });

  // Keep "p = 0.016" and "z = +4.2" on one line.
  const statHtml = t => esc(t).replace(/ ([=<>\u2264\u2265]|&lt;|&gt;) /g, '&nbsp;$1&nbsp;').replace(/ p&nbsp;/g, '&nbsp;p&nbsp;');

  function rowLabel(row) { return row.replace('Egypt (Mediterranean)', 'Egypt, Med').replace('Egypt (Red Sea)', 'Egypt, Red Sea'); }

  function buildFindings(res) {
    const out = [];
    const comp = res.composition;
    const sig = comp.pMC < 0.05;
    out.push({
      text: sig
        ? `<strong>Where a report comes from predicts which animal it shows.</strong> The mix of dolphins, whales, monk seals and dugongs is not the same across ${res.rows.length === 4 ? 'the four countries' : 'the coasts'}; the association is ${comp.cramersV >= 0.3 ? 'strong' : comp.cramersV >= 0.15 ? 'moderate' : 'weak'}.`
        : '<strong>The species mix does not differ reliably between countries</strong> in this sample.',
      stat: `χ²(${comp.dof}) = ${fx(comp.chi2, 1)}, Monte Carlo ${pText(comp.pMC)}, Cramér's V = ${fx(comp.cramersV)}`,
    });
    const cells = res.likelihood.filter(c => c.pHolm < 0.05);
    res.rows.forEach(row => {
      const over = cells.filter(c => c.row === row && c.z > 0).sort((a, b) => b.z - a.z);
      if (!over.length) return;
      const parts = over.map(c => c.shareElsewhere === 0
        ? `is the only place with ${TYPE_PLURAL[c.type]} (${pct(c.share)} of its reports)`
        : `${TYPE_PLURAL[c.type]} (${pct(c.share)} vs ${pct(c.shareElsewhere)} elsewhere)`);
      const only = parts.filter(p => p.startsWith('is the only'));
      const more = parts.filter(p => !p.startsWith('is the only'));
      let sentence = `<strong>${rowLabel(row)}</strong> `;
      if (more.length) sentence += `reports more ${listJoin(more)} than the other countries`;
      if (more.length && only.length) sentence += ', and ';
      if (only.length) sentence += only.join(', ');
      out.push({ text: sentence + '.', stat: over.map(c => `${c.type}: z = ${signed(c.z)}, Holm ${pText(c.pHolm)}`).join('; ') });
    });
    const quiet = res.rows.filter(row => !cells.some(c => c.row === row));
    if (quiet.length) {
      const ns = quiet.map(row => comp.table[comp.rows.indexOf(row)] ? S.sum(comp.table[comp.rows.indexOf(row)]) : 0);
      out.push({
        text: `<strong>${listJoin(quiet.map(rowLabel))}</strong> show no significant departure from the overall mix, but with only ${listJoin(ns.map(String))} identified reports the tests have little power there.`,
        stat: 'All one-vs-rest z-tests Holm p > 0.05',
      });
    }
    const g = res.groupSize;
    if (g.main && g.bottlenose && g.main.welch.p > 0.05 && g.bottlenose.logWelch.p < 0.05) {
      const red = g.coasts.find(c => c.coast === 'Egypt (Red Sea)'), med = g.coasts.find(c => c.coast === 'Egypt (Mediterranean)');
      out.push({
        text: `<strong>Dolphin groups look the same size in Egypt and Lebanon, but that average hides two opposite effects.</strong> Red Sea pods are large (median ${red.median}), while bottlenose groups on Egypt's Mediterranean coast are smaller than Lebanon's (median ${g.bottlenose.median[0]} vs ${g.bottlenose.median[1]}).`,
        stat: `All dolphins: Welch t = ${fx(g.main.welch.t)}, ${pText(g.main.welch.p)}. Bottlenose only, log scale: t = ${fx(g.bottlenose.logWelch.t)}, ${pText(g.bottlenose.logWelch.p)}`,
      });
      void med;
    } else if (g.main) {
      const tSig = g.main.welch.p < 0.05, rSig = g.main.mwu.p < 0.05;
      const verdict = tSig && rSig ? 'a difference that holds on both the t-test and the rank test'
        : tSig ? 'significant on the t-test but not on the rank test, so a few large pods drive the gap'
        : rSig ? 'significant on the rank test only'
        : 'not a significant difference';
      out.push({
        text: `<strong>Dolphin group size</strong> averages ${fx(g.main.mean[0], 1)} in ${rowLabel(g.main.a)} and ${fx(g.main.mean[1], 1)} in Lebanon, ${verdict}.`,
        stat: `Welch t = ${fx(g.main.welch.t)}, ${pText(g.main.welch.p)}; Mann-Whitney ${pText(g.main.mwu.p)}`,
      });
    }
    const t = res.trend;
    if (t && !t.error) {
      out.push({
        text: `<strong>Reports grow about ${Math.round((t.irr - 1) * 100)}% a year.</strong> That mostly tracks more people filming and posting, so year-on-year counts say little about population change.`,
        stat: `Quasi-Poisson IRR = ${fx(t.irr)} per year (95% CI ${fx(t.low)} to ${fx(t.high)}), ${pText(t.p)}`,
      });
    }
    const st = res.strandings.byRow.slice().sort((a, b) => b.rate - a.rate)[0];
    if (st) {
      out.push({
        text: `<strong>${rowLabel(st.row)} has the highest stranding share</strong> (${pct(st.rate)} of its reports vs ${pct(st.rateElsewhere)} elsewhere), ${st.pHolm < 0.05 ? 'which holds after correcting for multiple tests' : 'but the gap is not significant once the four comparisons are corrected'}.`,
        stat: `z = ${signed(st.z)}, raw ${pText(st.p)}, Holm ${pText(st.pHolm)}`,
      });
    }
    const leb = res.seasonality.find(s => s.country === 'Lebanon');
    if (leb && leb.summerP < 0.05) {
      out.push({
        text: `<strong>Summer dominates.</strong> ${pct(leb.summerShare)} of Lebanon's reports fall in June to August, against ${pct(leb.summerExpected)} if they were spread evenly through the year.`,
        stat: `Exact binomial ${pText(leb.summerP)}; month-by-month χ²(11) = ${fx(leb.chi2, 1)}, ${pText(leb.p)}`,
      });
    }
    return out;
  }

  function divergingStyle(z, crit) {
    const a = Math.abs(z);
    if (a < 1) return { bg: 'var(--div-mid)', cls: '' };
    const side = z > 0 ? 'pos' : 'neg';
    const step = a >= crit + 1.5 ? 4 : a >= crit ? 3 : a >= 1.96 ? 2 : 1;
    const darkTheme = effectiveTheme() === 'dark';
    // Text flips to white on deep fills and to near-black on the light dark-theme poles.
    const cls = darkTheme ? (step === 3 ? 'dark' : step === 4 ? 'onlight' : '') : (step === 4 ? 'dark' : '');
    return { bg: `var(--div-${side}-${step})`, cls };
  }

  function heatTable(comp) {
    const totals = comp.table.map(r => S.sum(r));
    const colTotals = comp.types.map((_, j) => S.sum(comp.table.map(r => r[j])));
    const head = `<tr><th></th>${comp.types.map(t => `<th class="colh">${swatch(t)}${t}</th>`).join('')}<th class="r">Total</th></tr>`;
    const body = comp.rows.map((row, i) => `<tr><th scope="row">${rowLabel(row)}</th>${comp.types.map((t, j) => {
      const z = comp.adjResid[i][j], n = comp.table[i][j];
      const s = divergingStyle(z, comp.bonferroniZ);
      const flag = Math.abs(z) >= comp.bonferroniZ;
      return `<td class="cell ${s.cls} ${flag ? 'flag' : ''}" style="background:${s.bg}" tabindex="0"
        data-tip="${esc(C.tipRows(`${rowLabel(row)}: ${t}`, [['Reports', n], ['Expected if independent', fx(comp.expected[i][j], 1)], ['Adjusted residual z', signed(z)], ['Row share', pct(n / totals[i])]]))}">
        <span class="n">${n}</span><span class="z">z ${signed(z, 1)}</span></td>`;
    }).join('')}<td class="tot">${totals[i]}</td></tr>`).join('');
    const foot = `<tr><th scope="row" class="muted">Total</th>${colTotals.map(n => `<td class="tot" style="text-align:center">${n}</td>`).join('')}<td class="tot">${comp.n}</td></tr>`;
    return `<div class="table-wrap"><table class="heat" aria-label="Reports by country and type, coloured by adjusted residual">${head}${body}${foot}</table></div>
      <div class="heat-key">
        <span>Fewer than expected</span>
        <span class="ramp">${[4, 3, 2, 1].map(s => `<i style="background:var(--div-neg-${s})"></i>`).join('')}<i style="background:var(--div-mid)"></i>${[1, 2, 3, 4].map(s => `<i style="background:var(--div-pos-${s})"></i>`).join('')}</span>
        <span>More than expected</span>
        <span style="margin-left:12px"><i class="flag-key"></i>Significant after Bonferroni (|z| &ge; ${fx(comp.bonferroniZ)})</span>
      </div>`;
  }

  function seg(id, label, options, value) {
    return `<div class="filter"><span class="filter-label" id="lbl-${id}">${label}</span>
      <div class="seg" role="group" aria-labelledby="lbl-${id}" data-opt="${id}">
        ${options.map(([v, l]) => `<button data-v="${v}" aria-pressed="${value === v}">${l}</button>`).join('')}
      </div></div>`;
  }

  function renderAnalysis() {
    const view = $('#view-analysis');
    const opts = state.analysisOpts;
    if (!state.records.length) { view.innerHTML = '<div class="doc"><p class="muted">Load a CSV to run the analysis.</p></div>'; return; }
    const first = !view.querySelector('.doc');
    if (first) {
      view.innerHTML = `<div class="doc" id="analysisDoc">
        <header class="doc-head">
          <div>
            <h1>How each mammal type shows up, country by country</h1>
            <p class="lead" id="aLead"></p>
          </div>
          <div class="doc-meta" id="aMeta"></div>
        </header>
        <div class="controls" id="aControls"></div>
        <div class="doc-body" id="aBody"></div>
      </div>`;
    }
    $('#aControls').innerHTML =
      seg('sample', 'Records', [['all', 'All'], ['high', 'High credibility only']], opts.sample) +
      seg('egypt', 'Egypt', [['country', 'One country'], ['coast', 'Split by coast']], opts.egypt) +
      seg('delphinids', 'Orca, false killer whale', [['Whale', 'As whales'], ['Dolphin', 'As dolphins']], opts.delphinids) +
      seg('unidentified', 'Not identified', [['exclude', 'Leave out'], ['notes', 'Infer from notes']], opts.unidentified) +
      `<span class="busy" id="aBusy" hidden><i class="ph ph-circle-notch"></i>Recomputing</span>`;
    $$('#aControls .seg').forEach(g => {
      g.querySelectorAll('button').forEach(b => {
        b.onclick = () => {
          state.analysisOpts = { ...state.analysisOpts, [g.dataset.opt]: b.dataset.v };
          renderAnalysis();
        };
      });
    });
    const doc = $('#analysisDoc');
    doc.classList.add('is-busy');
    $('#aBusy').hidden = false;
    // Let the busy state paint, then compute (20,000-draw Monte Carlo tests take a moment).
    requestAnimationFrame(() => setTimeout(() => {
      const res = getAnalysis(state.analysisOpts);
      paintAnalysis(res);
      doc.classList.remove('is-busy');
      $('#aBusy').hidden = true;
    }, 16));
  }

  function paintAnalysis(res) {
    const comp = res.composition;
    const opts = res.options;
    const nonDefault = Object.keys(A.DEFAULTS).some(k => k !== 'draws' && opts[k] !== A.DEFAULTS[k]);
    $('#aLead').textContent = `${res.sample.records} public sighting reports from ${res.sample.firstYear} to ${res.sample.lastYear}. Each test asks whether the differences between ${res.rows.length === 4 ? 'countries' : 'coasts'} are larger than chance would produce.`;
    $('#aMeta').innerHTML = `<div><span class="mono">${comp.n}</span> identified reports</div><div>${nonDefault ? 'Alternative specification' : 'Main specification'}</div>`;

    const findings = buildFindings(res);
    const L = res.likelihood;
    const pooled = t => { const all = L.filter(c => c.type === t); const k = S.sum(all.map(c => c.k)), n = S.sum(all.map(c => c.n)); return n ? k / n : 0; };
    const rateCell = (row, t) => res.rates.cells.find(c => c.row === row && c.type === t);
    const g = res.groupSize;
    const st = res.strandings;
    const dq = res.dataQuality;
    const t = res.trend;

    $('#aBody').innerHTML = `
      <section class="findings" aria-label="Key findings">
        ${findings.map((f, i) => `<div class="finding"><span class="idx">${String(i + 1).padStart(2, '0')}</span><p>${f.text}<span class="stat">${statHtml(f.stat)}</span></p></div>`).join('')}
      </section>

      <section class="doc-section" id="s-composition">
        <h2>1. Which mammals are reported where</h2>
        <p class="q">If species and country were unrelated, every country would show the same mix. Each cell compares the observed count with that expectation; the adjusted residual is a z-score for the cell.</p>
        <div class="split">
          <div>${heatTable(comp)}</div>
          <div>
            <div class="card">
              <h3>Test of independence</h3>
              <dl class="test-list">
                <dt>Pearson &chi;&sup2;</dt><dd>${fx(comp.chi2, 2)} on ${comp.dof} df</dd>
                <dt>Asymptotic p</dt><dd>${comp.p < 1e-4 ? comp.p.toExponential(1) : pCell(comp.p)}</dd>
                <dt>Monte Carlo p</dt><dd>${pCell(comp.pMC)} (${(opts.draws).toLocaleString('en-US')} permutations)</dd>
                <dt>Cram&eacute;r's V</dt><dd>${fx(comp.cramersV, 3)} (bias-corrected ${fx(comp.cramersVCorrected, 3)})</dd>
                <dt>Expected &lt; 5</dt><dd>${pct(comp.shareExpectedBelow5)} of cells</dd>
              </dl>
              <p class="footnote">${comp.shareExpectedBelow5 > 0.2 ? 'More than a fifth of expected counts are below 5, so the chi-square approximation is unreliable here. The Monte Carlo p-value shuffles species labels across reports with both margins fixed, which is the exact reference distribution.' : 'Expected counts are large enough for the chi-square approximation.'}</p>
            </div>
          </div>
        </div>
      </section>

      <section class="doc-section" id="s-likelihood">
        <h2>2. How likely each type is, given a report from a country</h2>
        <p class="q">The share of a country's reports that show each type, with 95% Wilson intervals. The vertical line is the share across all countries. Each country is tested against all the others with a two-proportion z-test, Holm-corrected across all ${L.filter(c => Number.isFinite(c.p)).length} comparisons.</p>
        <div class="multiples" id="likeCharts">${comp.types.map(ty => `<div class="multiple"><h3>${swatch(ty)}${ty}<span class="sub">all: ${pct(pooled(ty))}</span></h3><div data-like="${ty}"></div></div>`).join('')}</div>
        <details class="card" style="margin-top:22px">
          <summary style="cursor:pointer;font-weight:600;font-size:13.5px">All one-vs-rest z-tests</summary>
          <div class="table-wrap" style="margin-top:12px"><table class="data">
            <thead><tr><th>${res.rows.length === 4 ? 'Country' : 'Coast'}</th><th>Type</th><th class="num">Reports</th><th class="num">Share</th><th class="num">95% CI</th><th class="num">Elsewhere</th><th class="num">z</th><th class="num">p</th><th class="num">Holm p</th></tr></thead>
            <tbody>${L.filter(c => comp.types.includes(c.type)).map(c => `<tr class="${c.pHolm < 0.05 ? 'sig' : ''}">
              <td>${rowLabel(c.row)}</td><td>${swatch(c.type)} ${c.type}</td><td class="num">${c.k} / ${c.n}</td><td class="num">${pct(c.share, 1)}</td>
              <td class="num">${pct(c.low, 1)} to ${pct(c.high, 1)}</td><td class="num">${pct(c.shareElsewhere, 1)}</td>
              <td class="num">${signed(c.z)}</td><td class="num">${pCell(c.p)}</td><td class="num ${c.pHolm < 0.05 ? 'sig' : 'ns'}">${pCell(c.pHolm)}</td></tr>`).join('')}</tbody>
          </table></div>
        </details>
      </section>

      <section class="doc-section" id="s-rates">
        <h2>3. How often each type is reported</h2>
        <p class="q">Reports per year over ${res.rates.window[0]}-${res.rates.window[1]}, the years with steady coverage, with exact Poisson 95% intervals. The last column turns the rate into the chance of at least one report in a given month.</p>
        <div class="table-wrap card" style="margin-top:22px"><table class="data">
          <thead><tr><th>${res.rows.length === 4 ? 'Country' : 'Coast'}</th>${comp.types.map(ty => `<th class="num">${swatch(ty)} ${ty} / yr</th>`).join('')}<th class="num">All types / yr</th><th class="num">P(any report in a month)</th></tr></thead>
          <tbody>${res.rows.map(row => `<tr><td>${rowLabel(row)}</td>${comp.types.map(ty => { const c = rateCell(row, ty); return `<td class="num">${fx(c.perYear, 1)} <span class="ns">(${fx(c.low, 1)}-${fx(c.high, 1)})</span></td>`; }).join('')}
            <td class="num">${fx(rateCell(row, 'All types').perYear, 1)}</td><td class="num">${pct(rateCell(row, 'All types').pMonth)}</td></tr>`).join('')}</tbody>
        </table></div>
        ${t && !t.error ? `
        <div class="multiples ${res.rows.length === 5 ? '' : ''}" id="trendCharts" style="grid-template-columns:repeat(${Math.min(res.rows.length, 5)}, minmax(0,1fr))">
          ${t.series.map((sr, i) => `<div class="multiple"><h3>${rowLabel(sr.row)}<span class="sub">${S.sum(sr.counts)} reports</span></h3><div data-trend="${i}"></div></div>`).join('')}
        </div>
        <p class="takeaway">Reports rise by a factor of ${fx(t.irr)} a year (95% CI ${fx(t.low)} to ${fx(t.high)}, ${pText(t.p)}), holding country fixed. The line is the fitted Poisson model; overdispersion (${fx(t.dispersion)}x) is absorbed by quasi-Poisson standard errors.</p>
        <p class="footnote">These are reporting rates, not animal abundance. A rising count mostly reflects more phones, more tourism and more social media, which is why the analysis compares countries within the same years rather than reading the trend as population growth.</p>` : ''}
      </section>

      <section class="doc-section" id="s-group">
        <h2>4. Group size: t-tests and their non-parametric checks</h2>
        <p class="q">Dolphin group sizes per report, on a log scale. Hollow circle: mean, with its 95% t-interval. Bar: median. Group sizes are skewed and ${pct(g.censoredShare)} are lower bounds ("more than 4"), so every t-test is repeated on log size and as a rank test.</p>
        <div class="card" style="margin-top:22px"><div id="stripChart"></div></div>
        ${g.main ? `<div class="callout">
          <div><div class="k">All dolphins, ${rowLabel(g.main.a)} vs Lebanon</div><div class="v">${pText(g.main.welch.p)}</div><div class="d">Mean ${fx(g.main.mean[0], 1)} vs ${fx(g.main.mean[1], 1)}, Welch t(${fx(g.main.welch.df, 0)}) = ${fx(g.main.welch.t)}</div></div>
          <div><div class="k">Egypt's two seas</div><div class="v">${g.coasts.map(c => `${Number.isFinite(c.median) ? c.median : 'n/a'}`).join(' vs ')}</div><div class="d">Median group: Mediterranean coast (n = ${g.coasts[0].n}) vs Red Sea (n = ${g.coasts[1].n})</div></div>
          ${g.bottlenose ? `<div><div class="k">Bottlenose only, ${rowLabel(g.bottlenose.a)} vs Lebanon</div><div class="v">${pText(g.bottlenose.logWelch.p)}</div><div class="d">Geometric mean ${fx(g.bottlenose.geoMean[0], 2)} vs ${fx(g.bottlenose.geoMean[1], 2)}, log-scale Welch t = ${fx(g.bottlenose.logWelch.t)}</div></div>` : '<div></div>'}
        </div>
        <p class="takeaway">Comparing all dolphins mixes different species: Red Sea spinner dolphins travel in large pods, which inflates Egypt's average. Holding species constant reverses the picture, a composition effect of the same kind as Simpson's paradox.</p>` : ''}
        <div class="split even" style="margin-top:22px">
          <div class="card"><h3>${g.main ? `${rowLabel(g.main.a)} vs Lebanon, all dolphins` : 'Two-sample tests'}</h3>
            ${g.main ? `<dl class="test-list">
              <dt>Welch t (raw)</dt><dd>t = ${fx(g.main.welch.t)}, df = ${fx(g.main.welch.df, 1)}, ${pText(g.main.welch.p)}</dd>
              <dt>Welch t (log)</dt><dd>t = ${fx(g.main.logWelch.t)}, ${pText(g.main.logWelch.p)}</dd>
              <dt>Mann-Whitney U</dt><dd>U = ${fx(g.main.mwu.U, 1)}, ${pText(g.main.mwu.p)}</dd>
              <dt>Hedges' g</dt><dd>${fx(g.main.hedgesG, 3)}</dd>
              ${g.bottlenose ? `<dt>Bottlenose, MWU</dt><dd>U = ${fx(g.bottlenose.mwu.U, 1)}, ${pText(g.bottlenose.mwu.p)}</dd>` : ''}
            </dl>` : '<p class="muted">Not enough reports for a two-sample test.</p>'}
          </div>
          <div class="card"><h3>All ${res.rows.length === 4 ? 'countries' : 'coasts'}</h3>
            ${g.kruskal ? `<dl class="test-list"><dt>Kruskal-Wallis</dt><dd>H = ${fx(g.kruskal.H)}, df = ${g.kruskal.dof}, ${pText(g.kruskal.p)}</dd></dl>` : ''}
            <div class="table-wrap" style="margin-top:10px"><table class="data">
              <thead><tr><th>Pair</th><th class="num">Medians</th><th class="num">MWU p</th><th class="num">Holm p</th></tr></thead>
              <tbody>${g.pairs.map(p => `<tr><td>${rowLabel(p.a)} vs ${rowLabel(p.b)}</td><td class="num">${p.medianA} vs ${p.medianB}</td><td class="num">${pCell(p.p)}</td><td class="num ${p.pHolm < 0.05 ? 'sig' : 'ns'}">${pCell(p.pHolm)}</td></tr>`).join('')}</tbody>
            </table></div>
          </div>
        </div>
      </section>

      <section class="doc-section" id="s-strandings">
        <h2>5. Strandings</h2>
        <p class="q">Share of reports that describe a stranded or dead animal. Each ${res.rows.length === 4 ? 'country' : 'coast'} is tested against the rest; the vertical line is the overall share (${pct(st.total / st.n, 1)}).</p>
        <div class="split">
          <div class="card"><div id="strandChart"></div></div>
          <div class="card"><h3>Tests</h3>
            <dl class="test-list">
              <dt>Any difference</dt><dd>Monte Carlo ${pText(st.pMC)}</dd>
              ${st.byRow.map(r => `<dt>${rowLabel(r.row)}</dt><dd>z = ${signed(r.z)}, Holm ${pText(r.pHolm)}</dd>`).join('')}
              ${st.fisher ? `<dt>Whales vs dolphins</dt><dd>OR = ${fx(st.fisher.oddsRatio)}, Fisher ${pText(st.fisher.p)}</dd>` : ''}
            </dl>
          </div>
        </div>
      </section>

      <section class="doc-section" id="s-season">
        <h2>6. When in the year reports come in</h2>
        <p class="q">Reports by month. The red line is what an even spread over the year would give, weighted by days in the month. June to August are shown darker.</p>
        <div class="multiples three" style="grid-template-columns:repeat(${res.seasonality.length}, minmax(0,1fr))">
          ${res.seasonality.map((s, i) => `<div class="multiple card"><h3>${s.country}<span class="sub">${s.n} dated reports</span></h3><div data-month="${i}"></div>
            <p class="footnote">Summer share ${pct(s.summerShare)} vs ${pct(s.summerExpected)} expected, exact binomial ${pText(s.summerP)}. Month-by-month &chi;&sup2;(11) = ${fx(s.chi2, 1)}, ${pText(s.p)}.</p></div>`).join('')}
        </div>
        <p class="footnote">Summer is when more people are on boats and beaches, so a seasonal peak in reports is partly observer effort. It cannot be separated from animal presence with this data.</p>
      </section>

      <section class="doc-section" id="s-limits">
        <h2>7. What this data can and cannot show</h2>
        <p class="q">These are opportunistic reports, not a survey with fixed effort. The tests below check two sources of bias that could create country differences on their own.</p>
        <div class="split even">
          <div class="card"><h3>Who was watching</h3>
            <div class="table-wrap"><table class="data">
              <thead><tr><th></th>${dq.platforms.map(p => `<th class="num">${p}</th>`).join('')}</tr></thead>
              <tbody>${dq.platformRows.map((row, i) => { const tot = S.sum(dq.platformTable[i]); return `<tr><td>${rowLabel(row)}</td>${dq.platformTable[i].map(v => `<td class="num">${pct(v / tot)}</td>`).join('')}</tr>`; }).join('')}</tbody>
            </table></div>
            <p class="footnote">Observer platform differs by country (Monte Carlo ${pText(dq.platformP)}, Cram&eacute;r's V = ${fx(dq.platformV)}). Swimmers and divers appear almost only in Egypt's Red Sea tourism, which favours reef-associated species.</p>
          </div>
          <div class="card"><h3>Missing species</h3>
            <div class="table-wrap"><table class="data">
              <thead><tr><th></th><th class="num">Not identified</th></tr></thead>
              <tbody>${dq.unidentified.filter(u => Number.isFinite(u.rate)).map(u => `<tr><td>${rowLabel(u.row)}</td><td class="num">${pct(u.rate)}</td></tr>`).join('')}</tbody>
            </table></div>
            <p class="footnote">The unidentified share does not differ by country (${pText(dq.unidentifiedP)}), so dropping those reports is unlikely to bias the country comparison. The "Infer from notes" setting above re-runs everything with them assigned from field notes.</p>
          </div>
        </div>
        <div class="methods">
          <div><h3>Selection</h3><p>A report exists only when someone films an animal and posts it. Tourism, coastline length, internet use and conflict all change who reports, which is why results are framed as "reported", not "present".</p></div>
          <div><h3>Independence</h3><p>Some posts show the same animal or pod, and a few records share a source link. Duplicates make p-values look smaller than they should be, so section 8 re-runs the main test with them removed.</p></div>
          <div><h3>Location</h3><p>Most coordinates are estimated from the place named in the post, so the map shows sites, not exact positions.</p></div>
          <div><h3>Duplicates and timing</h3><p>Reports cluster in recent years and in summer, so they are not a random sample of time either. The country comparison pools all years, which is fair only if reporting grew at a similar pace everywhere.</p></div>
        </div>
      </section>

      <section class="doc-section" id="s-robust">
        <h2>8. Robustness: does the country pattern survive?</h2>
        <p class="q">The composition test from section 1, re-run under seven specifications. If the conclusion depended on one coding choice, it would show up here.</p>
        <div class="table-wrap card" style="margin-top:22px"><table class="data" id="robustTable">
          <thead><tr><th>Specification</th><th class="num">Reports</th><th class="num">&chi;&sup2; (df)</th><th class="num">Monte Carlo p</th><th class="num">Cram&eacute;r's V</th><th class="num">z, Lebanon whales</th><th class="num">z, Egypt dolphins</th></tr></thead>
          <tbody><tr><td colspan="7" class="muted">Running six specifications...</td></tr></tbody>
        </table></div>
        <p class="footnote" id="robustNote"></p>
      </section>

      <section class="doc-section" id="s-methods">
        <h2>Methods and reproducibility</h2>
        <div class="methods">
          <div><h3>Composition</h3><p>Pearson chi-square test of independence on identified reports, with a Monte Carlo permutation p-value because half the expected counts are below 5. Effect size by Cram&eacute;r's V. Cells are read through Haberman's adjusted residuals with a Bonferroni threshold.</p></div>
          <div><h3>Proportions</h3><p>Wilson score intervals for each share. One-vs-rest two-proportion z-tests with pooled variance, Holm-corrected for the number of comparisons.</p></div>
          <div><h3>Rates and trend</h3><p>Exact (Garwood) Poisson intervals for reports per year. Trend from a Poisson regression of country-year counts on country and year, with quasi-Poisson standard errors; a negative binomial fit in the Python script gives the same conclusion.</p></div>
          <div><h3>Group size</h3><p>Welch's t-test on raw and log group size, Mann-Whitney U and Kruskal-Wallis as rank-based checks, Hedges' g for effect size. "More than n" values are treated as n, which biases group sizes down.</p></div>
        </div>
        <p class="footnote">Every figure on this page is computed in the browser from the loaded CSV (assets/stats.js, assets/analysis.js). The same analysis runs in Python with pandas, SciPy and statsmodels: <span class="code">python analysis/marine_mammal_stats.py</span>. A test script checks that both give the same numbers: <span class="code">node tests/validate_against_python.js</span>.</p>
      </section>`;

    // charts
    comp.types.forEach(ty => {
      const host = document.querySelector(`[data-like="${CSS.escape(ty)}"]`);
      const rows = res.rows.map(row => {
        const c = L.find(x => x.row === row && x.type === ty);
        return { label: rowLabel(row), value: c.share, low: c.low, high: c.high, strong: c.pHolm < 0.05,
          tip: C.tipRows(`${rowLabel(row)}: ${ty}`, [['Reports', `${c.k} of ${c.n}`], ['Share', pct(c.share, 1)], ['95% CI', `${pct(c.low, 1)} to ${pct(c.high, 1)}`], ['Elsewhere', pct(c.shareElsewhere, 1)], ['z', signed(c.z)], ['Holm p', pCell(c.pHolm)]]) };
      });
      const maxHigh = Math.max(...rows.map(r => r.high));
      C.ciRows(host, rows, { ref: pooled(ty), color: TYPE_COLOR[ty], max: maxHigh > 0.5 ? 1 : C.niceMax(maxHigh), labelW: res.rows.length === 5 ? 92 : 64, label: `Share of reports that are ${TYPE_PLURAL[ty]}` });
    });
    if (t && !t.error) {
      const max = C.niceMax(Math.max(...t.series.flatMap(s => s.counts)));
      t.series.forEach((sr, i) => C.miniColumns(document.querySelector(`[data-trend="${i}"]`), sr.counts, t.years, { max, fitted: sr.fitted, color: 'var(--ink-4)', label: `Reports per year, ${sr.row}` }));
    }
    C.strip($('#stripChart'), g.summary.map(s => ({ ...s, label: rowLabel(s.row) })), { color: 'var(--t-dolphin)', labelW: 130, label: 'Dolphin group size by country' });
    const overall = st.total / st.n;
    C.ciRows($('#strandChart'), st.byRow.map(r => ({
      label: rowLabel(r.row), value: r.rate, low: r.low, high: r.high, strong: r.pHolm < 0.05,
      tip: C.tipRows(rowLabel(r.row), [['Stranded', `${r.k} of ${r.n}`], ['Share', pct(r.rate, 1)], ['95% CI', `${pct(r.low, 1)} to ${pct(r.high, 1)}`], ['Holm p', pCell(r.pHolm)]]),
    })), { ref: overall, color: 'var(--s-stranded)', max: C.niceMax(Math.max(...st.byRow.map(r => r.high))), labelW: 110, rowH: 30, label: 'Stranding share by country' });
    res.seasonality.forEach((s, i) => {
      const days = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31], tot = S.sum(days);
      C.months(document.querySelector(`[data-month="${i}"]`), s.months, days.map(d => s.n * d / tot), { label: `Reports by month, ${s.country}` });
    });
    $$('#aBody td.cell').forEach(td => C.bindTip(td, td.dataset.tip));
    paintRobustness();
  }

  let robustCache = null;
  function paintRobustness() {
    const key = state.analysisRuns;
    const draw = rows => {
      const crit = rows[0].crit;
      $('#robustTable tbody').innerHTML = rows.map((r, i) => `<tr class="${i === 0 ? 'sig' : ''}"><td>${esc(r.label)}</td>
        <td class="num">${r.n}</td><td class="num">${fx(r.chi2, 1)} (${r.dof})</td><td class="num">${pCell(r.pMC)}</td><td class="num">${fx(r.v, 3)}</td>
        <td class="num ${Math.abs(r.zLebanonWhale) >= r.crit ? 'sig' : 'ns'}">${signed(r.zLebanonWhale)}</td>
        <td class="num ${Math.abs(r.zEgyptDolphin) >= r.crit ? 'sig' : 'ns'}">${signed(r.zEgyptDolphin)}</td></tr>`).join('');
      const holds = rows.every(r => r.pMC < 0.05);
      $('#robustNote').textContent = (holds
        ? `The association is significant in all ${rows.length} specifications, and its strength barely moves (Cram\u00E9r's V ${fx(Math.min(...rows.map(r => r.v)), 2)} to ${fx(Math.max(...rows.map(r => r.v)), 2)}).`
        : `The association is not significant in every specification, so treat it with care.`) +
        ` Bold z-scores pass the Bonferroni threshold (|z| \u2265 ${fx(crit)}); the Egypt column uses the Mediterranean coast when Egypt is split.`;
    };
    if (robustCache && robustCache.key === key) { draw(robustCache.rows); return; }
    setTimeout(() => {
      const rows = A.robustness(state.records, 5000);
      robustCache = { key, rows };
      if ($('#robustTable')) draw(rows);
    }, 30);
  }

  // ---- report ------------------------------------------------------------------------------------------------
  function renderReport() {
    const view = $('#view-report');
    if (!state.records.length) { view.innerHTML = '<div class="doc"><p class="muted">Load a CSV to build the report.</p></div>'; return; }
    const res = getAnalysis({ ...A.DEFAULTS });
    const recs = state.records;
    const species = {};
    recs.forEach(r => { if (r.speciesKey) species[r.speciesKey] = (species[r.speciesKey] || 0) + 1; });
    const top = Object.entries(species).sort((a, b) => b[1] - a[1]);
    const identified = recs.filter(r => r.species).length;
    const years = recs.map(r => r.year).filter(Boolean);
    const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    const findings = buildFindings(res).slice(0, 5);
    const countries = D.COUNTRIES.filter(c => recs.some(r => r.country === c));
    view.innerHTML = `<div class="doc report">
      <header class="doc-head">
        <div>
          <h1>Marine mammal sightings in the Levant, ${Math.min(...years)}-${Math.max(...years)}</h1>
          <p class="lead">Summary of ${recs.length} public reports from ${listJoin(countries)}, compiled for IMMRAC. Generated ${today}.</p>
        </div>
        <div class="report-actions"><button class="btn btn-primary" id="printBtn"><i class="ph ph-printer" aria-hidden="true"></i>Print or save as PDF</button></div>
      </header>
      <div class="report-kpis">
        <div><div class="kpi-label">Reports</div><div class="kpi-value">${recs.length}</div><div class="kpi-sub">${pct(recs.filter(r => r.coords).length / recs.length)} with coordinates</div></div>
        <div><div class="kpi-label">Identified to species</div><div class="kpi-value">${identified}</div><div class="kpi-sub">${pct(identified / recs.length)} of reports</div></div>
        <div><div class="kpi-label">Species</div><div class="kpi-value">${top.length}</div><div class="kpi-sub">in ${new Set(top.map(([k]) => D.SPECIES[k].type)).size} types</div></div>
        <div><div class="kpi-label">Stranded</div><div class="kpi-value">${recs.filter(r => r.stranded).length}</div><div class="kpi-sub">${pct(recs.filter(r => r.stranded).length / recs.length, 1)} of reports</div></div>
        <div><div class="kpi-label">High credibility</div><div class="kpi-value">${recs.filter(r => r.credibility === 'high').length}</div><div class="kpi-sub">${pct(recs.filter(r => r.credibility === 'high').length / recs.length)} of reports</div></div>
      </div>

      <section class="doc-section">
        <h2>Key findings</h2>
        <div class="findings" style="padding-top:12px">${findings.map((f, i) => `<div class="finding"><span class="idx">${String(i + 1).padStart(2, '0')}</span><p>${f.text}<span class="stat">${statHtml(f.stat)}</span></p></div>`).join('')}</div>
      </section>

      <section class="doc-section">
        <h2>Species mix by country</h2>
        <div class="split">
          <div class="card">
            <h3>Share of identified reports</h3>
            <div class="legend-inline" style="margin-bottom:14px">${D.TYPES.map(t => `<span>${swatch(t)}${t}</span>`).join('')}</div>
            <div class="stack-bars">${res.composition.rows.map((row, i) => {
              const tot = S.sum(res.composition.table[i]);
              return `<div class="stack-row"><span>${rowLabel(row)}</span><div class="stack">${res.composition.types.map((ty, j) => {
                const v = res.composition.table[i][j];
                return v ? `<i style="width:${(v / tot * 100).toFixed(2)}%;background:${TYPE_COLOR[ty]}" title="${ty}: ${v} (${pct(v / tot)})"></i>` : '';
              }).join('')}</div><span class="mono muted" style="text-align:right">${tot}</span></div>`;
            }).join('')}</div>
            <p class="footnote">Chi-square test of independence: &chi;&sup2;(${res.composition.dof}) = ${fx(res.composition.chi2, 1)}, Monte Carlo ${pText(res.composition.pMC)}, Cram&eacute;r's V = ${fx(res.composition.cramersV)}.</p>
          </div>
          <div class="card"><h3>Reports per year</h3><div id="rptYears"></div></div>
        </div>
      </section>

      <section class="doc-section">
        <h2>Most reported species</h2>
        <div class="table-wrap card" style="margin-top:16px"><table class="data">
          <thead><tr><th>Species</th><th>Type</th><th class="num">Reports</th><th class="num">Share</th>${countries.map(c => `<th class="num">${c}</th>`).join('')}<th>IUCN (global)</th></tr></thead>
          <tbody>${top.map(([k, n]) => { const s = D.SPECIES[k]; return `<tr><td>${esc(s.common)} <span class="muted"><i>${esc(s.latin)}</i></span></td><td>${swatch(s.type)} ${s.type}</td><td class="num">${n}</td><td class="num">${pct(n / identified, 1)}</td>
            ${countries.map(c => `<td class="num">${recs.filter(r => r.speciesKey === k && r.country === c).length || '<span class="ns">0</span>'}</td>`).join('')}<td>${D.IUCN[s.iucn]}</td></tr>`; }).join('')}</tbody>
          <tfoot><tr><td colspan="${5 + countries.length}">${recs.length - identified} further reports could not be identified to species and are left out of this table.</td></tr></tfoot>
        </table></div>
      </section>

      <section class="doc-section">
        <h2>Method and caveats</h2>
        <div class="methods">
          <div><h3>Data</h3><p>Reports were gathered from social media, news sites and iNaturalist, then coded for species, status, place, date, group size, observer platform and credibility. Every record links back to its original post.</p></div>
          <div><h3>Analysis</h3><p>Country differences were tested with chi-square and Monte Carlo exact tests, z-tests for proportions (Holm-corrected), Welch t-tests and rank tests for group size, and Poisson models for reporting rates. Full detail is in the Analysis tab.</p></div>
          <div><h3>Reading the results</h3><p>All counts describe reports, not populations. Reporting effort differs by country, season and year, so differences are about what people see and post.</p></div>
          <div><h3>Reproducibility</h3><p>The Python script <span class="code">analysis/marine_mammal_stats.py</span> rebuilds every table from the CSV, and the dashboard's own statistics are tested against it.</p></div>
        </div>
      </section>
    </div>`;
    $('#printBtn').onclick = () => window.print();
    const { data } = yearSeries(recs);
    C.columns($('#rptYears'), data, { height: 180, id: 'r', label: 'Reports per year' });
  }

  // ---- loading data --------------------------------------------------------------------------------------------
  function loadText(text, name, { silent = false } = {}) {
    let parsed;
    try { parsed = D.loadRecords(text); } catch (e) { toast(`Could not read ${name}: ${e.message}`, true); return false; }
    if (!parsed.records.length) { toast(`${name} has no usable rows.`, true); return false; }
    state.records = parsed.records;
    state.dataset = name;
    state.filters = { country: null, type: null, species: null, status: null };
    state.site = null; state.record = null;
    state.analysisRuns++;
    state.analysis = null;
    $('#aboutData').textContent = `${parsed.records.length} reports, ${name}`;
    renderPanelFoot();
    applyFilters({ refit: false, animate: !silent });
    fitToSites(!silent);
    if (state.view === 'analysis') renderAnalysis();
    if (state.view === 'report') renderReport();
    if (!silent) toast(`Loaded ${plural(parsed.records.length, 'report', 'reports')} from ${name}`);
    return true;
  }
  function readFile(file) {
    if (!file) return;
    if (!/\.csv$/i.test(file.name) && file.type !== 'text/csv') { toast('Please choose a .csv file.', true); return; }
    const reader = new FileReader();
    reader.onload = e => loadText(String(e.target.result), file.name);
    reader.onerror = () => toast(`Could not read ${file.name}.`, true);
    reader.readAsText(file);
  }

  // ---- wiring ----------------------------------------------------------------------------------------------------
  function wire() {
    $$('.tab').forEach(t => { t.onclick = () => showView(t.dataset.view); });
    $('.brand').onclick = e => { e.preventDefault(); showView('map'); };
    window.addEventListener('hashchange', () => showView(location.hash.slice(1), { push: false }));

    $('#typeBtn').onclick = e => { e.stopPropagation(); $('#catalog').hidden ? openCatalog() : closeCatalog(); };
    document.addEventListener('click', e => {
      if (!$('#catalog').hidden && !$('#catalog').contains(e.target) && e.target !== $('#typeBtn')) closeCatalog();
      if (!$('#search').contains(e.target) && e.target.closest('#searchToggle') == null) { $('#searchResults').hidden = true; $('#search').classList.remove('open'); }
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { closeCatalog(); $('#searchResults').hidden = true; $('#search').classList.remove('open'); C.tip.hide(); }
      if (e.key === '/' && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); $('#searchInput').focus(); }
    });
    $('#clearFilters').onclick = clearFilters;

    const input = $('#searchInput');
    input.addEventListener('input', debounce(() => { searchActive = 0; renderSearch(); }, 90));
    input.addEventListener('focus', () => { if (input.value) renderSearch(); });
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); searchActive = Math.min(searchItems.length - 1, searchActive + 1); renderSearch(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); searchActive = Math.max(0, searchActive - 1); renderSearch(); }
      if (e.key === 'Enter') { e.preventDefault(); chooseSearch(Math.max(0, searchActive)); }
    });
    $('#searchToggle').onclick = () => { $('#search').classList.toggle('open'); input.focus(); };

    $('#csvBtn').onclick = () => $('#csvInput').click();
    $('#csvInput').addEventListener('change', e => { readFile(e.target.files[0]); e.target.value = ''; });
    let dragDepth = 0;
    window.addEventListener('dragenter', e => { if ([...(e.dataTransfer.types || [])].includes('Files')) { dragDepth++; $('#dropzone').hidden = false; } });
    window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropzone').hidden = true; });
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; $('#dropzone').hidden = true; readFile(e.dataTransfer.files[0]); });

    $('#themeBtn').onclick = toggleTheme;
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyThemeChrome);
    const about = $('#about');
    $('#aboutBtn').onclick = () => about.showModal();
    $('#aboutClose').onclick = () => about.close();
    about.addEventListener('click', e => { if (e.target === about) about.close(); });

    const rerender = debounce(() => {
      if (state.view === 'map') renderYearChart();
      if (state.view === 'analysis' && state.analysis) paintAnalysis(state.analysis);
      if (state.view === 'report') renderReport();
    }, 150);
    new ResizeObserver(rerender).observe(document.body);
  }

  function init() {
    wire();
    initMap();
    applyThemeChrome();
    const emb = window.MP_EMBEDDED;
    if (emb && emb.csv) loadText(emb.csv, emb.name, { silent: true });
    showView(location.hash.slice(1) || 'map', { push: false });
  }
  document.addEventListener('DOMContentLoaded', init);
})();
