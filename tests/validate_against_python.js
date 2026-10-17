// Checks the in-browser statistics against the Python reference output.
// Run: node tests/validate_against_python.js
const fs = require('fs');
const path = require('path');
const D = require('../assets/data.js');
const A = require('../assets/analysis.js');

const root = path.join(__dirname, '..');
const csv = fs.readFileSync(path.join(root, 'data/marine_mammal_sightings_2026.csv'), 'utf8');
const py = JSON.parse(fs.readFileSync(path.join(root, 'analysis/output/results.json'), 'utf8'));
const { records } = D.loadRecords(csv);
const js = A.run(records, { draws: 100000 });

let fails = 0, checks = 0;
function close(label, a, b, tol = 1e-6, rel = false) {
  checks++;
  // results.json stores 6 significant digits, so allow that much relative slack.
  const slack = Math.max(tol, 5e-6 * Math.abs(b));
  const ok = (Number.isNaN(a) && (b === null || Number.isNaN(b))) ||
    (rel ? Math.abs(a - b) <= tol * Math.max(Math.abs(b), 1e-300) : Math.abs(a - b) <= slack);
  if (!ok) { fails++; console.log(`FAIL ${label}: js=${a} py=${b}`); }
}

close('records', records.length, py.profile.records, 0);
close('identified', js.composition.n, py.composition.n, 0);
// Counts table
js.composition.rows.forEach((row, i) => js.composition.types.forEach((t, j) =>
  close(`count ${row}/${t}`, js.composition.table[i][j], py.composition.table[row][t], 0)));
close('chi2', js.composition.chi2, py.composition.chi2, 1e-6);
close('p asymptotic', js.composition.p, py.composition.p_asymptotic, 1e-6, true);
close('cramers V', js.composition.cramersV, py.composition.cramers_v, 1e-6);
close('cramers V corr', js.composition.cramersVCorrected, py.composition.cramers_v_corrected, 1e-6);
close('bonferroni z', js.composition.bonferroniZ, py.composition.bonferroni_z_crit, 1e-6);
js.composition.rows.forEach((row, i) => js.composition.types.forEach((t, j) =>
  close(`adj resid ${row}/${t}`, js.composition.adjResid[i][j], py.composition.adj_residuals[row][t], 1e-3)));
close('p Monte Carlo (MC noise)', js.composition.pMC, py.composition.p_monte_carlo, 1e-4);

py.likelihood.forEach(c => {
  const j = js.likelihood.find(x => x.row === c.country && x.type === c.type);
  close(`share ${c.country}/${c.type}`, j.share, c.share);
  close(`wilson lo ${c.country}/${c.type}`, j.low, c.ci_low);
  close(`wilson hi ${c.country}/${c.type}`, j.high, c.ci_high);
  close(`z ${c.country}/${c.type}`, j.z, c.z);
  close(`holm ${c.country}/${c.type}`, j.pHolm, c.p_holm, 1e-6);
});

py.rates_2019_2025.forEach(c => {
  const j = js.rates.cells.find(x => x.row === c.country && x.type === c.type);
  close(`rate ${c.country}/${c.type}`, j.perYear, c.per_year);
  close(`rate lo ${c.country}/${c.type}`, j.low, c.ci_low, 1e-5);
  close(`rate hi ${c.country}/${c.type}`, j.high, c.ci_high, 1e-5);
});
close('trend IRR', js.trend.irr, py.reporting_trend.quasi_poisson_irr, 1e-6);
close('trend IRR lo', js.trend.low, py.reporting_trend.quasi_poisson_irr_ci[0], 1e-4);
close('trend IRR hi', js.trend.high, py.reporting_trend.quasi_poisson_irr_ci[1], 1e-4);
close('trend p', js.trend.p, py.reporting_trend.quasi_poisson_p, 1e-3, true);
close('dispersion', js.trend.dispersion, py.reporting_trend.poisson_dispersion, 1e-6);

const g = py.group_size;
g.summary.forEach(s => {
  const j = js.groupSize.summary.find(x => x.row === s.country);
  close(`gs mean ${s.country}`, j.mean, s.mean, 1e-4);
  close(`gs ci lo ${s.country}`, j.low, s.ci_low, 1e-4);
  close(`gs median ${s.country}`, j.median, s.median, 0);
});
close('welch t', js.groupSize.main.welch.t, g.egypt_vs_lebanon.welch_t);
close('welch p', js.groupSize.main.welch.p, g.egypt_vs_lebanon.welch_p);
close('welch df', js.groupSize.main.welch.df, g.egypt_vs_lebanon.welch_df, 1e-4);
close('log welch p', js.groupSize.main.logWelch.p, g.egypt_vs_lebanon.log_welch_p);
close('mwu U', js.groupSize.main.mwu.U, g.egypt_vs_lebanon.mwu_U, 0);
close('mwu p', js.groupSize.main.mwu.p, g.egypt_vs_lebanon.mwu_p);
close('hedges g', js.groupSize.main.hedgesG, g.egypt_vs_lebanon.hedges_g);
close('kruskal H', js.groupSize.kruskal.H, g.kruskal_all_countries.H);
close('kruskal p', js.groupSize.kruskal.p, g.kruskal_all_countries.p);
g.pairwise_mwu.forEach(p => {
  const j = js.groupSize.pairs.find(x => x.a === p.a && x.b === p.b);
  close(`pair ${p.a}-${p.b} p`, j.p, p.p);
  close(`pair ${p.a}-${p.b} holm`, j.pHolm, p.p_holm);
});
close('bottlenose log welch p', js.groupSize.bottlenose.logWelch.p, g.bottlenose_only.log_welch_p);
close('bottlenose mwu p', js.groupSize.bottlenose.mwu.p, g.bottlenose_only.mwu_p);

py.strandings.by_country.forEach(s => {
  const j = js.strandings.byRow.find(x => x.row === s.country);
  close(`strand z ${s.country}`, j.z, s.z);
  close(`strand holm ${s.country}`, j.pHolm, s.p_holm);
});
close('strand MC p (MC noise)', js.strandings.pMC, py.strandings.country_mc_p, 5e-3);
close('fisher p', js.strandings.fisher.p, py.strandings.whale_vs_dolphin_fisher.p);
close('fisher OR', js.strandings.fisher.oddsRatio, py.strandings.whale_vs_dolphin_fisher.odds_ratio);

py.seasonality.forEach(s => {
  const j = js.seasonality.find(x => x.country === s.country);
  close(`season chi2 ${s.country}`, j.chi2, s.chi2, 1e-4);
  close(`season p ${s.country}`, j.p, s.p, 1e-6, true);
  close(`summer binom ${s.country}`, j.summerP, s.summer_binom_p, 1e-6);
});
close('unidentified p', js.dataQuality.unidentifiedP, py.data_quality.unidentified_p);
close('platform V', js.dataQuality.platformV, py.data_quality.platform_cramers_v);

// Robustness variants
const variants = {
  R1_high_credibility_only: { sample: 'high' },
  R2_delphinidae_as_dolphins: { delphinids: 'Dolphin' },
  R3_unidentified_from_notes: { unidentified: 'notes' },
  R4_egypt_split_by_coast: { egypt: 'coast' },
  R6_possible_duplicates_removed: { dedupe: true },
};
for (const [k, o] of Object.entries(variants)) {
  const r = A.run(records, { ...o, draws: 2000 });
  close(`${k} n`, r.composition.n, py.robustness[k].n, 0);
  close(`${k} chi2`, r.composition.chi2, py.robustness[k].chi2, 1e-6);
  close(`${k} V`, r.composition.cramersV, py.robustness[k].cramers_v, 1e-6);
}

console.log(`\n${checks - fails}/${checks} checks match the Python reference.`);
process.exit(fails ? 1 : 0);
