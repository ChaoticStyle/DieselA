/**
 * GARV Class A Diesels Dashboard — VinSolutions Auto-Ingest Bot
 * ================================================================
 * Monitors Gmail for the daily "Class A Diesels" VinSolutions report and
 * automatically uploads it to the dashboard via the /api/ingest endpoint.
 *
 * SETUP (one-time):
 *  1. Go to script.google.com → New Project → paste this file.
 *  2. Rename the project to "GARV Diesel Ingest".
 *  3. Set Script Properties (Project Settings → Script Properties):
 *       NETLIFY_INGEST_URL  = https://your-site.netlify.app/api/ingest
 *       INGEST_API_KEY      = (same value set in Netlify env vars)
 *  4. Run setupTrigger() once to install the Gmail check.
 *  5. Authorize the script when prompted (Gmail + UrlFetch scopes).
 *
 * HOW IT WORKS:
 *  - VinSolutions emails one combined CSV report daily from
 *    reportscheduler@motosnap.com with the exact subject "Class A Diesels".
 *  - Unlike the per-store sales dashboards, this is a single fixed report —
 *    no store/month parsing is needed. Every row in the CSV already carries
 *    its own Dealer, so the whole file is POSTed as-is.
 *  - Processed emails get the "GARV-Diesel-Processed" label; failed ones
 *    get "GARV-Diesel-Failed" so you can see them in Gmail and retry.
 *
 * TRIGGER CADENCE:
 *  - setupTrigger() currently installs an HOURLY check because the exact
 *    daily send time from VinSolutions hasn't been confirmed yet. Once
 *    confirmed, switch the trigger to .timeBased().everyDays(1).atHour(N)
 *    to match it (see commented alternative inside setupTrigger()).
 */

// ── Config ────────────────────────────────────────────────────────────
const VINSOLUTIONS_SENDER = 'reportscheduler@motosnap.com';
const REPORT_SUBJECT      = 'Class A Diesels';

// ── Entry point ───────────────────────────────────────────────────────

/**
 * Install a time-based trigger to run checkDieselEmails().
 * Run this function once from the Apps Script editor.
 */
function setupTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'checkDieselEmails')
    .forEach(t => ScriptApp.deleteTrigger(t));

  // Hourly to start — narrow to daily once the VinSolutions send time is known:
  //   ScriptApp.newTrigger('checkDieselEmails').timeBased().everyDays(1).atHour(7).create();
  ScriptApp.newTrigger('checkDieselEmails')
    .timeBased()
    .everyHours(1)
    .create();

  Logger.log('Trigger installed: checkDieselEmails runs every hour.');
}

/**
 * Main function — called by the time trigger.
 * Finds unread "Class A Diesels" emails and processes each one.
 */
function checkDieselEmails() {
  const props = PropertiesService.getScriptProperties();
  const ingestUrl = props.getProperty('NETLIFY_INGEST_URL');
  const apiKey    = props.getProperty('INGEST_API_KEY');

  if (!ingestUrl || !apiKey) {
    Logger.log('ERROR: NETLIFY_INGEST_URL and INGEST_API_KEY must be set in Script Properties.');
    return;
  }

  const query = 'from:' + VINSOLUTIONS_SENDER + ' subject:"' + REPORT_SUBJECT + '" is:unread has:attachment';
  const threads = GmailApp.search(query, 0, 20);

  if (threads.length === 0) {
    Logger.log('No unread "' + REPORT_SUBJECT + '" emails found.');
    return;
  }

  Logger.log('Found ' + threads.length + ' unread thread(s) for "' + REPORT_SUBJECT + '".');

  const processedLabel = getOrCreateLabel_('GARV-Diesel-Processed');
  const failedLabel    = getOrCreateLabel_('GARV-Diesel-Failed');

  for (const thread of threads) {
    for (const message of thread.getMessages()) {
      if (!message.isUnread()) continue;
      processMessage_(message, ingestUrl, apiKey, processedLabel, failedLabel);
    }
  }
}

// ── Internal helpers ──────────────────────────────────────────────────

function processMessage_(message, ingestUrl, apiKey, processedLabel, failedLabel) {
  const subject = message.getSubject();
  Logger.log('Processing: "' + subject + '"');

  const attachments = message.getAttachments({ includeInlineImages: false });
  const csvBlob = attachments.find(a =>
    a.getName().toLowerCase().endsWith('.csv') ||
    a.getContentType().toLowerCase().includes('csv') ||
    a.getContentType().toLowerCase().includes('text')
  );

  if (!csvBlob) {
    Logger.log('  SKIP: no CSV attachment found in "' + subject + '"');
    message.markRead();
    return;
  }

  const csvText  = csvBlob.getDataAsString('UTF-8');
  const today    = new Date();
  const fileName = 'class_a_diesels_' + Utilities.formatDate(today, Session.getScriptTimeZone(), 'yyyy-MM-dd') + '.csv';

  Logger.log('  File: ' + fileName);

  try {
    const response = UrlFetchApp.fetch(ingestUrl, {
      method:      'post',
      contentType: 'application/json',
      payload:     JSON.stringify({
        csvText:  csvText,
        fileName: fileName,
        apiKey:   apiKey,
      }),
      muteHttpExceptions: true,
    });

    const code = response.getResponseCode();
    const body = response.getContentText();

    if (code === 200) {
      let result;
      try { result = JSON.parse(body); } catch { result = {}; }
      Logger.log('  SUCCESS: ' + (result.totalLeads || '?') + ' leads, ' +
        (result.sold || '?') + ' sold.');
      message.markRead();
      processedLabel.addToThread(message.getThread());
      failedLabel.removeFromThread(message.getThread());
    } else {
      Logger.log('  ERROR ' + code + ': ' + body);
      message.markRead();
      failedLabel.addToThread(message.getThread());
    }
  } catch (e) {
    Logger.log('  EXCEPTION: ' + e.message);
    message.markRead();
    failedLabel.addToThread(message.getThread());
  }
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

// ── Diagnostics (run these manually to debug setup) ───────────────────

/**
 * Run this first to verify your Script Properties and Netlify connection.
 * Open View → Logs after running to see results.
 */
function diagnosePipeline() {
  Logger.log('=== GARV Diesel Pipeline Diagnostics ===');

  const props     = PropertiesService.getScriptProperties();
  const ingestUrl = props.getProperty('NETLIFY_INGEST_URL');
  const apiKey    = props.getProperty('INGEST_API_KEY');

  Logger.log('\n[1] Script Properties:');
  Logger.log('  NETLIFY_INGEST_URL : ' + (ingestUrl  ? ingestUrl  : 'MISSING ❌'));
  Logger.log('  INGEST_API_KEY     : ' + (apiKey     ? '*** set (length ' + apiKey.length + ') ✓' : 'MISSING ❌'));

  if (!ingestUrl || !apiKey) {
    Logger.log('\nFix script properties first, then re-run. Stopping here.');
    return;
  }

  Logger.log('\n[2] Netlify endpoint reachability:');
  try {
    const resp = UrlFetchApp.fetch(ingestUrl, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ apiKey: apiKey, csvText: '' }),
      muteHttpExceptions: true,
    });
    const code = resp.getResponseCode();
    const body = resp.getContentText();
    if (code === 401) {
      Logger.log('  Got 401 Unauthorized — API key mismatch. Check that INGEST_API_KEY matches Netlify env var exactly. ❌');
    } else if (code === 400) {
      Logger.log('  Got 400 (endpoint reachable, rejected empty csvText) ✓ — Netlify is up and responding.');
    } else if (code === 200) {
      Logger.log('  Got 200 ✓');
    } else if (code === 404) {
      Logger.log('  Got 404 — endpoint not found. Is the Netlify deploy with /api/ingest live? ❌');
      Logger.log('  Body: ' + body);
    } else if (code === 500) {
      Logger.log('  Got 500 — server error. Check Netlify function logs. Body: ' + body + ' ❌');
    } else {
      Logger.log('  Got HTTP ' + code + ': ' + body);
    }
  } catch (e) {
    Logger.log('  Exception reaching endpoint: ' + e.message + ' ❌');
    Logger.log('  Check that the URL is correct and Netlify is deployed.');
  }

  Logger.log('\n[3] Gmail search (all emails from VinSolutions with this subject, read or unread):');
  try {
    const all = GmailApp.search('from:' + VINSOLUTIONS_SENDER + ' subject:"' + REPORT_SUBJECT + '"', 0, 10);
    Logger.log('  Total threads found: ' + all.length);
    if (all.length === 0) {
      Logger.log('  No emails found. Possible causes:');
      Logger.log('    - No "Class A Diesels" emails have arrived yet in this Gmail account');
      Logger.log('    - The sender address or subject is different — check an actual email');
    } else {
      all.slice(0, 3).forEach((t, i) => {
        const msg = t.getMessages()[0];
        Logger.log('  Thread ' + (i+1) + ': subject="' + msg.getSubject() + '" from="' + msg.getFrom() + '"');
      });
    }
    const unread = GmailApp.search('from:' + VINSOLUTIONS_SENDER + ' subject:"' + REPORT_SUBJECT + '" is:unread has:attachment', 0, 10);
    Logger.log('  Unread with attachment: ' + unread.length);
  } catch (e) {
    Logger.log('  Gmail search failed: ' + e.message + ' ❌ (authorization issue?)');
  }

  Logger.log('\n[4] Installed triggers:');
  const triggers = ScriptApp.getProjectTriggers();
  if (triggers.length === 0) {
    Logger.log('  No triggers installed. Run setupTrigger() to install the check.');
  } else {
    triggers.forEach(t => {
      Logger.log('  • ' + t.getHandlerFunction() + ' — type: ' + t.getEventType());
    });
  }

  Logger.log('\n=== Done ===');
}
