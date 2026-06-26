// CSV parsing + aggregation logic for the GARV Class A Diesels lead dashboard.
// Mirrors the parsing approach used in Garvsalesperformance-main's scoring.mjs,
// but the aggregation shape is specific to this report: lead counts bucketed
// by Lead Origination Date (YTD + per-month), with Active / Sold / Not-Sold
// as the headline split, plus breakdowns by product (Make/Model), Dealer,
// Lead Source, and Sales Rep.

// ── Fixed product list ───────────────────────────────────────────────
// Used both for grouping and as preset dashboard filter options — not
// derived from whatever happens to appear in a given CSV export.
export const PRODUCTS = [
  { make: 'Tiffin',            model: 'Allegro Bus' },
  { make: 'Tiffin',            model: 'Bob Tiffin Limited Edition Allegro Bus' },
  { make: 'Tiffin',            model: 'Byway' },
  { make: 'Thor Motor Coach',  model: 'Palazzo GT' },
  { make: 'Tiffin',            model: 'Phaeton' },
  { make: 'Entegra Coach',     model: 'Cornerstone' },
];

const REPORT_START = '2026-01-01';

// Models sorted longest-first so "Bob Tiffin Limited Edition Allegro Bus"
// matches before the shorter "Allegro Bus" when checking substrings.
const PRODUCTS_BY_MODEL = [...PRODUCTS].sort((a, b) => b.model.length - a.model.length);

// CSV exports are inconsistent about Make/Model casing (e.g. "TIFFIN
// PHAETON" vs "Tiffin Phaeton" vs "Cornerstone"/"Cornerstone" data-entry
// typos). Normalize every row to one of the fixed PRODUCTS labels so they
// don't fragment into near-duplicate buckets.
function canonicalProduct(make, model) {
  const m = (model || '').trim().toLowerCase();
  if (m) {
    for (const p of PRODUCTS_BY_MODEL) {
      if (m === p.model.toLowerCase() || m.includes(p.model.toLowerCase())) {
        return p.make + ' ' + p.model;
      }
    }
  }
  const mk = (make || '').trim();
  const md = (model || '').trim();
  return mk && md ? mk + ' ' + md : (mk || 'Other');
}

// ── CSV parser ────────────────────────────────────────────────────────
export function parseDieselCSV(txt) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < txt.length; i++) {
    const ch = txt[i];
    if (inQ) {
      if (ch === '"') {
        if (txt[i + 1] === '"') { field += '"'; i++; }
        else { inQ = false; }
      } else { field += ch; }
    } else {
      if (ch === '"') { inQ = true; }
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (ch === '\r') { /* skip */ }
      else { field += ch; }
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (rows.length < 2) return null;

  rows[0][0] = rows[0][0].replace(/^﻿/, '');
  const header = rows[0];

  const H = {};
  for (let i = 0; i < header.length; i++) {
    const name = header[i].trim();
    if (!(name in H)) H[name] = i;
    else H[name + '_2'] = i;
  }
  H.allHeaders = header.map(h => h.trim());

  H.DEALER           = H['Dealer'];
  H.CUSTOMER         = H['Customer'];
  H.LEAD_SOURCE      = H['Lead Source'];
  H.LEAD_TYPE        = H['Lead Type'];
  H.LEAD_SRC_GROUP   = H['Lead Source Group'];
  H.LEAD_STATUS      = H['Lead Status'];
  H.LEAD_STATUS_CUSTOM = H['Lead Status Custom'];
  H.LEAD_STATUS_TYPE = H['Lead Status Type'];
  H.CONTACTED        = H['Contacted Indicator'];
  H.SALES_REP        = H['Sales Rep'];
  H.BD_AGENT         = H['BD Agent'];
  H.MAKE             = H['Make'];
  H.MODEL            = H['Model'];
  H.LEAD_ORIG        = H['Lead Origination Date'];
  H.LEAD_MOD         = H['Lead Last Modified Date'];
  H.SOLD_DATETIME    = H['Sold Datetime'];
  H.EMAIL            = H['Email'];
  H.DAY_PHONE        = H['Daytime Phone'];
  H.EVE_PHONE        = H['Evening Phone'];
  H.CELL_PHONE       = H['Cell Phone'];
  H.VIN              = H['VIN'];
  H.STOCK_NUM        = H['Stock Number'];
  H.VISIT_RESULT     = H['Visit Result'];
  H.WRITE_UP         = H['Write Up'];
  H.TEST_DRIVE       = H['Test Drive'];
  H.MANAGER_TO       = H['Manager TO'];

  return { rows: rows.slice(1).filter(r => r.length > 1), H };
}

// ── Shape guard ───────────────────────────────────────────────────────
export function looksLikeDieselCSV(parsed) {
  if (!parsed) return false;
  const H = parsed.H;
  return H.DEALER !== undefined && H.MAKE !== undefined &&
         H.LEAD_STATUS_TYPE !== undefined && H.SALES_REP !== undefined;
}

// ── Lead dedup ────────────────────────────────────────────────────────
// The VinSolutions export joins each lead to its showroom visits, so a
// lead with multiple visits comes through as multiple otherwise-identical
// rows. Collapse those down to one row per lead before aggregating/
// displaying, keyed on the fields that identify the lead itself (not the
// visit-specific columns that legitimately vary row to row).
function dedupeKey(row, H) {
  return [H.CUSTOMER, H.EMAIL, H.CELL_PHONE, H.DEALER, H.VIN, H.LEAD_SOURCE, H.LEAD_ORIG, H.SALES_REP]
    .map(i => (i !== undefined ? (row[i] || '').trim().toLowerCase() : ''))
    .join('|');
}

export function dedupeRows(rows, H) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = dedupeKey(row, H);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

// ── Date helpers ──────────────────────────────────────────────────────
function parseDate(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return isNaN(t) ? null : new Date(t);
}
function monthKey(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// ── Status classification ──────────────────────────────────────────────
// sold:     Sold Datetime present, OR Lead Status Type === 'Sold' (fallback
//           for exports that predate the Sold Datetime column)
// notSold:  Lead Status Type === 'Bad' (lost/dead) and not sold
// active:   everything else (currently being worked)
function classifyStatus(row, H) {
  const soldDt = H.SOLD_DATETIME !== undefined ? (row[H.SOLD_DATETIME] || '').trim() : '';
  const type = (row[H.LEAD_STATUS_TYPE] || '').trim();
  if (soldDt || type === 'Sold') return 'sold';
  if (type === 'Bad') return 'notSold';
  return 'active';
}

// ── Bucket aggregation ──────────────────────────────────────────────────
function emptyBucket() {
  return {
    active: 0, sold: 0, notSold: 0, total: 0,
    byMake: {}, byDealer: {}, bySource: {}, byRep: {},
  };
}

function bumpDim(map, key, status) {
  if (!key) key = 'Unknown';
  const d = map[key] = map[key] || { active: 0, sold: 0, notSold: 0, total: 0 };
  d[status]++;
  d.total++;
}

function addRow(bucket, row, H, status) {
  bucket[status]++;
  bucket.total++;

  const productKey = canonicalProduct(row[H.MAKE], row[H.MODEL]);
  bumpDim(bucket.byMake, productKey, status);

  const dealerRaw = (row[H.DEALER] || '').trim();
  const dealer = dealerRaw.replace(/^Great American RV SuperStores\s*[,]?\s*(of\s+)?/i, '').trim() || 'Unknown';
  bumpDim(bucket.byDealer, dealer, status);

  const source = (row[H.LEAD_SOURCE] || '').trim();
  bumpDim(bucket.bySource, source, status);

  const rep = (row[H.SALES_REP] || '').trim();
  bumpDim(bucket.byRep, rep, status);
}

function dimToSortedArray(map) {
  return Object.entries(map)
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.total - a.total);
}

function finalizeBucket(b) {
  return {
    active: b.active, sold: b.sold, notSold: b.notSold, total: b.total,
    byMake: dimToSortedArray(b.byMake),
    byDealer: dimToSortedArray(b.byDealer),
    bySource: dimToSortedArray(b.bySource),
    byRep: dimToSortedArray(b.byRep),
  };
}

// ── Core aggregation ────────────────────────────────────────────────────
// Reporting window: fixed start (2026-01-01) through "today" — extends by
// one day automatically with each ingest, no manual range updates needed.
export function aggregate(rows, H) {
  const startMs = Date.parse(REPORT_START);
  const now = new Date();

  const ytd = emptyBucket();
  const monthBuckets = {}; // keyed by 'YYYY-MM', bucketed by Lead Origination Date
  const soldByMonth = {};  // keyed by 'YYYY-MM', bucketed by Sold Datetime — sales timing trend

  for (const row of rows) {
    const origDate = parseDate(row[H.LEAD_ORIG]);
    if (!origDate || origDate.getTime() < startMs) continue; // outside reporting window

    const status = classifyStatus(row, H);

    addRow(ytd, row, H, status);

    const lk = monthKey(origDate);
    if (!monthBuckets[lk]) monthBuckets[lk] = emptyBucket();
    addRow(monthBuckets[lk], row, H, status);

    if (status === 'sold') {
      const soldDate = (H.SOLD_DATETIME !== undefined && row[H.SOLD_DATETIME])
        ? parseDate(row[H.SOLD_DATETIME])
        : origDate;
      const sk = monthKey(soldDate || origDate);
      soldByMonth[sk] = (soldByMonth[sk] || 0) + 1;
    }
  }

  const monthKeys = Object.keys(monthBuckets).sort();
  const months = monthKeys.map(key => ({
    key,
    label: monthLabel(key),
    ...finalizeBucket(monthBuckets[key]),
  }));

  const trend = [...new Set([...monthKeys, ...Object.keys(soldByMonth)])]
    .sort()
    .map(key => ({
      key,
      label: monthLabel(key),
      active: monthBuckets[key] ? monthBuckets[key].active : 0,
      sold: monthBuckets[key] ? monthBuckets[key].sold : 0,
      notSold: monthBuckets[key] ? monthBuckets[key].notSold : 0,
      soldByDatetime: soldByMonth[key] || 0,
    }));

  return {
    range: { start: REPORT_START, end: now.toISOString().slice(0, 10) },
    products: PRODUCTS,
    ytd: finalizeBucket(ytd),
    months,
    trend,
  };
}
