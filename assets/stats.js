/* MarinePulse statistics library.
   Small, dependency-free implementations of the tests used in the Analysis view.
   Each function matches the SciPy / statsmodels default it is named after;
   tests/stats.test.js checks them against analysis/output/results.json. */
(function (root) {
  'use strict';

  const EPS = 1e-15, FPMIN = 1e-300;

  // ---- special functions --------------------------------------------------
  const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];

  function logGamma(x) {
    if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - logGamma(1 - x);
    x -= 1;
    let a = LANCZOS[0];
    const t = x + 7.5;
    for (let i = 1; i < 9; i++) a += LANCZOS[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  }

  function gammaSeries(a, x) {
    let ap = a, sum = 1 / a, del = sum;
    for (let n = 0; n < 1000; n++) {
      ap += 1; del *= x / ap; sum += del;
      if (Math.abs(del) < Math.abs(sum) * EPS) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
  }

  function gammaContinuedFraction(a, x) {
    let b = x + 1 - a, c = 1 / FPMIN, d = 1 / b, h = d;
    for (let i = 1; i < 1000; i++) {
      const an = -i * (i - a);
      b += 2;
      d = an * d + b; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = b + an / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < EPS) break;
    }
    return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
  }

  /** Regularized lower incomplete gamma P(a, x). */
  function gammaP(a, x) {
    if (x <= 0) return 0;
    return x < a + 1 ? gammaSeries(a, x) : 1 - gammaContinuedFraction(a, x);
  }
  /** Regularized upper incomplete gamma Q(a, x), accurate in the tail. */
  function gammaQ(a, x) {
    if (x <= 0) return 1;
    return x < a + 1 ? 1 - gammaSeries(a, x) : gammaContinuedFraction(a, x);
  }

  function betaContinuedFraction(a, b, x) {
    const qab = a + b, qap = a + 1, qam = a - 1;
    let c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    let h = d;
    for (let m = 1; m < 1000; m++) {
      const m2 = 2 * m;
      let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d; h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < EPS) break;
    }
    return h;
  }

  /** Regularized incomplete beta I_x(a, b). */
  function betaI(a, b, x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    return x < (a + 1) / (a + b + 2)
      ? bt * betaContinuedFraction(a, b, x) / a
      : 1 - bt * betaContinuedFraction(b, a, 1 - x) / b;
  }

  // ---- distributions --------------------------------------------------------
  /** Upper tail of the standard normal, P(Z > z). */
  function normSf(z) {
    if (z < 0) return 1 - normSf(-z);
    return 0.5 * gammaQ(0.5, z * z / 2);
  }
  const normCdf = z => 1 - normSf(z);

  /** Inverse standard normal CDF (Acklam, refined with one Halley step). */
  function normInv(p) {
    if (p <= 0) return -Infinity;
    if (p >= 1) return Infinity;
    const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
    const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
    const lo = 0.02425;
    let q, r, x;
    if (p < lo) {
      q = Math.sqrt(-2 * Math.log(p));
      x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    } else if (p <= 1 - lo) {
      q = p - 0.5; r = q * q;
      x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
    } else {
      q = Math.sqrt(-2 * Math.log(1 - p));
      x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    const e = normCdf(x) - p;
    const u = e * Math.sqrt(2 * Math.PI) * Math.exp(x * x / 2);
    return x - u / (1 + x * u / 2);
  }

  const chi2Sf = (x, k) => gammaQ(k / 2, x / 2);

  /** Two-sided-safe upper tail of Student's t, P(T > t). */
  function tSf(t, df) {
    const tail = 0.5 * betaI(df / 2, 0.5, df / (df + t * t));
    return t >= 0 ? tail : 1 - tail;
  }

  function bisect(f, lo, hi, iters = 200) {
    for (let i = 0; i < iters; i++) {
      const mid = (lo + hi) / 2;
      if (f(mid) > 0) hi = mid; else lo = mid;
    }
    return (lo + hi) / 2;
  }

  function chi2Inv(p, k) {
    let hi = k + 10 * Math.sqrt(2 * k) + 50;
    while (gammaP(k / 2, hi / 2) < p) hi *= 2;
    return bisect(x => gammaP(k / 2, x / 2) - p, 0, hi);
  }

  function tInv(p, df) {
    // p is a lower-tail probability > 0.5
    return bisect(t => (1 - tSf(t, df)) - p, 0, 1e3);
  }

  // ---- descriptives -------------------------------------------------------------
  const sum = xs => xs.reduce((s, x) => s + x, 0);
  const mean = xs => sum(xs) / xs.length;
  function variance(xs) {
    const m = mean(xs);
    return xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1);
  }
  const sd = xs => Math.sqrt(variance(xs));
  function quantile(xs, q) {
    const s = [...xs].sort((a, b) => a - b);
    const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  }
  const median = xs => quantile(xs, 0.5);

  function meanCI(xs) {
    const n = xs.length, m = mean(xs);
    if (n < 2) return { mean: m, low: NaN, high: NaN };
    const half = tInv(0.975, n - 1) * sd(xs) / Math.sqrt(n);
    return { mean: m, low: m - half, high: m + half };
  }

  /** Average ranks (ties share the mean rank), plus tie group sizes. */
  function rank(values) {
    const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const ranks = new Array(values.length);
    const ties = [];
    for (let i = 0; i < order.length;) {
      let j = i;
      while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
      const r = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) ranks[order[k][1]] = r;
      ties.push(j - i + 1);
      i = j + 1;
    }
    return { ranks, ties };
  }

  // ---- proportions --------------------------------------------------------------
  const Z95 = 1.959963984540054;

  /** Wilson score interval (statsmodels proportion_confint method="wilson"). */
  function wilson(k, n, z = Z95) {
    if (!n) return [NaN, NaN];
    const p = k / n, z2 = z * z, denom = 1 + z2 / n;
    const center = (p + z2 / (2 * n)) / denom;
    const half = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / denom;
    return [Math.max(0, center - half), Math.min(1, center + half)];
  }

  /** Two-sample z-test for proportions, pooled variance (statsmodels proportions_ztest). */
  function twoProportionZ(k1, n1, k2, n2) {
    const p = (k1 + k2) / (n1 + n2);
    const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
    if (!se) return { z: NaN, p: NaN };
    const z = (k1 / n1 - k2 / n2) / se;
    return { z, p: 2 * normSf(Math.abs(z)) };
  }

  /** Holm step-down adjustment; NaNs pass through. */
  function holm(ps) {
    const idx = ps.map((p, i) => [p, i]).filter(([p]) => Number.isFinite(p)).sort((a, b) => a[0] - b[0]);
    const m = idx.length, out = ps.map(() => NaN);
    let running = 0;
    idx.forEach(([p, i], j) => {
      running = Math.max(running, Math.min(1, (m - j) * p));
      out[i] = running;
    });
    return out;
  }

  function binomPmfLog(k, n, p) {
    if (p === 0) return k === 0 ? 0 : -Infinity;
    if (p === 1) return k === n ? 0 : -Infinity;
    return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1) + k * Math.log(p) + (n - k) * Math.log(1 - p);
  }

  /** Exact two-sided binomial test (SciPy binomtest, "minlike" rule). */
  function binomTest(k, n, p) {
    const d = Math.exp(binomPmfLog(k, n, p)) * (1 + 1e-7);
    let total = 0;
    for (let i = 0; i <= n; i++) {
      const pi = Math.exp(binomPmfLog(i, n, p));
      if (pi <= d) total += pi;
    }
    return Math.min(1, total);
  }

  /** Fisher's exact test for a 2x2 table [[a, b], [c, d]], two-sided (SciPy rule). */
  function fisherExact(a, b, c, d) {
    const r1 = a + b, c1 = a + c, n = a + b + c + d;
    const logP = x => logGamma(r1 + 1) + logGamma(n - r1 + 1) + logGamma(c1 + 1) + logGamma(n - c1 + 1)
      - logGamma(n + 1) - logGamma(x + 1) - logGamma(r1 - x + 1) - logGamma(c1 - x + 1) - logGamma(n - r1 - c1 + x + 1);
    const obs = Math.exp(logP(a)) * (1 + 1e-7);
    let p = 0;
    for (let x = Math.max(0, r1 + c1 - n); x <= Math.min(r1, c1); x++) {
      const px = Math.exp(logP(x));
      if (px <= obs) p += px;
    }
    return { oddsRatio: (a * d) / (b * c), p: Math.min(1, p) };
  }

  /** Exact Poisson interval for a count k over exposure T (Garwood). */
  function poissonCI(k, T = 1) {
    const lo = k === 0 ? 0 : chi2Inv(0.025, 2 * k) / 2;
    const hi = chi2Inv(0.975, 2 * k + 2) / 2;
    return [lo / T, hi / T];
  }

  // ---- contingency tables -----------------------------------------------------------
  function margins(table) {
    const rows = table.map(r => sum(r));
    const cols = table[0].map((_, j) => sum(table.map(r => r[j])));
    return { rows, cols, n: sum(rows) };
  }

  function chi2Value(table, expected) {
    let x = 0;
    for (let i = 0; i < table.length; i++)
      for (let j = 0; j < table[0].length; j++)
        if (expected[i][j] > 0) x += (table[i][j] - expected[i][j]) ** 2 / expected[i][j];
    return x;
  }

  /** Pearson chi-square test of independence with cell-level adjusted residuals. */
  function chi2Independence(table) {
    const { rows, cols, n } = margins(table);
    const R = table.length, C = table[0].length;
    const expected = rows.map(r => cols.map(c => r * c / n));
    const chi2 = chi2Value(table, expected);
    const dof = (R - 1) * (C - 1);
    const adj = table.map((row, i) => row.map((o, j) => {
      const e = expected[i][j];
      const v = e * (1 - rows[i] / n) * (1 - cols[j] / n);
      return v > 0 ? (o - e) / Math.sqrt(v) : 0;
    }));
    const k = Math.min(R, C);
    const v = Math.sqrt(chi2 / (n * (k - 1)));
    const phi2 = Math.max(0, chi2 / n - (C - 1) * (R - 1) / (n - 1));
    const rc = R - (R - 1) ** 2 / (n - 1), kc = C - (C - 1) ** 2 / (n - 1);
    const vCorr = Math.sqrt(phi2 / Math.max(1e-12, Math.min(kc - 1, rc - 1)));
    let small = 0;
    expected.forEach(r => r.forEach(e => { if (e < 5) small++; }));
    return {
      n, chi2, dof, p: chi2Sf(chi2, dof), expected, adjResid: adj,
      cramersV: v, cramersVCorrected: vCorr, shareExpectedBelow5: small / (R * C),
      bonferroniZ: normInv(1 - 0.05 / (2 * R * C)),
    };
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Monte Carlo permutation p-value for independence with both margins fixed
      (the Fisher-Freeman-Halton reference distribution). Seeded, so reproducible. */
  function monteCarloIndependence(rowIdx, colIdx, R, C, draws = 20000, seed = 20260401) {
    const n = rowIdx.length;
    const obs = Array.from({ length: R }, () => new Array(C).fill(0));
    for (let i = 0; i < n; i++) obs[rowIdx[i]][colIdx[i]]++;
    const { rows, cols } = margins(obs);
    const expected = rows.map(r => cols.map(c => r * c / n));
    const obsStat = chi2Value(obs, expected) - 1e-9;
    const rand = mulberry32(seed);
    const perm = Int32Array.from(colIdx);
    const counts = new Float64Array(R * C);
    const expFlat = Float64Array.from(expected.flat());
    let hits = 0;
    for (let d = 0; d < draws; d++) {
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        const tmp = perm[i]; perm[i] = perm[j]; perm[j] = tmp;
      }
      counts.fill(0);
      for (let i = 0; i < n; i++) counts[rowIdx[i] * C + perm[i]]++;
      let x = 0;
      for (let c = 0; c < counts.length; c++)
        if (expFlat[c] > 0) { const dlt = counts[c] - expFlat[c]; x += dlt * dlt / expFlat[c]; }
      if (x >= obsStat) hits++;
    }
    return (hits + 1) / (draws + 1);
  }

  function chi2GoodnessOfFit(observed, expected) {
    const x = observed.reduce((s, o, i) => s + (o - expected[i]) ** 2 / expected[i], 0);
    return { chi2: x, dof: observed.length - 1, p: chi2Sf(x, observed.length - 1) };
  }

  // ---- two-sample and k-sample tests --------------------------------------------------
  /** Welch's unequal-variance t-test (SciPy ttest_ind, equal_var=False). */
  function welchT(a, b) {
    const na = a.length, nb = b.length;
    const va = variance(a) / na, vb = variance(b) / nb;
    const t = (mean(a) - mean(b)) / Math.sqrt(va + vb);
    const df = (va + vb) ** 2 / (va * va / (na - 1) + vb * vb / (nb - 1));
    return { t, df, p: Math.min(1, 2 * tSf(Math.abs(t), df)) };
  }

  /** Mann-Whitney U, normal approximation with tie and continuity correction
      (SciPy mannwhitneyu, method="asymptotic"). Returns U for the first sample. */
  function mannWhitney(a, b) {
    const n1 = a.length, n2 = b.length, n = n1 + n2;
    const { ranks, ties } = rank([...a, ...b]);
    const r1 = sum(ranks.slice(0, n1));
    const u1 = r1 - n1 * (n1 + 1) / 2;
    const u = Math.max(u1, n1 * n2 - u1);
    const tieTerm = sum(ties.map(t => t * t * t - t));
    const s = Math.sqrt(n1 * n2 / 12 * ((n + 1) - tieTerm / (n * (n - 1))));
    const z = (u - n1 * n2 / 2 - 0.5) / s;
    return { U: u1, z, p: Math.min(1, 2 * normSf(z)), rankBiserial: 2 * u1 / (n1 * n2) - 1 };
  }

  /** Kruskal-Wallis H with tie correction. */
  function kruskal(groups) {
    const all = groups.flat(), N = all.length;
    const { ranks, ties } = rank(all);
    let offset = 0, h = 0;
    groups.forEach(g => {
      const r = sum(ranks.slice(offset, offset + g.length));
      h += r * r / g.length;
      offset += g.length;
    });
    h = 12 / (N * (N + 1)) * h - 3 * (N + 1);
    h /= 1 - sum(ties.map(t => t * t * t - t)) / (N * N * N - N);
    return { H: h, dof: groups.length - 1, p: chi2Sf(h, groups.length - 1) };
  }

  function hedgesG(a, b) {
    const na = a.length, nb = b.length;
    const sp = Math.sqrt(((na - 1) * variance(a) + (nb - 1) * variance(b)) / (na + nb - 2));
    return (mean(a) - mean(b)) / sp * (1 - 3 / (4 * (na + nb) - 9));
  }

  // ---- Poisson regression ---------------------------------------------------------------
  function invert(M) {
    const n = M.length;
    const A = M.map((row, i) => [...row, ...row.map((_, j) => (i === j ? 1 : 0))]);
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      [A[c], A[piv]] = [A[piv], A[c]];
      const d = A[c][c];
      if (Math.abs(d) < 1e-14) throw new Error('Singular matrix');
      for (let j = 0; j < 2 * n; j++) A[c][j] /= d;
      for (let r = 0; r < n; r++) if (r !== c) {
        const f = A[r][c];
        if (f) for (let j = 0; j < 2 * n; j++) A[r][j] -= f * A[c][j];
      }
    }
    return A.map(row => row.slice(n));
  }

  /** Poisson GLM (log link) by IRLS; returns quasi-Poisson (Pearson-scaled) SEs too. */
  function poissonRegression(X, y, maxIter = 100) {
    const n = X.length, p = X[0].length;
    let beta = new Array(p).fill(0);
    beta[0] = Math.log(Math.max(mean(y), 1e-8));
    let mu = [];
    for (let it = 0; it < maxIter; it++) {
      const eta = X.map(row => row.reduce((s, x, j) => s + x * beta[j], 0));
      mu = eta.map(Math.exp);
      const XtWX = Array.from({ length: p }, () => new Array(p).fill(0));
      const XtWz = new Array(p).fill(0);
      for (let i = 0; i < n; i++) {
        const w = mu[i], z = eta[i] + (y[i] - mu[i]) / mu[i];
        for (let a = 0; a < p; a++) {
          XtWz[a] += X[i][a] * w * z;
          for (let b = 0; b < p; b++) XtWX[a][b] += X[i][a] * w * X[i][b];
        }
      }
      const inv = invert(XtWX);
      const next = inv.map(row => row.reduce((s, v, j) => s + v * XtWz[j], 0));
      const delta = Math.max(...next.map((b, j) => Math.abs(b - beta[j])));
      beta = next;
      if (delta < 1e-10) break;
    }
    const eta = X.map(row => row.reduce((s, x, j) => s + x * beta[j], 0));
    mu = eta.map(Math.exp);
    const XtWX = Array.from({ length: p }, () => new Array(p).fill(0));
    for (let i = 0; i < n; i++)
      for (let a = 0; a < p; a++)
        for (let b = 0; b < p; b++) XtWX[a][b] += X[i][a] * mu[i] * X[i][b];
    const cov = invert(XtWX);
    const pearson = y.reduce((s, yi, i) => s + (yi - mu[i]) ** 2 / mu[i], 0);
    const dispersion = pearson / (n - p);
    const se = cov.map((row, j) => Math.sqrt(row[j]));
    const seQuasi = se.map(s => s * Math.sqrt(dispersion));
    return { beta, se, seQuasi, dispersion, fitted: mu };
  }

  const api = {
    logGamma, gammaP, gammaQ, betaI, normSf, normCdf, normInv, chi2Sf, chi2Inv, tSf, tInv,
    sum, mean, variance, sd, median, quantile, meanCI, rank,
    wilson, twoProportionZ, holm, binomTest, fisherExact, poissonCI,
    chi2Independence, monteCarloIndependence, chi2GoodnessOfFit,
    welchT, mannWhitney, kruskal, hedgesG, poissonRegression, Z95,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MPStats = api;
})(typeof window !== 'undefined' ? window : globalThis);
