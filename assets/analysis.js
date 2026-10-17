/* MarinePulse analysis: the research design from analysis/marine_mammal_stats.py,
   recomputed in the browser so it follows whatever CSV is loaded and the
   robustness options picked in the Analysis view. Pure: records in, results out. */
(function (root) {
  'use strict';
  const S = typeof module !== 'undefined' ? require('./stats.js') : root.MPStats;
  const D = typeof module !== 'undefined' ? require('./data.js') : root.MPData;

  const TYPES = D.TYPES;
  const COUNTRY_ROWS = ['Lebanon', 'Syria', 'Gaza', 'Egypt'];
  const COAST_ROWS = ['Lebanon', 'Syria', 'Gaza', 'Egypt (Mediterranean)', 'Egypt (Red Sea)'];
  const RATE_WINDOW = [2019, 2025];
  const TREND_WINDOW = [2015, 2025];
  const DAYS = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  const DEFAULTS = { sample: 'all', egypt: 'country', delphinids: 'Whale', unidentified: 'exclude', draws: 20000 };

  function prepare(records, opt) {
    let rs = records;
    if (opt.sample === 'high') rs = rs.filter(r => r.credibility === 'high');
    if (opt.dedupe) {
      const seen = new Set();
      rs = rs.filter(r => {
        if (!r.sourceKey) return true;
        if (seen.has(r.sourceKey)) return false;
        seen.add(r.sourceKey);
        return true;
      });
    }
    return rs.map(r => {
      let type = opt.unidentified === 'notes' ? r.typeFromNotes : r.type;
      if (opt.delphinids === 'Dolphin' && r.species && r.species.delphinid) type = 'Dolphin';
      const row = opt.egypt === 'coast' ? r.coast : r.country;
      return { ...r, aType: type, aRow: row };
    });
  }

  function composition(rs, rows, draws) {
    const d = rs.filter(r => rows.includes(r.aRow) && TYPES.includes(r.aType));
    const types = TYPES.filter(t => d.some(r => r.aType === t));
    const liveRows = rows.filter(row => d.some(r => r.aRow === row));
    const table = liveRows.map(row => types.map(t => d.filter(r => r.aRow === row && r.aType === t).length));
    const test = S.chi2Independence(table);
    const rIdx = d.map(r => liveRows.indexOf(r.aRow));
    const cIdx = d.map(r => types.indexOf(r.aType));
    const pMC = S.monteCarloIndependence(rIdx, cIdx, liveRows.length, types.length, draws);
    return { rows: liveRows, types, table, ...test, pMC };
  }

  function likelihood(rs, rows) {
    const d = rs.filter(r => rows.includes(r.aRow) && TYPES.includes(r.aType));
    const cells = [];
    rows.forEach(row => {
      const inRow = d.filter(r => r.aRow === row), rest = d.filter(r => r.aRow !== row);
      TYPES.forEach(t => {
        const k = inRow.filter(r => r.aType === t).length;
        const kr = rest.filter(r => r.aType === t).length;
        const n = inRow.length, nr = rest.length;
        const degenerate = k + kr === 0 || k + kr === n + nr || !n || !nr;
        const z = degenerate ? { z: NaN, p: NaN } : S.twoProportionZ(k, n, kr, nr);
        const [lo, hi] = S.wilson(k, n);
        cells.push({ row, type: t, k, n, share: n ? k / n : NaN, low: lo, high: hi,
          shareElsewhere: nr ? kr / nr : NaN, z: z.z, p: z.p });
      });
    });
    const adj = S.holm(cells.map(c => c.p));
    cells.forEach((c, i) => { c.pHolm = adj[i]; });
    return cells;
  }

  function rates(rs, rows) {
    const [y0, y1] = RATE_WINDOW, years = y1 - y0 + 1;
    const d = rs.filter(r => r.year >= y0 && r.year <= y1);
    const out = [];
    rows.forEach(row => {
      [...TYPES, 'All types'].forEach(t => {
        const k = d.filter(r => r.aRow === row && (t === 'All types' || r.aType === t)).length;
        const lam = k / years;
        const [lo, hi] = S.poissonCI(k, years);
        out.push({ row, type: t, reports: k, perYear: lam, low: lo, high: hi, pMonth: 1 - Math.exp(-lam / 12) });
      });
    });
    return { window: RATE_WINDOW, years, cells: out };
  }

  function trend(rs, rows) {
    const [y0, y1] = TREND_WINDOW;
    const X = [], y = [];
    const base = rows[0];
    rows.forEach(row => {
      for (let yr = y0; yr <= y1; yr++) {
        y.push(rs.filter(r => r.aRow === row && r.year === yr).length);
        X.push([1, ...rows.slice(1).map(o => (o === row ? 1 : 0)), yr - 2020]);
      }
    });
    try {
      const fit = S.poissonRegression(X, y);
      const j = fit.beta.length - 1, b = fit.beta[j], se = fit.seQuasi[j];
      const z = b / se;
      return {
        window: TREND_WINDOW, observations: y.length, dispersion: fit.dispersion,
        irr: Math.exp(b), low: Math.exp(b - S.Z95 * se), high: Math.exp(b + S.Z95 * se),
        p: 2 * S.normSf(Math.abs(z)), base,
        rowIRR: rows.slice(1).map((row, i) => ({ row, irr: Math.exp(fit.beta[i + 1]) })),
        years: Array.from({ length: y1 - y0 + 1 }, (_, i) => y0 + i),
        series: rows.map((row, ri) => ({
          row,
          counts: y.slice(ri * (y1 - y0 + 1), (ri + 1) * (y1 - y0 + 1)),
          fitted: fit.fitted.slice(ri * (y1 - y0 + 1), (ri + 1) * (y1 - y0 + 1)),
        })),
      };
    } catch (e) {
      return { error: 'Not enough data to fit the trend model.' };
    }
  }

  function groupSize(rs, rows) {
    const dol = rs.filter(r => r.aType === 'Dolphin' && r.groupSize != null);
    const by = {};
    rows.forEach(row => { by[row] = dol.filter(r => r.aRow === row).map(r => r.groupSize); });
    const summary = rows.filter(row => by[row].length >= 2).map(row => {
      const x = by[row], ci = S.meanCI(x);
      return { row, n: x.length, mean: ci.mean, low: ci.low, high: ci.high,
        median: S.median(x), shareSolitary: x.filter(v => v === 1).length / x.length, values: x };
    });
    const egyptKey = rows.includes('Egypt') ? 'Egypt' : 'Egypt (Mediterranean)';
    const a = by[egyptKey] || [], b = by.Lebanon || [];
    let main = null;
    if (a.length >= 3 && b.length >= 3) {
      const w = S.welchT(a, b), wl = S.welchT(a.map(Math.log), b.map(Math.log)), u = S.mannWhitney(a, b);
      main = { a: egyptKey, b: 'Lebanon', n: [a.length, b.length], mean: [S.mean(a), S.mean(b)],
        median: [S.median(a), S.median(b)],
        geoMean: [Math.exp(S.mean(a.map(Math.log))), Math.exp(S.mean(b.map(Math.log)))],
        welch: w, logWelch: wl, mwu: u, hedgesG: S.hedgesG(a, b) };
    }
    const live = summary.map(s => s.values);
    const kw = live.length >= 2 ? S.kruskal(live) : null;
    const pairs = [];
    for (let i = 0; i < summary.length; i++)
      for (let j = i + 1; j < summary.length; j++) {
        const u = S.mannWhitney(summary[i].values, summary[j].values);
        pairs.push({ a: summary[i].row, b: summary[j].row, medianA: summary[i].median, medianB: summary[j].median, U: u.U, p: u.p });
      }
    const adj = S.holm(pairs.map(p => p.p));
    pairs.forEach((p, i) => { p.pHolm = adj[i]; });

    // Same species on both coasts: common bottlenose only
    const tt = rs.filter(r => r.speciesKey === 'tursiops truncatus' && r.groupSize != null);
    const ta = tt.filter(r => r.aRow === egyptKey).map(r => r.groupSize);
    const tb = tt.filter(r => r.aRow === 'Lebanon').map(r => r.groupSize);
    let bottlenose = null;
    if (ta.length >= 3 && tb.length >= 3) {
      bottlenose = { a: egyptKey, n: [ta.length, tb.length], mean: [S.mean(ta), S.mean(tb)],
        median: [S.median(ta), S.median(tb)],
        geoMean: [Math.exp(S.mean(ta.map(Math.log))), Math.exp(S.mean(tb.map(Math.log)))],
        welch: S.welchT(ta, tb), logWelch: S.welchT(ta.map(Math.log), tb.map(Math.log)), mwu: S.mannWhitney(ta, tb) };
    }
    // Egypt's two seas, whatever the row option
    const coasts = ['Egypt (Mediterranean)', 'Egypt (Red Sea)'].map(c => {
      const x = dol.filter(r => r.coast === c).map(r => r.groupSize);
      return { coast: c, n: x.length, mean: x.length ? S.mean(x) : NaN, median: x.length ? S.median(x) : NaN };
    });
    return { summary, main, kruskal: kw, pairs, bottlenose, coasts,
      censoredShare: dol.length ? dol.filter(r => r.groupCensored).length / dol.length : 0 };
  }

  function strandings(rs, rows, draws) {
    const d = rs.filter(r => rows.includes(r.aRow));
    const byRow = rows.map(row => {
      const inRow = d.filter(r => r.aRow === row), rest = d.filter(r => r.aRow !== row);
      const k = inRow.filter(r => r.stranded).length, kr = rest.filter(r => r.stranded).length;
      const z = S.twoProportionZ(k, inRow.length, kr, rest.length);
      const [lo, hi] = S.wilson(k, inRow.length);
      return { row, k, n: inRow.length, rate: k / inRow.length, low: lo, high: hi,
        rateElsewhere: kr / rest.length, z: z.z, p: z.p };
    }).filter(r => r.n > 0);
    const adj = S.holm(byRow.map(r => r.p));
    byRow.forEach((r, i) => { r.pHolm = adj[i]; });
    const liveRows = byRow.map(r => r.row);
    const pMC = S.monteCarloIndependence(d.map(r => liveRows.indexOf(r.aRow)), d.map(r => (r.stranded ? 1 : 0)), liveRows.length, 2, draws);
    const ident = d.filter(r => TYPES.includes(r.aType));
    const byType = TYPES.map(t => {
      const x = ident.filter(r => r.aType === t), k = x.filter(r => r.stranded).length;
      const [lo, hi] = S.wilson(k, x.length);
      return { type: t, k, n: x.length, rate: x.length ? k / x.length : NaN, low: lo, high: hi };
    });
    const wh = ident.filter(r => r.aType === 'Whale'), dl = ident.filter(r => r.aType === 'Dolphin');
    const ws = wh.filter(r => r.stranded).length, ds = dl.filter(r => r.stranded).length;
    const fisher = wh.length && dl.length ? S.fisherExact(ws, wh.length - ws, ds, dl.length - ds) : null;
    return { byRow, pMC, total: d.filter(r => r.stranded).length, n: d.length, byType, fisher };
  }

  function seasonality(rs) {
    return ['Lebanon', 'Egypt'].map(c => {
      const months = new Array(12).fill(0);
      rs.filter(r => r.country === c && r.month).forEach(r => { months[r.month - 1]++; });
      const n = S.sum(months);
      if (n < 12) return null;
      const daysTotal = S.sum(DAYS);
      const gof = S.chi2GoodnessOfFit(months, DAYS.map(dd => n * dd / daysTotal));
      const summer = months[5] + months[6] + months[7];
      const pSummer = (DAYS[5] + DAYS[6] + DAYS[7]) / daysTotal;
      return { country: c, n, months, ...gof, peak: months.indexOf(Math.max(...months)) + 1,
        summerShare: summer / n, summerExpected: pSummer, summerP: S.binomTest(summer, n, pSummer) };
    }).filter(Boolean);
  }

  function dataQuality(rs, rows, draws) {
    const d = rs.filter(r => rows.includes(r.aRow));
    const unid = rows.map(row => {
      const x = d.filter(r => r.aRow === row);
      return [x.filter(r => r.aType !== 'Unidentified').length, x.filter(r => r.aType === 'Unidentified').length];
    }).filter(([a, b]) => a + b > 0);
    const unidTest = unid.every(([, b]) => b >= 0) && unid.length > 1 ? S.chi2Independence(unid) : null;
    const platforms = ['Vessel', 'Shore', 'In water', 'Small craft', 'Not stated'];
    const pTable = rows.map(row => platforms.map(p => d.filter(r => r.aRow === row && r.platform === p).length));
    const livePlatforms = platforms.filter((_, j) => pTable.some(r => r[j] > 0));
    const pT = pTable.map(r => livePlatforms.map(p => r[platforms.indexOf(p)])).filter(r => S.sum(r) > 0);
    const liveRows = rows.filter((_, i) => S.sum(pTable[i]) > 0);
    const pMC = S.monteCarloIndependence(
      d.map(r => liveRows.indexOf(r.aRow)), d.map(r => livePlatforms.indexOf(r.platform)),
      liveRows.length, livePlatforms.length, Math.min(draws, 20000));
    return {
      unidentified: rows.map((row, i) => ({ row, rate: unid[i] ? unid[i][1] / (unid[i][0] + unid[i][1]) : NaN })),
      unidentifiedP: unidTest ? unidTest.p : NaN,
      platforms: livePlatforms, platformTable: pT, platformRows: liveRows,
      platformP: pMC, platformV: S.chi2Independence(pT).cramersV,
    };
  }

  function run(records, options = {}) {
    const opt = { ...DEFAULTS, ...options };
    const rs = prepare(records, opt);
    const rows = opt.egypt === 'coast' ? COAST_ROWS : COUNTRY_ROWS;
    const used = rs.filter(r => rows.includes(r.aRow));
    const years = used.map(r => r.year).filter(Boolean);
    return {
      options: opt, rows,
      sample: {
        records: used.length,
        identified: used.filter(r => TYPES.includes(r.aType)).length,
        excludedCoasts: rs.length - used.length,
        firstYear: Math.min(...years), lastYear: Math.max(...years),
      },
      composition: composition(rs, rows, opt.draws),
      likelihood: likelihood(rs, rows),
      rates: rates(rs, rows),
      trend: trend(rs, rows),
      groupSize: groupSize(rs, rows),
      strandings: strandings(rs, rows, opt.draws),
      seasonality: seasonality(rs),
      dataQuality: dataQuality(rs, rows, opt.draws),
    };
  }

  /** The composition test re-run under each alternative specification. */
  function robustness(records, draws = 5000) {
    const specs = [
      { label: 'Main specification', opt: {} },
      { label: 'High-credibility records only', opt: { sample: 'high' } },
      { label: 'Orca and false killer whale as dolphins', opt: { delphinids: 'Dolphin' } },
      { label: 'Unidentified reports assigned from notes', opt: { unidentified: 'notes' } },
      { label: 'Egypt split into Mediterranean and Red Sea', opt: { egypt: 'coast' } },
      { label: 'Mediterranean coasts only', opt: { egypt: 'coast' }, rows: ['Lebanon', 'Syria', 'Gaza', 'Egypt (Mediterranean)'] },
      { label: 'Possible duplicate posts removed', opt: { dedupe: true } },
    ];
    return specs.map(s => {
      const opt = { ...DEFAULTS, ...s.opt };
      const rs = prepare(records, opt);
      const rows = s.rows || (opt.egypt === 'coast' ? COAST_ROWS : COUNTRY_ROWS);
      const c = composition(rs, rows, draws);
      const z = (row, t) => {
        const i = c.rows.indexOf(row), j = c.types.indexOf(t);
        return i >= 0 && j >= 0 ? c.adjResid[i][j] : NaN;
      };
      const egypt = c.rows.includes('Egypt') ? 'Egypt' : 'Egypt (Mediterranean)';
      return { label: s.label, n: c.n, chi2: c.chi2, dof: c.dof, pMC: c.pMC, v: c.cramersV,
        zLebanonWhale: z('Lebanon', 'Whale'), zEgyptDolphin: z(egypt, 'Dolphin'), crit: c.bonferroniZ };
    });
  }

  const api = { run, robustness, DEFAULTS, COUNTRY_ROWS, COAST_ROWS, RATE_WINDOW };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MPAnalysis = api;
})(typeof window !== 'undefined' ? window : globalThis);
