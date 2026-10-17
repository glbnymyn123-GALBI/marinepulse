/* MarinePulse data layer: CSV parsing and record cleaning.
   Pure functions, no DOM. Mirrors the cleaning in analysis/marine_mammal_stats.py
   so the dashboard and the Python analysis count the same things. */
(function (root) {
  'use strict';

  const TYPES = ['Dolphin', 'Whale', 'Monk seal', 'Dugong'];
  const COUNTRIES = ['Lebanon', 'Syria', 'Gaza', 'Egypt'];

  // Canonical species list. `type` is the general mammal type used in the analysis.
  // Orca and false killer whale are Delphinidae but are recorded as whales here
  // (project convention); the Analysis view can flip them.
  const SPECIES = {
    'tursiops truncatus':     { latin: 'Tursiops truncatus',     common: 'Common bottlenose dolphin',      type: 'Dolphin',   iucn: 'LC' },
    'tursiops aduncus':       { latin: 'Tursiops aduncus',       common: 'Indo-Pacific bottlenose dolphin', type: 'Dolphin',  iucn: 'NT' },
    'stenella longirostris':  { latin: 'Stenella longirostris',  common: 'Spinner dolphin',                type: 'Dolphin',   iucn: 'LC' },
    'stenella coeruleoalba':  { latin: 'Stenella coeruleoalba',  common: 'Striped dolphin',                type: 'Dolphin',   iucn: 'LC' },
    'grampus griseus':        { latin: 'Grampus griseus',        common: "Risso's dolphin",                type: 'Dolphin',   iucn: 'LC' },
    'delphinus delphis':      { latin: 'Delphinus delphis',      common: 'Short-beaked common dolphin',    type: 'Dolphin',   iucn: 'LC' },
    'sousa plumbea':          { latin: 'Sousa plumbea',          common: 'Indian Ocean humpback dolphin',  type: 'Dolphin',   iucn: 'EN' },
    'steno bredanensis':      { latin: 'Steno bredanensis',      common: 'Rough-toothed dolphin',          type: 'Dolphin',   iucn: 'LC' },
    'physeter macrocephalus': { latin: 'Physeter macrocephalus', common: 'Sperm whale',                    type: 'Whale',     iucn: 'VU' },
    'balaenoptera physalus':  { latin: 'Balaenoptera physalus',  common: 'Fin whale',                      type: 'Whale',     iucn: 'VU' },
    'ziphius cavirostris':    { latin: 'Ziphius cavirostris',    common: "Cuvier's beaked whale",          type: 'Whale',     iucn: 'LC' },
    'orcinus orca':           { latin: 'Orcinus orca',           common: 'Killer whale',                   type: 'Whale',     iucn: 'DD', delphinid: true },
    'pseudorca crassidens':   { latin: 'Pseudorca crassidens',   common: 'False killer whale',             type: 'Whale',     iucn: 'NT', delphinid: true },
    'monachus monachus':      { latin: 'Monachus monachus',      common: 'Mediterranean monk seal',        type: 'Monk seal', iucn: 'VU' },
    'dugong dugon':           { latin: 'Dugong dugon',           common: 'Dugong',                         type: 'Dugong',    iucn: 'VU' },
  };
  const SPECIES_ALIASES = {
    'bottlenose dolphin': 'tursiops truncatus',
    'sperm whale': 'physeter macrocephalus',
    'sous plumbea': 'sousa plumbea',
    'killer whale': 'orcinus orca',
    'orca': 'orcinus orca',
  };
  const IUCN = {
    LC: 'Least concern', NT: 'Near threatened', VU: 'Vulnerable',
    EN: 'Endangered', CR: 'Critically endangered', DD: 'Data deficient',
  };

  const RED_SEA_PLACES = ['hurghada', 'marsa alam', 'sharm', 'ras mohammed', 'sataya',
    'marsa shagra', 'ras gharab', 'abu ramada', 'safaga', 'dahab'];
  const CANAL_PLACES = ['suez canal', 'ismailia'];

  /* RFC 4180 parser: handles quoted commas, doubled quotes and line breaks
     inside quoted cells (the 2026 sheet has several). */
  function parseCSV(text) {
    const rows = [];
    let row = [], cell = '', inQuotes = false;
    const s = text.replace(/^﻿/, '');
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inQuotes) {
        if (ch === '"') {
          if (s[i + 1] === '"') { cell += '"'; i++; }
          else inQuotes = false;
        } else cell += ch;
      } else if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && s[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(c => c.trim() !== ''));
  }

  // Header names vary between sheet exports; match on a normalised prefix.
  const COLUMN_KEYS = {
    source: ['source'],
    platform: ['report source'],
    date: ['date'],
    status: ['stranded/water', 'stranded', 'status'],
    species: ['species'],
    credibility: ['credibility'],
    country: ['country'],
    city: ['city', 'area'],
    coords: ['coordinates', 'coords'],
    group: ['group size', 'group'],
    calves: ['calfs', 'calves'],
    boats: ['boats'],
    other: ['other', 'notes'],
    media: ['photo', 'media'],
    arabic: ['arabic'],
  };
  const REQUIRED = ['species', 'country', 'status'];

  function mapHeaders(header) {
    const norm = header.map(h => h.trim().toLowerCase());
    const idx = {};
    for (const [key, prefixes] of Object.entries(COLUMN_KEYS)) {
      const i = norm.findIndex(h => prefixes.some(p => h === p || h.startsWith(p)));
      if (i >= 0 && !Object.values(idx).includes(i)) idx[key] = i;
    }
    // "source" also prefixes "report source"; make sure it points at the URL column.
    if (norm.indexOf('source') >= 0) idx.source = norm.indexOf('source');
    return idx;
  }

  const clean = v => (v == null ? '' : String(v).trim());
  const isBlank = v => !v || ['n/a', 'na', '-', '?'].includes(v.toLowerCase());

  function parseDate(raw) {
    let m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) {
      const d = +m[1], mo = +m[2], y = +m[3];
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return { y, m: mo, d, precision: 'day' };
    }
    m = raw.match(/^(\d{1,2})\/(\d{4})$/);
    if (m && +m[1] >= 1 && +m[1] <= 12) return { y: +m[2], m: +m[1], d: null, precision: 'month' };
    return null;
  }

  function parseGroup(raw) {
    if (isBlank(raw)) return { value: null, censored: false };
    let m = raw.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) return { value: (+m[1] + +m[2]) / 2, censored: false };
    m = raw.match(/^([>~]?)\s*(\d+)$/);
    if (m) return { value: +m[2], censored: m[1] === '>' };
    return { value: null, censored: false };
  }

  function parseCoords(raw) {
    const m = (raw || '').match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
    if (!m) return null;
    const lat = +m[1], lng = +m[2];
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat, lng, estimated: /estimat/i.test(raw) };
  }

  /* Post identity for duplicate checks; matches source_key() in the Python script. */
  function sourceKey(url) {
    if (!url) return '';
    const key = /(x|twitter|instagram|tiktok)\.com/.test(url) ? url.replace(/\?.*$/, '') : url;
    return key.replace(/\/+$/, '');
  }

  function titleCase(s) {
    return s.replace(/(^|[\s(,/-])([a-z])([a-z']*)/g, (all, pre, first, rest) => pre + first.toUpperCase() + rest);
  }

  function platformGroup(raw) {
    const s = raw.toLowerCase();
    if (/boat|trawler|cruise|tug/.test(s)) return 'Vessel';
    if (/beach/.test(s)) return 'Shore';
    if (/swim|diver/.test(s)) return 'In water';
    if (/jet|kayak|ski|sup/.test(s)) return 'Small craft';
    return 'Not stated';
  }

  function inferTypeFromNotes(notes, arabic) {
    const t = (notes + ' ' + arabic).toLowerCase();
    if (t.includes('whale') || t.includes('حوت')) return 'Whale';
    if (t.includes('دلفين') || t.includes('دولفين') || t.includes('dolphin')) return 'Dolphin';
    if (/riding boat wave|riding vessel wave|acrobatics|jumping/.test(t)) return 'Dolphin';
    return 'Unidentified';
  }

  function egyptCoast(country, cityRaw, coords) {
    if (country !== 'Egypt') return country;
    const city = cityRaw.toLowerCase();
    if (CANAL_PLACES.some(p => city.includes(p))) return 'Egypt (Suez Canal)';
    if (RED_SEA_PLACES.some(p => city.includes(p))) return 'Egypt (Red Sea)';
    if (coords) {
      if (coords.lat < 30.0) return 'Egypt (Red Sea)';
      if (coords.lat < 31.1 && coords.lng > 32.0 && coords.lng < 32.7) return 'Egypt (Suez Canal)';
      return 'Egypt (Mediterranean)';
    }
    if (city && city !== 'n/a' && city !== '-') return 'Egypt (Mediterranean)';
    return 'Egypt (unknown coast)';
  }

  /* Returns { records, warnings } or throws with a readable message. */
  function loadRecords(text) {
    const rows = parseCSV(text);
    if (rows.length < 2) throw new Error('The file has no data rows.');
    const idx = mapHeaders(rows[0]);
    const missing = REQUIRED.filter(k => idx[k] == null);
    if (missing.length) throw new Error('Missing column(s): ' + missing.join(', ') + '.');
    const get = (r, k) => (idx[k] == null ? '' : clean(r[idx[k]]));
    const records = [];
    let skipped = 0;
    rows.slice(1).forEach((r, i) => {
      const country = titleCase(get(r, 'country').toLowerCase());
      const speciesRaw = get(r, 'species');
      // Skip template rows: no source, no date and no species means no observation.
      if ((!country && isBlank(speciesRaw)) ||
          (!get(r, 'source') && isBlank(get(r, 'date')) && isBlank(speciesRaw))) { skipped++; return; }
      let key = speciesRaw.toLowerCase().replace(/\s+/g, ' ');
      key = SPECIES_ALIASES[key] || key;
      const sp = SPECIES[key] || null;
      const cityRaw = get(r, 'city');
      const coords = parseCoords(get(r, 'coords'));
      const date = parseDate(get(r, 'date'));
      const group = parseGroup(get(r, 'group'));
      const notes = get(r, 'other');
      const arabic = get(r, 'arabic');
      const cred = get(r, 'credibility').toLowerCase();
      const platformRaw = get(r, 'platform');
      const calvesRaw = get(r, 'calves');
      records.push({
        id: i + 1,
        source: get(r, 'source'),
        sourceKey: sourceKey(get(r, 'source')),
        platformRaw,
        platform: platformGroup(platformRaw),
        date,
        year: date ? date.y : null,
        month: date ? date.m : null,
        stranded: /^strand/i.test(get(r, 'status')),
        speciesRaw,
        speciesKey: sp ? key : null,
        species: sp,
        type: sp ? sp.type : 'Unidentified',
        typeFromNotes: sp ? sp.type : inferTypeFromNotes(notes, arabic),
        credibility: ['high', 'medium', 'low'].includes(cred) ? cred : 'unrated',
        country,
        city: isBlank(cityRaw) ? '' : (cityRaw === cityRaw.toLowerCase() || /\s[a-z]/.test(cityRaw) ? titleCase(cityRaw) : cityRaw),
        coast: egyptCoast(country, cityRaw, coords),
        coords,
        groupRaw: get(r, 'group'),
        groupSize: group.value,
        groupCensored: group.censored,
        calves: isBlank(calvesRaw) ? '' : calvesRaw,
        notes: notes.replace(/\s*\n\s*/g, ' '),
        media: get(r, 'media'),
        // Keep the Arabic name only; some cells carry English remarks instead.
        arabic: /[؀-ۿ]/.test(arabic) ? arabic.replace(/\([^)]*[a-z][^)]*\)/gi, '').trim() : '',
      });
    });
    return { records, skipped };
  }

  function formatDate(d) {
    if (!d) return 'Date not recorded';
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return (d.d ? d.d + ' ' : '') + months[d.m - 1] + ' ' + d.y;
  }

  const api = { TYPES, COUNTRIES, SPECIES, IUCN, parseCSV, loadRecords, formatDate, platformGroup };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MPData = api;
})(typeof window !== 'undefined' ? window : globalThis);
