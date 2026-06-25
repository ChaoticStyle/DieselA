// /api/diesel
// GET    → returns { ...aggregates, rows, hist }. Customer PII is stripped
//          defensively here even though diesel_rows is already sanitized.
// DELETE → clears all diesel blobs (admin reset).

import { getStore } from '@netlify/blobs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  // The dashboard relies on every load (page open or Refresh click) hitting
  // live Blob storage — never a stale cached copy from the browser, a CDN,
  // or a proxy in between.
  'Cache-Control': 'no-store, no-cache, must-revalidate',
};

const PII_FIELDS = ['_masterText'];

function stripPII(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const clean = {};
  for (const k of Object.keys(obj)) {
    if (PII_FIELDS.indexOf(k) !== -1) continue;
    clean[k] = obj[k];
  }
  return clean;
}

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const store = getStore('garv-diesel');

  if (request.method === 'GET') {
    try {
      const summary = await store.get('diesel_summary', { type: 'json' });
      if (!summary) return new Response('', { status: 404, headers: CORS });

      const rowsBlob = await store.get('diesel_rows', { type: 'json' });
      const hist = await store.get('diesel_hist', { type: 'json' });

      return Response.json({
        ...stripPII(summary),
        rows: rowsBlob ? rowsBlob.rows : [],
        H: rowsBlob ? rowsBlob.H : null,
        hist: hist || [],
      }, { status: 200, headers: CORS });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500, headers: CORS });
    }
  }

  if (request.method === 'DELETE') {
    try {
      await store.delete('diesel_summary');
      await store.delete('diesel_raw');
      await store.delete('diesel_rows');
      await store.delete('diesel_hist');
      return Response.json({ deleted: true }, { status: 200, headers: CORS });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500, headers: CORS });
    }
  }

  return new Response('Method not allowed', { status: 405, headers: CORS });
};
