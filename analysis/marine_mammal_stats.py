"""
Marine mammal sightings in the Levant (Lebanon, Syria, Gaza, Egypt)
Statistical analysis of 354 opportunistic sighting reports, 2014-2026.

Research question
    How does each mammal type (dolphin, whale, monk seal, dugong) appear in
    each country, and are the differences between countries statistically
    meaningful or just noise?

Methods (in the order they run)
    1. Composition      Pearson chi-square test of independence (country x type),
                        Monte Carlo exact p-value, Cramer's V, adjusted
                        standardized residuals (cell z-scores, Bonferroni).
    2. Likelihood       P(type | country) with Wilson 95% CIs, and one-vs-rest
                        two-proportion z-tests (Holm-adjusted).
    3. Encounter rate   Reports per year 2019-2025 with exact Poisson CIs,
                        P(at least one report in a month), and a negative
                        binomial regression of the yearly reporting trend.
    4. Group size       Welch t-tests (raw and log scale), Mann-Whitney U,
                        Kruskal-Wallis, Hedges' g.
    5. Strandings       Stranding share by country and by type, Fisher exact
                        and two-proportion z-tests.
    6. Robustness       High-credibility only; Delphinidae "whales" (orca,
                        false killer whale) moved to dolphins; unidentified
                        records assigned from field notes; Egypt split into
                        Mediterranean and Red Sea coasts.

Run
    python analysis/marine_mammal_stats.py [path/to/csv]

Outputs go to analysis/output/ (CSV tables + results.json).
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats
from statsmodels.stats.multitest import multipletests
from statsmodels.stats.proportion import proportion_confint, proportions_ztest
import statsmodels.api as sm
import statsmodels.formula.api as smf

ROOT = Path(__file__).resolve().parent
DEFAULT_CSV = ROOT.parent / "data" / "marine_mammal_sightings_2026.csv"
OUT = ROOT / "output"
RNG = np.random.default_rng(20260401)
MC_DRAWS = 100_000

COUNTRIES = ["Lebanon", "Syria", "Gaza", "Egypt"]
TYPES = ["Dolphin", "Whale", "Monk seal", "Dugong"]

# Genus/species -> general mammal type. Orca and false killer whale are
# taxonomically oceanic dolphins (Delphinidae) but are recorded as whales here,
# matching the project's species catalogue; robustness check R2 flips them.
SPECIES_TYPE = {
    "tursiops truncatus": "Dolphin",
    "tursiops aduncus": "Dolphin",
    "stenella longirostris": "Dolphin",
    "stenella coeruleoalba": "Dolphin",
    "grampus griseus": "Dolphin",
    "delphinus delphis": "Dolphin",
    "sousa plumbea": "Dolphin",
    "steno bredanensis": "Dolphin",
    "physeter macrocephalus": "Whale",
    "balaenoptera physalus": "Whale",
    "ziphius cavirostris": "Whale",
    "orcinus orca": "Whale",
    "pseudorca crassidens": "Whale",
    "monachus monachus": "Monk seal",
    "dugong dugon": "Dugong",
}
SPECIES_ALIASES = {
    "bottlenose dolphin": "tursiops truncatus",
    "sperm whale": "physeter macrocephalus",
    "sous plumbea": "sousa plumbea",
}
DELPHINIDAE_WHALES = {"orcinus orca", "pseudorca crassidens"}

RED_SEA_PLACES = ("hurghada", "marsa alam", "sharm", "ras mohammed", "sataya",
                  "marsa shagra", "ras gharab", "abu ramada", "safaga", "dahab")
CANAL_PLACES = ("suez canal", "ismailia")


# ---------------------------------------------------------------------------
# 1. Load and clean
# ---------------------------------------------------------------------------

def parse_date(raw: str):
    raw = raw.strip()
    m = re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{4})", raw)
    if m:
        d, mo, y = map(int, m.groups())
        return pd.Timestamp(year=y, month=mo, day=d)
    m = re.fullmatch(r"(\d{1,2})/(\d{4})", raw)          # month/year only
    if m:
        mo, y = map(int, m.groups())
        return pd.Timestamp(year=y, month=mo, day=15)
    return pd.NaT                                        # "N/A", "", "22/05/202"


def parse_group_size(raw: str):
    """Return (value, censored). '>4' is a lower bound, so it counts as 4."""
    raw = raw.strip()
    if not raw or raw.upper() in {"N/A", "NA", "-"}:
        return np.nan, False
    m = re.fullmatch(r"(\d+)\s*-\s*(\d+)", raw)
    if m:
        return (int(m.group(1)) + int(m.group(2))) / 2, False
    m = re.fullmatch(r"([>~]?)\s*(\d+)", raw)
    if m:
        return float(m.group(2)), m.group(1) == ">"
    return np.nan, False


def source_key(url: str) -> str:
    """Post identity: tracking parameters (?s=20, ?igsh=...) are dropped where they do not identify the post."""
    if not url:
        return ""
    key = re.sub(r"\?.*$", "", url) if re.search(r"(x|twitter|instagram|tiktok)\.com", url) else url
    return key.rstrip("/")


def parse_coords(raw: str):
    m = re.search(r"(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)", raw or "")
    if not m:
        return (np.nan, np.nan)
    lat, lng = float(m.group(1)), float(m.group(2))
    if abs(lat) > 90 or abs(lng) > 180:          # e.g. a truncated latitude in the sheet
        return (np.nan, np.nan)
    return (lat, lng)


def egypt_basin(row) -> str:
    if row["country"] != "Egypt":
        return row["country"]
    city = row["city"].lower()
    if any(p in city for p in CANAL_PLACES):
        return "Egypt (Suez Canal)"
    if any(p in city for p in RED_SEA_PLACES):
        return "Egypt (Red Sea)"
    lat, lng = row["lat"], row["lng"]
    if not np.isnan(lat):
        if lat < 30.0:
            return "Egypt (Red Sea)"
        if lat < 31.1 and 32.0 < lng < 32.7:
            return "Egypt (Suez Canal)"
        return "Egypt (Mediterranean)"
    if city and city not in {"n/a", "-"}:
        return "Egypt (Mediterranean)"   # every named Egyptian place left is on the Med coast
    return "Egypt (unknown coast)"


def infer_type_from_notes(row) -> str:
    """Used only in robustness check R3, never in the main analysis."""
    text = f"{row['other']} {row['arabic']}".lower()
    if "whale" in text or "حوت" in text:
        return "Whale"
    if "دلفين" in text or "دولفين" in text or "dolphin" in text:
        return "Dolphin"
    if any(k in text for k in ("riding boat wave", "riding vessel wave", "acrobatics", "jumping")):
        return "Dolphin"   # bow-riding and aerial behaviour are delphinid traits
    return "Unidentified"


def load(path: Path) -> pd.DataFrame:
    raw = pd.read_csv(path, dtype=str, keep_default_na=False)
    raw = raw.apply(lambda s: s.str.strip())
    # Template rows (no source, no date, no species) are not observations.
    blank = lambda s: s.str.upper().isin(["", "N/A", "NA", "-", "?"])
    empty = (raw["Source"] == "") & blank(raw["Date (DD-MM-YY)"]) & blank(raw["Species"])
    raw = raw[~empty].reset_index(drop=True)
    df = pd.DataFrame({
        "source": raw["Source"],
        "source_key": raw["Source"].map(source_key),
        "platform_raw": raw["Report source"],
        "date": raw["Date (DD-MM-YY)"].map(parse_date),
        "stranded": raw["Stranded/water"].str.lower().str.startswith("strand"),
        "species_raw": raw["Species"],
        "credibility": raw["Credibility (high / medium / low)"].str.lower()
                          .replace({"": "unrated", "-": "unrated"}),
        "country": raw["country"].str.title(),
        "city": raw["City / Area"],
        "group_raw": raw["Group size"],
        "other": raw["Other"],
        "arabic": raw["Arabic Name"],
    })
    sp = df["species_raw"].str.lower().str.replace(r"\s+", " ", regex=True)
    sp = sp.replace(SPECIES_ALIASES)
    df["species"] = sp.where(sp.isin(SPECIES_TYPE.keys()))
    df["type"] = df["species"].map(SPECIES_TYPE).fillna("Unidentified")
    gs = df["group_raw"].map(parse_group_size)
    df["group_size"] = gs.map(lambda t: t[0])
    df["group_censored"] = gs.map(lambda t: t[1])
    ll = raw["Coordinates"].map(parse_coords)
    df["lat"] = ll.map(lambda t: t[0])
    df["lng"] = ll.map(lambda t: t[1])
    df["year"] = df["date"].dt.year
    df["month"] = df["date"].dt.month
    df["basin"] = df.apply(egypt_basin, axis=1)
    df["type_inferred"] = np.where(df["type"] == "Unidentified",
                                   df.apply(infer_type_from_notes, axis=1), df["type"])
    return df


# ---------------------------------------------------------------------------
# Statistical helpers
# ---------------------------------------------------------------------------

def chi2_stat(table: np.ndarray) -> float:
    n = table.sum()
    expected = np.outer(table.sum(1), table.sum(0)) / n
    mask = expected > 0
    return float((((table - expected) ** 2)[mask] / expected[mask]).sum())


def monte_carlo_independence(rows: np.ndarray, cols: np.ndarray, n_rows: int,
                             n_cols: int, draws: int = MC_DRAWS) -> float:
    """Permutation (Fisher-Freeman-Halton style) p-value with fixed margins."""
    observed = np.zeros((n_rows, n_cols))
    np.add.at(observed, (rows, cols), 1)
    obs_stat = chi2_stat(observed)
    hits = 0
    batch = 5_000
    for start in range(0, draws, batch):
        k = min(batch, draws - start)
        perm = np.argsort(RNG.random((k, cols.size)), axis=1)
        shuffled = cols[perm]
        tables = np.zeros((k, n_rows, n_cols))
        idx = np.arange(k)[:, None]
        np.add.at(tables, (idx, rows[None, :], shuffled), 1)
        n = cols.size
        exp = tables.sum(2)[:, :, None] * tables.sum(1)[:, None, :] / n
        with np.errstate(divide="ignore", invalid="ignore"):
            chi = np.where(exp > 0, (tables - exp) ** 2 / exp, 0).sum((1, 2))
        hits += int((chi >= obs_stat - 1e-9).sum())
    return (hits + 1) / (draws + 1)


def adjusted_residuals(table: np.ndarray) -> np.ndarray:
    n = table.sum()
    r = table.sum(1, keepdims=True) / n
    c = table.sum(0, keepdims=True) / n
    expected = r * c * n
    return (table - expected) / np.sqrt(expected * (1 - r) * (1 - c))


def cramers_v(table: np.ndarray) -> tuple[float, float]:
    n = table.sum()
    chi2 = chi2_stat(table)
    r, k = table.shape
    v = np.sqrt(chi2 / (n * (min(r, k) - 1)))
    # Bergsma (2013) bias correction
    phi2 = max(0.0, chi2 / n - (k - 1) * (r - 1) / (n - 1))
    rc, kc = r - (r - 1) ** 2 / (n - 1), k - (k - 1) ** 2 / (n - 1)
    v_corr = np.sqrt(phi2 / max(1e-12, min(kc - 1, rc - 1)))
    return float(v), float(v_corr)


def wilson(k: int, n: int) -> tuple[float, float]:
    if n == 0:
        return (np.nan, np.nan)
    lo, hi = proportion_confint(k, n, alpha=0.05, method="wilson")
    return float(lo), float(hi)


def poisson_ci(k: int, exposure: float) -> tuple[float, float]:
    lo = 0.0 if k == 0 else stats.chi2.ppf(0.025, 2 * k) / 2
    hi = stats.chi2.ppf(0.975, 2 * k + 2) / 2
    return lo / exposure, hi / exposure


def hedges_g(a: np.ndarray, b: np.ndarray) -> float:
    na, nb = len(a), len(b)
    sp = np.sqrt(((na - 1) * a.var(ddof=1) + (nb - 1) * b.var(ddof=1)) / (na + nb - 2))
    d = (a.mean() - b.mean()) / sp
    return float(d * (1 - 3 / (4 * (na + nb) - 9)))


def r6(x):
    """JSON-friendly number: 6 significant digits, so tiny p-values survive."""
    if isinstance(x, (np.floating, float)):
        return None if np.isnan(x) else float(f"{float(x):.6g}")
    if isinstance(x, (np.integer,)):
        return int(x)
    if isinstance(x, (np.bool_,)):
        return bool(x)
    return x


def records(df: pd.DataFrame) -> list[dict]:
    return [{k: r6(v) for k, v in row.items()} for row in df.to_dict(orient="records")]


# ---------------------------------------------------------------------------
# Analyses
# ---------------------------------------------------------------------------

def composition(df: pd.DataFrame, row_key="country", rows=COUNTRIES,
                type_key="type", types=TYPES, draws=MC_DRAWS) -> dict:
    d = df[df[type_key].isin(types) & df[row_key].isin(rows)]
    types = [t for t in types if (d[type_key] == t).any()]   # e.g. no dugongs in the Med
    table = pd.crosstab(d[row_key], d[type_key]).reindex(index=rows, columns=types, fill_value=0)
    t = table.to_numpy(dtype=float)
    chi2, p_asym, dof, expected = stats.chi2_contingency(t, correction=False)
    r_idx = d[row_key].map({k: i for i, k in enumerate(rows)}).to_numpy()
    c_idx = d[type_key].map({k: i for i, k in enumerate(types)}).to_numpy()
    p_mc = monte_carlo_independence(r_idx, c_idx, len(rows), len(types), draws)
    v, v_corr = cramers_v(t)
    z = adjusted_residuals(t)
    m = t.size
    z_crit = stats.norm.ppf(1 - 0.05 / (2 * m))
    p_cell = 2 * stats.norm.sf(np.abs(z))
    return {
        "n": int(t.sum()), "table": table, "expected": expected,
        "chi2": chi2, "dof": dof, "p_asymptotic": p_asym, "p_monte_carlo": p_mc,
        "share_expected_below_5": float((expected < 5).mean()),
        "cramers_v": v, "cramers_v_corrected": v_corr,
        "adj_residuals": pd.DataFrame(z, index=rows, columns=types),
        "cell_p": pd.DataFrame(p_cell, index=rows, columns=types),
        "bonferroni_z_crit": z_crit,
    }


def likelihood(df: pd.DataFrame) -> pd.DataFrame:
    d = df[df["type"].isin(TYPES)]
    out = []
    for c in COUNTRIES:
        in_c = d["country"] == c
        n_c, n_rest = int(in_c.sum()), int((~in_c).sum())
        for t in TYPES:
            is_t = d["type"] == t
            k_c, k_rest = int((in_c & is_t).sum()), int((~in_c & is_t).sum())
            lo, hi = wilson(k_c, n_c)
            if k_c + k_rest in (0, n_c + n_rest):
                z, p = np.nan, np.nan
            else:
                z, p = proportions_ztest([k_c, k_rest], [n_c, n_rest])
            out.append({"country": c, "type": t, "k": k_c, "n": n_c,
                        "share": k_c / n_c, "ci_low": lo, "ci_high": hi,
                        "share_elsewhere": k_rest / n_rest,
                        "diff_pp": 100 * (k_c / n_c - k_rest / n_rest),
                        "z": z, "p": p})
    res = pd.DataFrame(out)
    ok = res["p"].notna()
    res.loc[ok, "p_holm"] = multipletests(res.loc[ok, "p"], method="holm")[1]
    return res


def encounter_rates(df: pd.DataFrame, y0=2019, y1=2025) -> tuple[pd.DataFrame, dict]:
    years = y1 - y0 + 1
    d = df[df["year"].between(y0, y1)]
    rows = []
    for c in COUNTRIES:
        for t in TYPES + ["All types"]:
            sel = d["country"] == c
            if t != "All types":
                sel &= d["type"] == t
            k = int(sel.sum())
            lam = k / years
            lo, hi = poisson_ci(k, years)
            rows.append({"country": c, "type": t, "reports": k, "per_year": lam,
                         "ci_low": lo, "ci_high": hi,
                         "p_month_at_least_one": 1 - np.exp(-lam / 12)})
    rates = pd.DataFrame(rows)

    # Reporting trend: counts per country-year, all types, 2015-2025.
    cy = (df[df["year"].between(2015, 2025)]
          .groupby(["country", "year"]).size()
          .reindex(pd.MultiIndex.from_product([COUNTRIES, range(2015, 2026)],
                                              names=["country", "year"]), fill_value=0)
          .rename("n").reset_index())
    cy["t"] = cy["year"] - 2020
    pois = smf.glm("n ~ C(country, Treatment('Lebanon')) + t", data=cy,
                   family=sm.families.Poisson()).fit()
    dispersion = pois.pearson_chi2 / pois.df_resid
    # Quasi-Poisson (Pearson-scaled SEs): what the dashboard recomputes live
    qp = smf.glm("n ~ C(country, Treatment('Lebanon')) + t", data=cy,
                 family=sm.families.Poisson()).fit(scale="X2")
    nb =smf.negativebinomial("n ~ C(country, Treatment('Lebanon')) + t", data=cy).fit(disp=0)
    b, se = nb.params["t"], nb.bse["t"]
    trend = {
        "window": "2015-2025", "observations": len(cy),
        "poisson_dispersion": dispersion,
        "quasi_poisson_irr": float(np.exp(qp.params["t"])),
        "quasi_poisson_irr_ci": [float(np.exp(qp.params["t"] - 1.96 * qp.bse["t"])),
                                 float(np.exp(qp.params["t"] + 1.96 * qp.bse["t"]))],
        "quasi_poisson_p": float(qp.pvalues["t"]),
        "nb_alpha": float(nb.params["alpha"]),
        "irr_per_year": float(np.exp(b)),
        "irr_ci": [float(np.exp(b - 1.96 * se)), float(np.exp(b + 1.96 * se))],
        "p": float(nb.pvalues["t"]),
        "country_irr_vs_lebanon": {
            k.split("]")[0].split("T.")[-1]: float(np.exp(v))
            for k, v in nb.params.items() if k.startswith("C(country")
        },
    }
    return rates, trend


def group_size(df: pd.DataFrame) -> dict:
    d = df[(df["type"] == "Dolphin") & df["group_size"].notna()]
    by = {c: d.loc[d["country"] == c, "group_size"].to_numpy() for c in COUNTRIES}
    summary = []
    for c, x in by.items():
        if len(x) >= 2:
            se = x.std(ddof=1) / np.sqrt(len(x))
            tcrit = stats.t.ppf(0.975, len(x) - 1)
            summary.append({"country": c, "n": len(x), "mean": x.mean(), "median": np.median(x),
                            "sd": x.std(ddof=1), "ci_low": x.mean() - tcrit * se,
                            "ci_high": x.mean() + tcrit * se,
                            "share_solitary": float((x == 1).mean())})
    eg, lb = by["Egypt"], by["Lebanon"]
    welch = stats.ttest_ind(eg, lb, equal_var=False)
    welch_log = stats.ttest_ind(np.log(eg), np.log(lb), equal_var=False)
    mwu = stats.mannwhitneyu(eg, lb, alternative="two-sided")
    kw = stats.kruskal(*[x for x in by.values() if len(x) >= 2])

    # Robustness: same species on both coasts (common bottlenose only)
    tt = df[(df["species"] == "tursiops truncatus") & df["group_size"].notna()]
    tt_eg = tt.loc[tt["country"] == "Egypt", "group_size"].to_numpy()
    tt_lb = tt.loc[tt["country"] == "Lebanon", "group_size"].to_numpy()
    tt_welch = stats.ttest_ind(tt_eg, tt_lb, equal_var=False)
    tt_log = stats.ttest_ind(np.log(tt_eg), np.log(tt_lb), equal_var=False)
    tt_mwu = stats.mannwhitneyu(tt_eg, tt_lb, alternative="two-sided")

    # Egypt is two seas: Red Sea pods vs Mediterranean coast groups
    by_basin = (d.groupby("basin")["group_size"]
                .agg(n="count", mean="mean", median="median").reset_index())

    # Pairwise Mann-Whitney between countries, Holm-adjusted
    pairs = []
    names = [c for c in COUNTRIES if len(by[c]) >= 2]
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            u = stats.mannwhitneyu(by[a], by[b], alternative="two-sided")
            pairs.append({"a": a, "b": b, "median_a": float(np.median(by[a])),
                          "median_b": float(np.median(by[b])), "U": u.statistic, "p": u.pvalue})
    pairs = pd.DataFrame(pairs)
    pairs["p_holm"] = multipletests(pairs["p"], method="holm")[1]
    # Robustness: drop censored ('>n') values
    unc = d[~d["group_censored"]]
    u_eg = unc.loc[unc["country"] == "Egypt", "group_size"].to_numpy()
    u_lb = unc.loc[unc["country"] == "Lebanon", "group_size"].to_numpy()
    u_welch = stats.ttest_ind(u_eg, u_lb, equal_var=False)
    return {
        "summary": pd.DataFrame(summary),
        "censored_share": float(d["group_censored"].mean()),
        "egypt_vs_lebanon": {
            "n": [len(eg), len(lb)], "mean": [eg.mean(), lb.mean()],
            "welch_t": welch.statistic, "welch_df": welch.df, "welch_p": welch.pvalue,
            "log_welch_t": welch_log.statistic, "log_welch_p": welch_log.pvalue,
            "geo_mean": [float(np.exp(np.log(eg).mean())), float(np.exp(np.log(lb).mean()))],
            "mwu_U": mwu.statistic, "mwu_p": mwu.pvalue,
            "rank_biserial": 2 * mwu.statistic / (len(eg) * len(lb)) - 1,
            "hedges_g": hedges_g(eg, lb),
        },
        "kruskal_all_countries": {"H": kw.statistic, "p": kw.pvalue},
        "pairwise_mwu": pairs,
        "by_basin": by_basin,
        "bottlenose_only": {"n": [len(tt_eg), len(tt_lb)],
                            "mean": [tt_eg.mean(), tt_lb.mean()],
                            "median": [float(np.median(tt_eg)), float(np.median(tt_lb))],
                            "geo_mean": [float(np.exp(np.log(tt_eg).mean())),
                                         float(np.exp(np.log(tt_lb).mean()))],
                            "welch_t": tt_welch.statistic, "welch_p": tt_welch.pvalue,
                            "log_welch_t": tt_log.statistic, "log_welch_df": tt_log.df,
                            "log_welch_p": tt_log.pvalue,
                            "mwu_U": tt_mwu.statistic, "mwu_p": tt_mwu.pvalue},
        "uncensored_only": {"n": [len(u_eg), len(u_lb)],
                            "mean": [u_eg.mean(), u_lb.mean()],
                            "welch_t": u_welch.statistic, "welch_p": u_welch.pvalue},
    }


def strandings(df: pd.DataFrame) -> dict:
    by_country = []
    for c in COUNTRIES:
        in_c = df["country"] == c
        k, n = int((in_c & df["stranded"]).sum()), int(in_c.sum())
        k_r, n_r = int((~in_c & df["stranded"]).sum()), int((~in_c).sum())
        z, p = proportions_ztest([k, k_r], [n, n_r])
        lo, hi = wilson(k, n)
        by_country.append({"country": c, "stranded": k, "n": n, "rate": k / n,
                           "ci_low": lo, "ci_high": hi, "rate_elsewhere": k_r / n_r,
                           "z": z, "p": p})
    bc = pd.DataFrame(by_country)
    bc["p_holm"] = multipletests(bc["p"], method="holm")[1]
    r_idx = df["country"].map({k: i for i, k in enumerate(COUNTRIES)}).to_numpy()
    c_idx = df["stranded"].astype(int).to_numpy()
    p_mc = monte_carlo_independence(r_idx, c_idx, len(COUNTRIES), 2)

    by_type = []
    ident = df[df["type"].isin(TYPES)]
    for t in TYPES:
        sel = ident["type"] == t
        k, n = int((sel & ident["stranded"]).sum()), int(sel.sum())
        lo, hi = wilson(k, n)
        by_type.append({"type": t, "stranded": k, "n": n, "rate": k / n, "ci_low": lo, "ci_high": hi})
    wh = ident[ident["type"] == "Whale"]
    do = ident[ident["type"] == "Dolphin"]
    odds, p_f = stats.fisher_exact([[wh["stranded"].sum(), (~wh["stranded"]).sum()],
                                    [do["stranded"].sum(), (~do["stranded"]).sum()]])
    return {"by_country": bc, "country_mc_p": p_mc, "by_type": pd.DataFrame(by_type),
            "whale_vs_dolphin_fisher": {"odds_ratio": odds, "p": p_f}}


def seasonality(df: pd.DataFrame) -> pd.DataFrame:
    days = np.array([31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31])
    rows = []
    for c in ["Lebanon", "Egypt"]:
        m = df.loc[(df["country"] == c) & df["month"].notna(), "month"].astype(int)
        obs = np.bincount(m, minlength=13)[1:]
        exp = obs.sum() * days / days.sum()
        chi = stats.chisquare(obs, exp)
        summer = obs[5:8].sum()              # Jun-Aug
        p_exp = days[5:8].sum() / days.sum()
        bt = stats.binomtest(int(summer), int(obs.sum()), p_exp)
        rows.append({"country": c, "n": int(obs.sum()), "chi2": chi.statistic, "p": chi.pvalue,
                     "peak_month": int(obs.argmax() + 1), "summer_share": summer / obs.sum(),
                     "summer_expected": p_exp, "summer_binom_p": bt.pvalue,
                     "by_month": obs.tolist()})
    return pd.DataFrame(rows)


def platform_group(raw: str) -> str:
    s = raw.lower()
    if any(k in s for k in ("boat", "trawler", "cruise", "tug")):
        return "Vessel"
    if "beach" in s:
        return "Shore"
    if "swim" in s or "diver" in s:
        return "In water"
    if any(k in s for k in ("jet", "kayak", "ski", "sup")):
        return "Small craft"
    return "Not stated"


def data_quality(df: pd.DataFrame) -> dict:
    """Is missingness or observer effort different between countries?"""
    unid = pd.crosstab(df["country"], df["type"] == "Unidentified").reindex(COUNTRIES)
    chi2, p, dof, _ = stats.chi2_contingency(unid.to_numpy())
    platform = pd.crosstab(df["country"], df["platform_raw"].map(platform_group)).reindex(COUNTRIES)
    pt = platform.to_numpy()
    r_idx = df["country"].map({k: i for i, k in enumerate(COUNTRIES)}).to_numpy()
    cats = list(platform.columns)
    c_idx = df["platform_raw"].map(platform_group).map({k: i for i, k in enumerate(cats)}).to_numpy()
    p_platform = monte_carlo_independence(r_idx, c_idx, len(COUNTRIES), len(cats), 20_000)
    return {
        "unidentified_rate": {c: float(unid.loc[c, True] / unid.loc[c].sum()) for c in COUNTRIES},
        "unidentified_chi2": chi2, "unidentified_p": p,
        "platform_counts": platform,
        "platform_mc_p": p_platform,
        "platform_cramers_v": cramers_v(pt.astype(float))[0],
    }


def robustness(df: pd.DataFrame) -> dict:
    out = {}
    hi = df[df["credibility"] == "high"]
    out["R1_high_credibility_only"] = composition(hi, draws=20_000)
    d2 = df.copy()
    d2.loc[d2["species"].isin(DELPHINIDAE_WHALES), "type"] = "Dolphin"
    out["R2_delphinidae_as_dolphins"] = composition(d2, draws=20_000)
    out["R3_unidentified_from_notes"] = composition(df, type_key="type_inferred", draws=20_000)
    basins = ["Lebanon", "Syria", "Gaza", "Egypt (Mediterranean)", "Egypt (Red Sea)"]
    out["R4_egypt_split_by_coast"] = composition(df, row_key="basin", rows=basins, draws=20_000)
    med = ["Lebanon", "Syria", "Gaza", "Egypt (Mediterranean)"]
    out["R5_mediterranean_only"] = composition(df, row_key="basin", rows=med, draws=20_000)
    dedup = df[(df["source_key"] == "") | ~df.duplicated("source_key", keep="first")]
    out["R6_possible_duplicates_removed"] = composition(dedup, draws=20_000)
    return out


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def comp_json(c: dict) -> dict:
    return {
        "n": c["n"], "chi2": r6(c["chi2"]), "dof": int(c["dof"]),
        "p_asymptotic": r6(c["p_asymptotic"]), "p_monte_carlo": r6(c["p_monte_carlo"]),
        "share_expected_below_5": r6(c["share_expected_below_5"]),
        "cramers_v": r6(c["cramers_v"]), "cramers_v_corrected": r6(c["cramers_v_corrected"]),
        "table": c["table"].to_dict(orient="index"),
        "adj_residuals": c["adj_residuals"].round(3).to_dict(orient="index"),
        "bonferroni_z_crit": r6(c["bonferroni_z_crit"]),
    }


def validate_sheet(path: Path) -> pd.DataFrame:
    """List rows worth fixing in the source sheet (row numbers match the spreadsheet)."""
    raw = pd.read_csv(path, dtype=str, keep_default_na=False).apply(lambda s: s.str.strip())
    issues = []
    blank = lambda v: v.upper() in {"", "N/A", "NA", "-", "?"}
    seen = {}
    for i, r in raw.iterrows():
        row = i + 2                                      # header is row 1
        src, date, sp, coords = r["Source"], r["Date (DD-MM-YY)"], r["Species"], r["Coordinates"]
        if not src and blank(date) and blank(sp):
            issues.append((row, "empty row", "no source, date or species; excluded from the analysis"))
            continue
        if not blank(date) and pd.isna(parse_date(date)):
            issues.append((row, "invalid date", f"'{date}' cannot be read as DD/MM/YYYY"))
        m = re.search(r"(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)", coords)
        if m and (abs(float(m.group(1))) > 90 or abs(float(m.group(2))) > 180):
            issues.append((row, "invalid coordinates", f"'{m.group(0)}' is outside the globe; record kept but not mapped"))
        key = sp.lower().replace("  ", " ")
        if not blank(sp) and SPECIES_ALIASES.get(key, key) not in SPECIES_TYPE:
            issues.append((row, "unknown species", f"'{sp}' is not in the species list"))
        if src:
            norm = source_key(src)
            if norm in seen:
                issues.append((row, "possible duplicate", f"same post as row {seen[norm]}"))
            else:
                seen[norm] = row
    return pd.DataFrame(issues, columns=["sheet_row", "issue", "detail"])


def main():
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_CSV
    OUT.mkdir(parents=True, exist_ok=True)
    df = load(path)
    issues = validate_sheet(path)
    issues.to_csv(OUT / "08_data_issues.csv", index=False)

    profile = {
        "records": len(df),
        "by_country": df["country"].value_counts().to_dict(),
        "by_type": df["type"].value_counts().to_dict(),
        "dated": int(df["date"].notna().sum()),
        "date_range": [str(df["date"].min().date()), str(df["date"].max().date())],
        "with_coordinates": int(df["lat"].notna().sum()),
        "stranded": int(df["stranded"].sum()),
        "credibility": df["credibility"].value_counts().to_dict(),
        "egypt_by_coast": df.loc[df["country"] == "Egypt", "basin"].value_counts().to_dict(),
    }

    comp = composition(df)
    like = likelihood(df)
    rates, trend = encounter_rates(df)
    gs = group_size(df)
    st = strandings(df)
    seas = seasonality(df)
    dq = data_quality(df)
    rob = robustness(df)

    comp["table"].to_csv(OUT / "01_country_by_type_counts.csv")
    comp["adj_residuals"].round(3).to_csv(OUT / "02_adjusted_residuals_z.csv")
    like.round(4).to_csv(OUT / "03_type_share_by_country_ztests.csv", index=False)
    rates.round(4).to_csv(OUT / "04_annual_report_rates_2019_2025.csv", index=False)
    gs["summary"].round(3).to_csv(OUT / "05_dolphin_group_size_by_country.csv", index=False)
    st["by_country"].round(4).to_csv(OUT / "06_strandings_by_country.csv", index=False)
    st["by_type"].round(4).to_csv(OUT / "07_strandings_by_type.csv", index=False)
    df.to_csv(OUT / "00_clean_records.csv", index=False)

    results = {
        "profile": profile,
        "data_issues": records(issues),
        "composition": comp_json(comp),
        "likelihood": records(like),
        "rates_2019_2025": records(rates),
        "reporting_trend": {k: (r6(v) if not isinstance(v, (list, dict)) else v)
                            for k, v in trend.items()},
        "group_size": {
            "summary": gs["summary"].round(4).to_dict(orient="records"),
            "censored_share": r6(gs["censored_share"]),
            "egypt_vs_lebanon": {k: (r6(v) if not isinstance(v, list) else [r6(x) for x in v])
                                 for k, v in gs["egypt_vs_lebanon"].items()},
            "kruskal_all_countries": {k: r6(v) for k, v in gs["kruskal_all_countries"].items()},
            "pairwise_mwu": records(gs["pairwise_mwu"]),
            "by_basin": gs["by_basin"].round(4).to_dict(orient="records"),
            "bottlenose_only": {k: (r6(v) if not isinstance(v, list) else [r6(x) for x in v])
                                for k, v in gs["bottlenose_only"].items()},
            "uncensored_only": {k: (r6(v) if not isinstance(v, list) else [r6(x) for x in v])
                                for k, v in gs["uncensored_only"].items()},
        },
        "strandings": {
            "by_country": records(st["by_country"]),
            "country_mc_p": r6(st["country_mc_p"]),
            "by_type": records(st["by_type"]),
            "whale_vs_dolphin_fisher": {k: r6(v) for k, v in st["whale_vs_dolphin_fisher"].items()},
        },
        "seasonality": records(seas),
        "data_quality": {
            "unidentified_rate": dq["unidentified_rate"],
            "unidentified_chi2": r6(dq["unidentified_chi2"]),
            "unidentified_p": r6(dq["unidentified_p"]),
            "platform_counts": dq["platform_counts"].to_dict(orient="index"),
            "platform_mc_p": r6(dq["platform_mc_p"]),
            "platform_cramers_v": r6(dq["platform_cramers_v"]),
        },
        "robustness": {k: comp_json(v) for k, v in rob.items()},
    }
    (OUT / "results.json").write_text(json.dumps(results, indent=2, ensure_ascii=False, default=r6))

    # ---- console summary --------------------------------------------------
    pd.set_option("display.width", 160)
    print(f"Records: {len(df)}   identified: {comp['n']}   stranded: {profile['stranded']}")
    print("\nCountry x type counts\n", comp["table"])
    print(f"\nChi-square = {comp['chi2']:.2f}, df = {comp['dof']}, "
          f"p (asymptotic) = {comp['p_asymptotic']:.2e}, p (Monte Carlo) = {comp['p_monte_carlo']:.2e}")
    print(f"Cramer's V = {comp['cramers_v']:.3f} (bias-corrected {comp['cramers_v_corrected']:.3f}); "
          f"{comp['share_expected_below_5']:.0%} of expected counts < 5")
    print(f"\nAdjusted residuals (|z| > {comp['bonferroni_z_crit']:.2f} is significant after Bonferroni)\n",
          comp["adj_residuals"].round(2))
    print("\nType share by country, one-vs-rest z-tests\n",
          like[["country", "type", "k", "n", "share", "ci_low", "ci_high", "share_elsewhere", "z", "p_holm"]].round(3))
    print("\nAnnual report rates 2019-2025\n", rates.round(3))
    print("\nReporting trend (negative binomial):", {k: v for k, v in trend.items()})
    print("\nDolphin group size\n", gs["summary"].round(2))
    print("Egypt vs Lebanon:", {k: v for k, v in gs["egypt_vs_lebanon"].items()})
    print("Kruskal:", gs["kruskal_all_countries"])
    print("Pairwise MWU\n", gs["pairwise_mwu"].round(4))
    print("By coast\n", gs["by_basin"].round(2))
    print("Bottlenose only:", gs["bottlenose_only"])
    print("Uncensored only:", gs["uncensored_only"])
    print("Censored share:", gs["censored_share"])
    print("\nStrandings by country\n", st["by_country"].round(3), "\nMC p:", st["country_mc_p"])
    print("Strandings by type\n", st["by_type"].round(3))
    print("Whale vs dolphin Fisher:", st["whale_vs_dolphin_fisher"])
    print("\nSeasonality\n", seas.drop(columns="by_month").round(4))
    print("\nData quality:", {k: v for k, v in dq.items() if k != "platform_counts"})
    print(dq["platform_counts"])
    for k, v in rob.items():
        print(f"\n{k}: n={v['n']} chi2={v['chi2']:.2f} df={v['dof']} p_mc={v['p_monte_carlo']:.2e} "
              f"V={v['cramers_v']:.3f}")
        print(v["table"])
        print(v["adj_residuals"].round(2))
    print("\nProfile:", json.dumps(profile, default=str, ensure_ascii=False))
    print(f"\nData issues to fix in the sheet ({len(issues)}):")
    print(issues.to_string(index=False) if len(issues) else "  none")


if __name__ == "__main__":
    main()
