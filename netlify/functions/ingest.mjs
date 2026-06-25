// POST /api/ingest — server-side CSV ingest for the VinSolutions → Gmail
// pipeline feeding the GARV Class A Diesels dashboard.
//
// Security: requests must include the INGEST_API_KEY environment variable
// value. Set it in the Netlify dashboard under Site → Environment Variables.

import { getStore } from '@netlify/blobs';
import {
  parseDieselCSV,
  looksLikeDieselCSV,
  aggregate,
  sanitizeRows,
} from './lib/diesel.mjs';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: CORS });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400, headers: CORS });
  }

  const { csvText, fileName, apiKey } = body || {};

  const expectedKey = process.env.INGEST_API_KEY;
  if (!expectedKey) {
    return Response.json({ error: 'INGEST_API_KEY not configured on server' }, { status: 500, headers: CORS });
  }
  if (!apiKey || apiKey !== expectedKey) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers: CORS });
  }

  if (!csvText || typeof csvText !== 'string' || csvText.length < 100) {
    return Response.json({ error: 'csvText is missing or too short' }, { status: 400, headers: CORS });
  }

  let parsed;
  try {
    parsed = parseDieselCSV(csvText);
  } catch (e) {
    return Response.json({ error: 'CSV parse error: ' + e.message }, { status: 400, headers: CORS });
  }
  if (!parsed || !looksLikeDieselCSV(parsed)) {
    return Response.json(
      { error: 'File does not look like a VinSolutions Class A Diesels CSV. Expected columns: Dealer, Make, Lead Status Type, Sales Rep.' },
      { status: 400, headers: CORS }
    );
  }

  let summary;
  try {
    summary = aggregate(parsed.rows, parsed.H);
  } catch (e) {
    return Response.json({ error: 'Aggregation error: ' + e.message }, { status: 500, headers: CORS });
  }

  const now = new Date();
  const uploadedAt = now.toISOString();
  const displayName = fileName || ('class_a_diesels_' + uploadedAt.slice(0, 10) + '.csv');

  summary.fileName = displayName;
  summary.uploadedAt = uploadedAt;

  const blobStore = getStore('garv-diesel');

  try {
    // 1. Raw CSV (server-only, never returned by public GET)
    await blobStore.setJSON('diesel_raw', {
      _masterText: csvText,
      fileName: displayName,
      uploadedAt,
    });

    // 2. Public aggregates (returned by GET /api/diesel)
    await blobStore.setJSON('diesel_summary', summary);

    // 3. PII-stripped row cache for client-side drill-down filtering
    const cleanRows = sanitizeRows(parsed.rows, parsed.H);
    await blobStore.setJSON('diesel_rows', {
      rows: cleanRows,
      H: parsed.H,
      fileName: displayName,
      uploadedAt,
    });

    // 4. Upload history (newest first, max 20)
    let hist = [];
    try {
      const existing = await blobStore.get('diesel_hist', { type: 'json' });
      if (Array.isArray(existing)) hist = existing;
    } catch { /* first upload */ }
    hist.unshift({ fileName: displayName, uploadedAt, totalLeads: summary.ytd.total, sold: summary.ytd.sold });
    if (hist.length > 20) hist = hist.slice(0, 20);
    await blobStore.setJSON('diesel_hist', hist);

  } catch (e) {
    return Response.json({ error: 'Blob write failed: ' + e.message }, { status: 500, headers: CORS });
  }

  return Response.json({
    success: true,
    uploadedAt,
    totalLeads: summary.ytd.total,
    active: summary.ytd.active,
    sold: summary.ytd.sold,
    notSold: summary.ytd.notSold,
  }, { status: 200, headers: CORS });
};
