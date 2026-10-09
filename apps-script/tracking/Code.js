// ========================================
// CREDENTIALS
// ========================================
const SECRETS_ = PropertiesService.getScriptProperties().getProperties();
const SHIPROCKET_EMAIL = SECRETS_['SHIPROCKET_EMAIL'] || 'Support@jmlooks.com';
const SHIPROCKET_PASSWORD = SECRETS_['SHIPROCKET_PASSWORD'] || '';   // <- paste the password between these quotes if you want it in code
const SHIPROCKET_AUTH_URL = 'https://apiv2.shiprocket.in/v1/external/auth/login';
const SHIPROCKET_TRACK_URL = 'https://apiv2.shiprocket.in/v1/external/courier/track/awb/';

const DELHIVERY_API_TOKEN = SECRETS_['DELHIVERY_API_TOKEN'] || '';   // <- paste the Delhivery token between these quotes
const DELHIVERY_BASE_URL = 'https://track.delhivery.com/api/v1/packages/json/';

const SHADOWFAX_API_TOKEN = SECRETS_['SHADOWFAX_API_TOKEN'] || '';   // <- paste the Shadowfax token between these quotes
const SHADOWFAX_BASE_URL = 'https://dale.shadowfax.in/api';
const SHADOWFAX_PREFIX = 'SF';           // Shadowfax AWBs start with "SF"

const SFX_BULK_URL = SHADOWFAX_BASE_URL + '/v4/clients/bulk_track/';
const SFX_BULK_SIZE = 50;                // API hard max is 50 AWBs/call

const BATCH_SIZE = 50;
const WRITE_EVERY = 100; // Write to sheet every 100 AWBs
const SHEET_NAME = 'Sheet2';
const AWB_COLUMN = 1;
const STATUS_COLUMN = 3;
const DELIVERY_DATE_COLUMN = 4;
// Columns are resolved from the header row at run time (see resolveColumns_).
// FIRST_SCAN_DATE_COLUMN used to be 7, the same as ORDER_DATE_COLUMN, which made
// the script overwrite "Order Placed" with the first-scan date and then skip the
// row forever on the next run. Never hardcode it again.
const HDR_ORDER_DATE = 'Order Placed';
const HDR_FIRST_SCAN = 'First Scan Date';
const HDR_LAST_CHECK = 'Last Check Result';
let DATE_GATE_ON = true;
const DELHIVERY_PREFIX = '2606';

const ORDER_DATE_FALLBACK_COL = 7;                       // column G "Order Placed"
const TRACK_FROM_DATE = new Date(2026, 3, 1);      // 1 April 2026 (month is 0-based: 3 = April)

// ========================================
// TERMINAL STATUS CHECK  (the key fix)
// ========================================
/**
 * EXACT match, not substring. "Undelivered-AT SOURCE HUB" must NOT count as
 * final just because it contains the letters "delivered".
 */
function isFinalStatus(status) {
  const s = status ? status.toString().toLowerCase().trim() : '';
  // Bare 'rto' and 'dto' are NOT final: they mean the return has started, not
  // that the parcel is back. Treating them as final is what stranded rows
  // with a status and no delivered date — the row was skipped on every later
  // run, so the date could never arrive. The journey ends at
  // 'rto delivered' / 'dto delivered', which is what the tracker now writes
  // once the courier hands the parcel over.
  return (
    s === 'delivered' ||
    s === 'rto delivered' ||
    s === 'dto delivered' ||
    s === 'lost' ||
    s === 'cancelled' ||
    s === 'permanently unavailable'
  );
}

// ========================================
// HELPER: is this status a terminal arrival?
// ========================================
/**
 * True when the parcel has finished moving and is physically somewhere.
 *
 * Covers BOTH a delivery to the customer and an RTO back to us. The date column
 * previously only filled for an exact "delivered", so every "RTO Delivered" row
 * was written with a blank date: 21,352 of them, which made it impossible to
 * tell WHEN a returned parcel arrived and therefore impossible to raise a
 * courier claim on one that never physically turned up.
 *
 * "Undelivered" and "Not Delivered" are excluded on purpose: those contain the
 * word "delivered" but mean the opposite.
 */
function isArrivalStatus(status) {
  // Underscores and hyphens become spaces first. Human-facing statuses read
  // "Not Delivered" while an API status_id reads "not_delivered"; without this
  // the negative check missed the underscore form and a FAILED delivery was
  // recorded as an arrival, which is the worst direction to get wrong.
  const s = (status || '').toString().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return false;
  if (s.indexOf('undelivered') > -1 || s.indexOf('not delivered') > -1) return false;
  // "RTO Delivered", "DTO Delivered", "Delivered", "Delivered to customer",
  // "Returned to Seller", and Shadowfax's "Returned To Client" for the same
  // event.
  return s.indexOf('delivered') > -1 ||
         s.indexOf('returned to seller') > -1 ||
         s.indexOf('returned to client') > -1;
}

// ========================================
// HELPER: Detect Courier by AWB
// ========================================
function detectCourier(awb) {
  const awbStr = awb.toString().trim();
  // Shadowfax AWBs start with "SF" (case-insensitive) — check first so an
  // SF-prefixed AWB never falls through to the Shiprocket default.
  if (awbStr.toUpperCase().startsWith(SHADOWFAX_PREFIX)) return 'SHADOWFAX';
  if (awbStr.startsWith(DELHIVERY_PREFIX)) return 'DELHIVERY';
  return 'SHIPROCKET';
}

// ========================================
// HELPER: start-date cutoff
// ========================================
/** True → skip this row (order placed before TRACK_FROM_DATE). */
function beforeStartDate(row, orderCol) {
  if (!DATE_GATE_ON) return false;
  if (!TRACK_FROM_DATE || !orderCol) return false;
  const d = row[orderCol - 1];
  // If the order-date cell is blank or not a real date, DON'T skip — better to
  // track an undated row than to silently drop it.
  if (!(d instanceof Date)) return false;
  return d < TRACK_FROM_DATE;
}

// ========================================
// HELPER: Write Updates to Sheet
// ========================================
function writeUpdatesToSheet(sheet, statusUpdates, deliveryDateUpdates, firstScanDateUpdates, resultUpdates) {
  statusUpdates.forEach(u => sheet.getRange(u.row, u.col).setValue(u.value));
  deliveryDateUpdates.forEach(u => {
    const cell = sheet.getRange(u.row, u.col);
    cell.setValue(u.value);
    cell.setNumberFormat("M/d/yyyy");
  });
  firstScanDateUpdates.forEach(u => {
    const cell = sheet.getRange(u.row, u.col);
    cell.setValue(u.value);
    cell.setNumberFormat("M/d/yyyy");
  });
  (resultUpdates || []).forEach(u => sheet.getRange(u.row, u.col).setValue(u.value));
  SpreadsheetApp.flush();
}

// ========================================
// SHIPROCKET: auth
// ========================================
function getShiprocketToken(forceRefresh) {
  const props = PropertiesService.getScriptProperties();
  if (!forceRefresh) {
    const cached = props.getProperty('SR_TOKEN');
    const exp = parseInt(props.getProperty('SR_TOKEN_EXP') || '0', 10);
    if (cached && exp - 43200 > Math.floor(Date.now() / 1000)) return cached;
  }
  const response = UrlFetchApp.fetch(SHIPROCKET_AUTH_URL, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ email: SHIPROCKET_EMAIL.trim(), password: SHIPROCKET_PASSWORD.trim() }),
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) {
    Logger.log('Shiprocket auth failed %s: %s', response.getResponseCode(), response.getContentText().slice(0, 300));
    return null;
  }
  const token = JSON.parse(response.getContentText()).token;
  if (!token) return null;
  let exp = Math.floor(Date.now() / 1000) + 864000;
  try {
    const payload = JSON.parse(
      Utilities.newBlob(Utilities.base64DecodeWebSafe(token.split('.')[1])).getDataAsString()
    );
    if (payload.exp) exp = payload.exp;
  } catch (e) { /* keep default */ }
  props.setProperty('SR_TOKEN', token);
  props.setProperty('SR_TOKEN_EXP', exp.toString());
  return token;
}

// Parse one AWB's tracking_data block into a result. Shared by the single and
// bulk paths so they behave identically.
function parseShiprocketTrackingData(td) {
  // Shiprocket returns HTTP 200 with a fully blank shipment_track and
  // error: "Ohh! This AWB has been cancelled." for cancelled shipments.
  // Without this check current_status is '' and the row was written as
  // "No Status", which is not terminal, so it sat in the in-transit bucket
  // for ever and was re-checked on every run.
  if (td && td.error && String(td.error).toLowerCase().indexOf('cancel') > -1) {
    return { status: 'Cancelled', deliveryDate: null, firstScanDate: null, found: true, source: 'Shiprocket' };
  }
  if (td && td.shipment_track && td.shipment_track.length > 0) {
    const st = td.shipment_track[0];
    // A blank current_status is NOT a real status. The bulk endpoint omits the
    // "this AWB has been cancelled" error that the single-AWB endpoint returns,
    // so report this as unresolved and let the single-AWB fallback decide. That
    // is what turns these rows into a terminal "Cancelled" instead of parking
    // them in the in-transit bucket for ever.
    if (!st.current_status) return { found: false, status: 'No Scan (SR)' };
    const status = st.current_status;
    let deliveryDate = null;
    // Was `=== 'delivered'`, so "RTO Delivered" never recorded a date.
    if (isArrivalStatus(status) && st.delivered_date) {
      deliveryDate = new Date(st.delivered_date);
      deliveryDate.setHours(0, 0, 0, 0);
    }
    let firstScanDate = null;
    const acts = td.shipment_track_activities;
    if (acts && acts.length > 0 && acts[acts.length - 1].date) {
      firstScanDate = new Date(acts[acts.length - 1].date);
      firstScanDate.setHours(0, 0, 0, 0);
    }
    return { status, deliveryDate, firstScanDate, found: true, source: 'Shiprocket' };
  }
  return { found: false, status: 'No Data (SR)' };
}

// ========================================
// SHIPROCKET: BULK track — POST many AWBs in ONE call.
// Returns a map awb -> result. Far fewer HTTP calls than one-at-a-time.
// ========================================
const SR_BULK_URL = 'https://apiv2.shiprocket.in/v1/external/courier/track/awbs';
const SR_BULK_SIZE = 45; // conservative; Shiprocket doesn't document a hard max

function trackWithShiprocketBulk(awbs, token) {
  const out = {};
  try {
    const response = UrlFetchApp.fetch(SR_BULK_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'Authorization': 'Bearer ' + token },
      payload: JSON.stringify({ awbs: awbs }),
      muteHttpExceptions: true
    });
    const code = response.getResponseCode();
    const text = response.getContentText();

    if (code === 200) {
      const data = JSON.parse(text) || {};
      // Response is keyed by AWB → { tracking_data: {...} }.
      awbs.forEach(awb => {
        const entry = data[awb];
        out[awb] = entry && entry.tracking_data
          ? parseShiprocketTrackingData(entry.tracking_data)
          : { found: false, status: 'No Data (SR)' };
      });
      return out;
    }

    // Whole-batch failure (auth/throttle/etc.): mark every AWB unfound so the
    // caller can fall back to single lookups (which surface per-AWB "cancelled").
    Logger.log('SR bulk HTTP %s: %s', code, text.slice(0, 200));
    awbs.forEach(awb => { out[awb] = { found: false, status: 'Bulk Error (SR)', retryable: true }; });
    return out;
  } catch (e) {
    awbs.forEach(awb => { out[awb] = { found: false, status: 'Bulk Error (SR)', retryable: true }; });
    return out;
  }
}

// ========================================
// SHIPROCKET: track one AWB  (fallback for AWBs the bulk call couldn't resolve;
// this is where the per-AWB "cancelled" 500 message is read)
// ========================================
function trackWithShiprocket(awb, token) {
  try {
    const response = UrlFetchApp.fetch(SHIPROCKET_TRACK_URL + encodeURIComponent(awb), {
      method: 'get',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      muteHttpExceptions: true
    });
    const code = response.getResponseCode();
    const text = response.getContentText();

    if (code === 200) {
      return parseShiprocketTrackingData((JSON.parse(text) || {}).tracking_data);
    }

    // Shiprocket returns HTTP 500 with a real reason. "This AWB has been
    // cancelled" is TERMINAL — read it and mark Cancelled, don't leave it stale.
    if (code >= 500) {
      let msg = '';
      try { msg = (JSON.parse(text).message || '').toLowerCase(); } catch (e) {}
      if (msg.indexOf('cancel') > -1) {
        return { status: 'Cancelled', found: true, source: 'Shiprocket' };
      }
      Logger.log('SR %s for %s: %s', code, awb, text.slice(0, 150));
      return { found: false, status: 'Server Error (SR)' };
    }

    if (code === 404) return { found: false, status: 'Not Found (SR)' };
    if (code === 429) return { found: false, status: 'Rate Limited (SR)' };
    return { found: false, status: 'Error (SR) ' + code };

  } catch (e) {
    return { found: false, status: 'Error (SR)' };
  }
}

// ========================================
// DELHIVERY: track a batch
// ========================================
function trackWithDelhivery(batch) {
  const waybills = batch.map(item => item.awb).join(',');
  const url = `${DELHIVERY_BASE_URL}?waybill=${encodeURIComponent(waybills)}`;
  const options = {
    method: 'get',
    headers: { 'Authorization': 'Token ' + DELHIVERY_API_TOKEN, 'Content-Type': 'application/json' },
    muteHttpExceptions: true
  };
  const results = [];
  try {
    const response = UrlFetchApp.fetch(url, options);
    const code = response.getResponseCode();
    const body = response.getContentText();
    if (code !== 200) {
      Logger.log('Delhivery HTTP %s. Body: %s', code, body.slice(0, 300));
      batch.forEach(item => results.push({ awb: item.awb, item, found: false, status: 'HTTP ' + code + ' (DL)', source: 'Delhivery' }));
      return results;
    }
    let json;
    try { json = JSON.parse(body); }
    catch (pe) {
      Logger.log('Delhivery non-JSON body: %s', body.slice(0, 300));
      batch.forEach(item => results.push({ awb: item.awb, item, found: false, status: 'Bad JSON (DL)', source: 'Delhivery' }));
      return results;
    }
    if (json.ShipmentData && Array.isArray(json.ShipmentData)) {
      const awbMap = {};
      batch.forEach(item => awbMap[item.awb] = item);
      json.ShipmentData.forEach(shipmentObj => {
        if (!shipmentObj.Shipment) return;
        const shipment = shipmentObj.Shipment;
        const item = awbMap[shipment.AWB];
        if (!item) return;
        const scans = shipment.Scans;
        if (scans && scans.length > 0) {
          const firstScan = scans[0].ScanDetail;
          const firstScanDateStr = firstScan.ScanTimestamp || firstScan.ScanDateTime || "";
          let firstScanDate = null;
          if (firstScanDateStr) { firstScanDate = new Date(firstScanDateStr); firstScanDate.setHours(0, 0, 0, 0); }
          const lastScan = scans[scans.length - 1].ScanDetail;
          let status = lastScan.Scan || "Unknown";
          const scanDate = lastScan.ScanTimestamp || lastScan.ScanDateTime || "";
          // Delhivery's last scan says "RTO" or "DTO" with no word for having
          // ARRIVED, so isArrivalStatus rejected both and no date was ever
          // written. The arrival is in the two fields beside it: ScanType "DL"
          // is the handover (an RTO still moving is "RT"), and Instructions
          // reads "RETURN Accepted".
          //
          // Measured on 80 parcels physically received at the warehouse: the
          // status text alone dated 0 of them; this dates 78, with 2 silent.
          //
          // DTO is kept separate on purpose. It is a parcel the courier
          // collected FROM the customer (OrderType "Pickup") — a customer
          // return, not a courier RTO — and merging the two would file
          // returns against the wrong counterparty.
          const scanType = (lastScan.ScanType || '').toString().toUpperCase();
          const arrivedBack =
            scanType === 'DL' &&
            /return accepted|delivered/i.test((lastScan.Instructions || '').toString());
          if (arrivedBack && /^rto$/i.test(status)) status = 'RTO Delivered';
          if (arrivedBack && /^dto$/i.test(status)) status = 'DTO Delivered';
          let deliveryDate = null;
          // Was `=== 'delivered'`, so an RTO arriving back recorded no date.
          if (isArrivalStatus(status) && scanDate) { deliveryDate = new Date(scanDate); deliveryDate.setHours(0, 0, 0, 0); }
          results.push({ awb: shipment.AWB, item, status, deliveryDate, firstScanDate, found: true, source: 'Delhivery' });
        } else {
          results.push({ awb: shipment.AWB, item, status: "No Scan Found", found: true, source: 'Delhivery' });
        }
      });
      batch.forEach(item => {
        if (!results.some(r => r.awb === item.awb)) {
          results.push({ awb: item.awb, item, found: false, status: 'Not In Response (DL)', source: 'Delhivery' });
        }
      });
    } else {
      Logger.log('Delhivery: no ShipmentData key. Body: %s', body.slice(0, 300));
      batch.forEach(item => results.push({ awb: item.awb, item, found: false, status: 'No ShipmentData (DL)', source: 'Delhivery' }));
    }
  } catch (err) {
    Logger.log('Delhivery batch error: ' + err.message);
    batch.forEach(item => results.push({ awb: item.awb, item, found: false, status: 'Exception (DL)', source: 'Delhivery' }));
  }
  return results;
}

// ========================================
// SHADOWFAX: shared parser — turns ONE order object (from the bulk data[] array)
// into a result. Uses status_display (human text, e.g. "Delivered to customer")
// rather than the machine `status` code. Delivery date = `created` of the
// delivered scan; first-scan date = earliest scan's `created`.
// ========================================
/**
 * Shadowfax status_ids that mean the parcel FINISHED moving and is physically
 * somewhere — at the customer, or back with us.
 *
 * An explicit list rather than a substring rule, because Shadowfax's wording
 * shares no vocabulary with the other two carriers: its RTO completion reads
 * "Returned To Client" (rto_d / rts_d), which contains neither "delivered" nor
 * "returned to seller".
 *
 * Deliberately NOT included, though they are RTO-flavoured: rts / rto (the
 * return was only INITIATED), recd_at_dc_rts and received_at_rts_hub (the
 * parcel is at a Shadowfax hub, not with us), and rts_ofd (out for delivery to
 * us). Dating a claim from any of those would start the clock before the parcel
 * reached our warehouse.
 */
const SFX_ARRIVED_IDS = [
  'delivered',   // to the customer
  'rto_d',       // returned to client, i.e. back to us
  'rts_d',       // same, under Shadowfax's other spelling
];

function parseShadowfaxOrder(o) {
  if (!o || typeof o !== 'object') return { found: false, status: 'No Data (SFX)' };
  const status = o.status_display || o.status || 'No Status (SFX)';
  const scans = Array.isArray(o.tracking_details) ? o.tracking_details : [];

  let deliveryDate = null;
  for (let i = scans.length - 1; i >= 0; i--) {
    const s = scans[i] || {};
    const id = (s.status_id || '').toString().toLowerCase().trim();
    const txt = (s.status || '').toString().toLowerCase();
    // Shadowfax is matched on an explicit status_id list, NOT on the prose.
    // Its terminal RTO scan reads "Returned To Client" under status_id rto_d
    // or rts_d — no "delivered", no "returned to seller" — so every
    // substring rule built for the other two carriers misses it completely.
    // Guessing at the wording is what produced zero captures; the id is the
    // stable field, so that is what is matched.
    const delivered = SFX_ARRIVED_IDS.indexOf(id) > -1 || (!id && isArrivalStatus(txt));
    if (delivered && s.created) { deliveryDate = new Date(s.created); deliveryDate.setHours(0, 0, 0, 0); break; }
  }

  let firstScanDate = null;
  for (let i = 0; i < scans.length; i++) {
    if (scans[i] && scans[i].created) { firstScanDate = new Date(scans[i].created); firstScanDate.setHours(0, 0, 0, 0); break; }
  }

  return { status: status, deliveryDate: deliveryDate, firstScanDate: firstScanDate, found: true, source: 'Shadowfax' };
}

// ========================================
// SHADOWFAX: BULK forward track — POST up to SFX_BULK_SIZE (50) AWBs in ONE call.
//   POST /v4/clients/bulk_track/  body { awb_numbers: [...] }.
// Returns a map awb -> result. Response `data[]` items carry their own awb_number,
// which we key on. Any AWB missing from the response is marked not-found.
// ========================================
function trackWithShadowfaxBulk(awbs) {
  const out = {};
  awbs.forEach(a => { out[a] = { found: false, status: 'No Data (SFX)' }; });
  try {
    const response = UrlFetchApp.fetch(SFX_BULK_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'Authorization': 'Token ' + SHADOWFAX_API_TOKEN },
      payload: JSON.stringify({ awb_numbers: awbs }),
      muteHttpExceptions: true
    });
    const code = response.getResponseCode();
    const text = response.getContentText();
    if (code !== 200) {
      Logger.log('SFX bulk HTTP %s: %s', code, text.slice(0, 200));
      awbs.forEach(a => { out[a] = { found: false, status: 'Bulk Error (SFX)' }; });
      return out;
    }
    const data = JSON.parse(text) || {};
    const arr = Array.isArray(data.data) ? data.data : [];
    arr.forEach(o => {
      const key = (o && o.awb_number ? o.awb_number : '').toString().trim();
      if (key && out.hasOwnProperty(key)) out[key] = parseShadowfaxOrder(o);
    });
    return out;
  } catch (e) {
    Logger.log('SFX bulk exception: %s', e.message);
    awbs.forEach(a => { out[a] = { found: false, status: 'Bulk Error (SFX)' }; });
    return out;
  }
}

// ========================================
// MAIN
// ========================================
function trackAWBsSmartRouting() {
  if (!credentialsReady_()) return;
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) { Logger.log(`Sheet "${SHEET_NAME}" not found!`); return; }
  const COLS = resolveColumns_(sheet);
  Logger.log('Columns -> order:%s firstScan:%s lastCheck:%s width:%s',
             COLS.orderDate, COLS.firstScan, COLS.lastCheck, COLS.width);

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('No data to process'); return; }

  const numDataRows = lastRow - 1;
  const readWidth = COLS.width;
  const allData = sheet.getRange(2, 1, numDataRows, readWidth).getValues();

  const shiprocketAWBs = [];
  const delhiveryAWBs = [];
  const shadowfaxAWBs = [];
  let skippedByDate = 0, skippedFinal = 0, skippedBlank = 0;
  for (let i = 0; i < allData.length; i++) {
    const row = allData[i];
    const awb = row[AWB_COLUMN - 1];
    const status = row[STATUS_COLUMN - 1];
    if (!awb || !awb.toString().trim()) { skippedBlank++; continue; }
    if (isFinalStatus(status)) { skippedFinal++; continue; }   // EXACT match
    if (beforeStartDate(row, COLS.orderDate)) { skippedByDate++; continue; }   // only orders from TRACK_FROM_DATE onward
    const item = { awb: awb.toString().trim(), rowIndex: i + 2, dataIndex: i };
    const courier = detectCourier(awb);
    if (courier === 'DELHIVERY') delhiveryAWBs.push(item);
    else if (courier === 'SHADOWFAX') shadowfaxAWBs.push(item);
    else shiprocketAWBs.push(item);
  }

  Logger.log('========================================');
  Logger.log('Total AWBs to check: %s (SR %s, Delhivery %s, Shadowfax %s)',
             shiprocketAWBs.length + delhiveryAWBs.length + shadowfaxAWBs.length,
             shiprocketAWBs.length, delhiveryAWBs.length, shadowfaxAWBs.length);
  Logger.log('Rows skipped: %s', numDataRows - (shiprocketAWBs.length + delhiveryAWBs.length + shadowfaxAWBs.length));
  Logger.log('========================================');

  Logger.log('Skipped -> blank AWB:%s already-final:%s before %s:%s',
             skippedBlank, skippedFinal,
             Utilities.formatDate(TRACK_FROM_DATE, Session.getScriptTimeZone(), 'dd-MMM-yyyy'), skippedByDate);

  let statusUpdates = [], deliveryDateUpdates = [], firstScanDateUpdates = [], resultUpdates = [];
  const RUN_STAMP = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd-MMM HH:mm');
  function noteCheck(item, text) {
    resultUpdates.push({ row: item.rowIndex, col: COLS.lastCheck, value: text + ' | ' + RUN_STAMP });
  }
  const existingDeliveryDates = allData.map(r => r[DELIVERY_DATE_COLUMN - 1]);
  const existingFirstScanDates = allData.map(r => r[COLS.firstScan - 1]);

  function pushResult(item, result) {
    statusUpdates.push({ row: item.rowIndex, col: STATUS_COLUMN, value: result.status });
    if (result.deliveryDate && !existingDeliveryDates[item.dataIndex]) {
      deliveryDateUpdates.push({ row: item.rowIndex, col: DELIVERY_DATE_COLUMN, value: result.deliveryDate });
    }
    noteCheck(item, 'OK: ' + result.status);
    if (result.firstScanDate && !existingFirstScanDates[item.dataIndex]) {
      firstScanDateUpdates.push({ row: item.rowIndex, col: COLS.firstScan, value: result.firstScanDate });
    }
  }
  function flushIfDue(force) {
    if (force || statusUpdates.length >= WRITE_EVERY || resultUpdates.length >= WRITE_EVERY) {
      if (statusUpdates.length || deliveryDateUpdates.length || firstScanDateUpdates.length || resultUpdates.length) {
        writeUpdatesToSheet(sheet, statusUpdates, deliveryDateUpdates, firstScanDateUpdates, resultUpdates);
        statusUpdates = []; deliveryDateUpdates = []; firstScanDateUpdates = []; resultUpdates = [];
      }
    }
  }

  // Shiprocket FIRST, in BULK — one POST per SR_BULK_SIZE AWBs instead of one GET
  // each. A single 20-AWB call replaces 20 requests, so it's ~20x fewer calls
  // and far faster. Only AWBs the bulk call can't resolve fall back to the
  // single GET (which reads the per-AWB "cancelled" 500 message).
  if (shiprocketAWBs.length > 0) {
    const token = getShiprocketToken(false);
    if (!token) {
      Logger.log('ERROR: no Shiprocket token');
      shiprocketAWBs.forEach(item => {
        statusUpdates.push({ row: item.rowIndex, col: STATUS_COLUMN, value: 'Auth Error' });
        noteCheck(item, 'FAIL: Auth Error (SR)');
      });
      flushIfDue(true);
    } else {
      const fallback = [];
      for (let b = 0; b < shiprocketAWBs.length; b += SR_BULK_SIZE) {
        const batch = shiprocketAWBs.slice(b, b + SR_BULK_SIZE);
        const map = trackWithShiprocketBulk(batch.map(it => it.awb), token);
        batch.forEach(item => {
          const r = map[item.awb];
          if (r && r.found) pushResult(item, r);
          else fallback.push(item); // unresolved → try single (catches cancelled)
        });
        flushIfDue(false);
        Logger.log('Shiprocket bulk: %s/%s', Math.min(b + SR_BULK_SIZE, shiprocketAWBs.length), shiprocketAWBs.length);
        if (b + SR_BULK_SIZE < shiprocketAWBs.length) Utilities.sleep(400);
      }
      flushIfDue(true);

      // Single-AWB fallback ONLY for the ones bulk couldn't resolve.
      for (let i = 0; i < fallback.length; i++) {
        const item = fallback[i];
        const result = trackWithShiprocket(item.awb, token);
        if (result && result.found) pushResult(item, result);
        else noteCheck(item, 'FAIL: ' + ((result && result.status) || 'No Response (SR)'));
        flushIfDue(false);
        if ((i + 1) % 100 === 0) Logger.log('SR fallback: %s/%s', i + 1, fallback.length);
        if (i < fallback.length - 1) Utilities.sleep(300);
      }
    }
  }
  flushIfDue(true);

  // Delhivery (batched) — runs after Shiprocket.
  for (let b = 0; b < delhiveryAWBs.length; b += BATCH_SIZE) {
    const batch = delhiveryAWBs.slice(b, b + BATCH_SIZE);
    trackWithDelhivery(batch).forEach(result => {
      if (result.found) pushResult(result.item, result);
      else noteCheck(result.item, 'FAIL: ' + (result.status || 'Unresolved (DL)'));
    });
    flushIfDue(false);
    Logger.log('Delhivery: %s/%s', Math.min(b + BATCH_SIZE, delhiveryAWBs.length), delhiveryAWBs.length);
    if (b + BATCH_SIZE < delhiveryAWBs.length) Utilities.sleep(500);
  }
  flushIfDue(true);

  // Shadowfax (BULK — up to 50 AWBs per POST via /v4/clients/bulk_track/) — runs last.
  const sfxMisses = [];
  for (let b = 0; b < shadowfaxAWBs.length; b += SFX_BULK_SIZE) {
    const batch = shadowfaxAWBs.slice(b, b + SFX_BULK_SIZE);
    const map = trackWithShadowfaxBulk(batch.map(it => it.awb));
    batch.forEach(item => {
      const r = map[item.awb];
      if (r && r.found) pushResult(item, r);
      else sfxMisses.push(item); // unresolved → ask Shiprocket before giving up
    });
    flushIfDue(false);
    Logger.log('Shadowfax bulk: %s/%s', Math.min(b + SFX_BULK_SIZE, shadowfaxAWBs.length), shadowfaxAWBs.length);
    if (b + SFX_BULK_SIZE < shadowfaxAWBs.length) Utilities.sleep(400);
  }
  flushIfDue(true);

  // An SF prefix does not mean Shadowfax booked it. Some SF waybills are
  // Shiprocket's "Shadowfax Fashion" service, and Shadowfax's own API returns
  // zero rows for those — the row was then written off as "No Data (SFX)" and,
  // because that is not an arrival status, never retried.
  //
  // Checked on the four such AWBs in the sheet (SF…KAA, 15 chars rather than
  // the usual 13): Shadowfax knows none of them, Shiprocket knows all four and
  // reports every one Delivered, courier "Shadowfax Fashion". One of them,
  // SF3156273662KAA, is the order that prompted this.
  if (sfxMisses.length) {
    const srToken = getShiprocketToken();
    if (!srToken) {
      Logger.log('Shadowfax fallback: no Shiprocket token, %s left unresolved', sfxMisses.length);
      sfxMisses.forEach(item => noteCheck(item, 'FAIL: No Data (SFX)'));
    } else {
      Logger.log('Shadowfax fallback -> Shiprocket for %s AWBs', sfxMisses.length);
      for (let i = 0; i < sfxMisses.length; i++) {
        const item = sfxMisses[i];
        const result = trackWithShiprocket(item.awb, srToken);
        if (result && result.found) pushResult(item, result);
        else noteCheck(item, 'FAIL: No Data (SFX+SR)');
        flushIfDue(false);
        if (i < sfxMisses.length - 1) Utilities.sleep(300);
      }
    }
    flushIfDue(true);
  }

  Logger.log('DONE. Re-run until "Total AWBs to check" reaches ~0 (6-min limit truncates big runs).');
}

// ========================================
// COLUMN RESOLUTION (header-driven)
// ========================================
/**
 * Resolves the columns this script writes to from the header row, creating
 * "First Scan Date" / "Last Check Result" at the end of the sheet if missing.
 * This is what prevents the old bug where first-scan dates were written into
 * the "Order Placed" column and rows were then skipped forever.
 */
function resolveColumns_(sheet) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(h => String(h == null ? '' : h).trim().toLowerCase());
  let width = lastCol;

  function findOrCreate(title, fallbackCol) {
    const i = headers.indexOf(title.toLowerCase());
    if (i !== -1) return i + 1;
    if (fallbackCol) return fallbackCol;
    width += 1;
    sheet.getRange(1, width).setValue(title).setFontWeight('bold');
    headers.push(title.toLowerCase());
    Logger.log('Created column %s for "%s"', width, title);
    return width;
  }

  const cols = {
    orderDate: findOrCreate(HDR_ORDER_DATE, ORDER_DATE_FALLBACK_COL),
    firstScan: findOrCreate(HDR_FIRST_SCAN, 0),
    lastCheck: findOrCreate(HDR_LAST_CHECK, 0)
  };

  if (cols.firstScan === cols.orderDate || cols.lastCheck === cols.orderDate ||
      cols.firstScan === cols.lastCheck ||
      cols.firstScan === STATUS_COLUMN || cols.firstScan === DELIVERY_DATE_COLUMN ||
      cols.firstScan === AWB_COLUMN || cols.lastCheck === STATUS_COLUMN ||
      cols.lastCheck === DELIVERY_DATE_COLUMN || cols.lastCheck === AWB_COLUMN) {
    throw new Error('Column collision: awb=' + AWB_COLUMN + ' status=' + STATUS_COLUMN +
      ' delivery=' + DELIVERY_DATE_COLUMN + ' order=' + cols.orderDate +
      ' firstScan=' + cols.firstScan + ' lastCheck=' + cols.lastCheck +
      '. Fix the header row before running.');
  }

  cols.width = Math.max(width, AWB_COLUMN, STATUS_COLUMN, DELIVERY_DATE_COLUMN,
                        cols.orderDate, cols.firstScan, cols.lastCheck);
  return cols;
}

// ========================================
// ONE-OFF: re-track rows the date gate is skipping
// ========================================
/**
 * Same run as trackAWBsSmartRouting() but ignores TRACK_FROM_DATE, so rows whose
 * "Order Placed" cell was corrupted by the old bug (or is simply older) get
 * checked once. Run it manually, not on a trigger.
 */
function trackAWBsIgnoreDateGate() {
  DATE_GATE_ON = false;
  try { trackAWBsSmartRouting(); } finally { DATE_GATE_ON = true; }
}

// ========================================
// ONE-TIME CREDENTIAL SETUP
// ========================================
/**
 * Paste the credentials below, run this once, then blank them out and save.
 * After that they live in Project Settings > Script Properties, not in the code.
 */
function setupCredentials() {
  const vals = {
    SHIPROCKET_EMAIL: '',
    SHIPROCKET_PASSWORD: '',
    DELHIVERY_API_TOKEN: '',
    SHADOWFAX_API_TOKEN: ''
  };
  const props = PropertiesService.getScriptProperties();
  const saved = Object.keys(vals).filter(k => vals[k]);
  saved.forEach(k => props.setProperty(k, vals[k]));
  Logger.log('Saved: %s', saved.join(', ') || 'nothing (all blank)');
  Logger.log('Now present in Script Properties: %s',
             ['SHIPROCKET_EMAIL','SHIPROCKET_PASSWORD','DELHIVERY_API_TOKEN','SHADOWFAX_API_TOKEN']
               .filter(k => props.getProperty(k)).join(', ') || 'none');
}

// ========================================
// DIAGNOSTIC: what is Delhivery actually returning?
// ========================================
/**
 * Takes the first few Delhivery-prefixed AWBs from the sheet, calls the API one
 * by one, and logs the raw HTTP code plus the start of the body. Run manually.
 */
function debugDelhivery() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  const last = sheet.getLastRow();
  const awbs = sheet.getRange(2, AWB_COLUMN, last - 1, 1).getValues()
    .map(r => String(r[0] || '').trim())
    .filter(a => a && detectCourier(a) === 'DELHIVERY')
    .slice(0, 3);

  Logger.log('Token present: %s (length %s)', !!DELHIVERY_API_TOKEN, DELHIVERY_API_TOKEN.length);
  Logger.log('Sample Delhivery AWBs: %s', awbs.join(', ') || 'NONE FOUND');

  awbs.forEach(awb => {
    const url = DELHIVERY_BASE_URL + '?waybill=' + encodeURIComponent(awb);
    const res = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { 'Authorization': 'Token ' + DELHIVERY_API_TOKEN, 'Content-Type': 'application/json' },
      muteHttpExceptions: true
    });
    Logger.log('--- %s -> HTTP %s ---', awb, res.getResponseCode());
    Logger.log(res.getContentText().slice(0, 600));
  });
}

// ========================================
// PREFLIGHT: refuse to run with missing credentials
// ========================================
/**
 * A blank token means every call comes back 401 and the sheet fills with junk
 * "FAIL" notes. Better to stop before writing anything.
 */
function credentialsReady_() {
  const need = {
    SHIPROCKET_EMAIL: SHIPROCKET_EMAIL,
    SHIPROCKET_PASSWORD: SHIPROCKET_PASSWORD,
    DELHIVERY_API_TOKEN: DELHIVERY_API_TOKEN,
    SHADOWFAX_API_TOKEN: SHADOWFAX_API_TOKEN
  };
  const missing = Object.keys(need).filter(k => !need[k]);
  if (missing.length) {
    const msg = 'Missing Script Properties: ' + missing.join(', ') +
                '. Fill them in via setupCredentials() or Project Settings > Script Properties, then run again. Nothing was written.';
    Logger.log(msg);
    try { SpreadsheetApp.getUi().alert(msg); } catch (e) {}
    return false;
  }
  Logger.log('Credentials OK (lengths: SR pwd %s, DL %s, SFX %s)',
             SHIPROCKET_PASSWORD.length, DELHIVERY_API_TOKEN.length, SHADOWFAX_API_TOKEN.length);
  return true;
}

// ========================================
// BACKFILL: fill the Delivered Date on rows that already have a final status
// ========================================
/**
 * Fills the Delivered Date on every row that lacks one, newest first.
 *
 * Runs as a self-chaining drain: each pass works until it is close to the
 * 6-minute execution limit, writes what it has, then schedules itself a minute
 * later and exits. One click empties the whole sheet.
 *
 * Newest first is deliberate. Recent parcels are the ones a courier claim can
 * still be raised on, and they are also the ones most likely to have a date the
 * carrier will actually return. Draining oldest-first would spend the first
 * several passes on 2024 rows nobody can act on.
 *
 * Progress lives in the sheet itself — a row either has a date or it does not —
 * so a pass that dies mid-way loses nothing and the next one resumes from the
 * same place. The only stored state is the cursor and the running tally, kept
 * in Script Properties.
 */

/** Stop collecting work at this point and write, leaving room to save. */
const DRAIN_BUDGET_MS = 4.5 * 60 * 1000;
/** Gap before the next chained pass. Short, but enough to release the lock. */
const DRAIN_RESUME_MS = 60 * 1000;
const DRAIN_PROP_TOTAL = 'BACKFILL_TOTAL_WRITTEN';
const DRAIN_PROP_PASSES = 'BACKFILL_PASSES';
/** Consecutive passes that made no progress; bounds retries on an outage. */
const DRAIN_PROP_STALLS = 'BACKFILL_STALLS';

function backfillDeliveryDates() {
  const started = Date.now();
  if (!credentialsReady_()) return;
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) { Logger.log('Sheet "%s" not found', SHEET_NAME); return; }
  const COLS = resolveColumns_(sheet);

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const allData = sheet.getRange(2, 1, lastRow - 1, COLS.width).getValues();

  const props = PropertiesService.getScriptProperties();
  const passes = Number(props.getProperty(DRAIN_PROP_PASSES) || 0) + 1;
  const totalSoFar = Number(props.getProperty(DRAIN_PROP_TOTAL) || 0);

  // Newest first. The sheet is in insertion order, so walking it backwards is
  // newest-first without needing to parse and sort 15,000 dates.
  const shiprocketAWBs = [], delhiveryAWBs = [], shadowfaxAWBs = [];
  let remaining = 0;
  for (let i = allData.length - 1; i >= 0; i--) {
    const row = allData[i];
    const awb = row[AWB_COLUMN - 1];
    const status = row[STATUS_COLUMN - 1];
    const date = row[DELIVERY_DATE_COLUMN - 1];
    if (!awb || !awb.toString().trim()) continue;
    if (date instanceof Date || (date && String(date).trim())) continue;
    // The sheet's status decides eligibility for Shiprocket and Delhivery,
    // whose wording isArrivalStatus was written against.
    //
    // Shadowfax is asked regardless of what the sheet says. Its statuses go
    // stale: rows reading "Customer_not_contactable" and "RTS In Process" were
    // found carrying a terminal rts_d scan, so the parcel was already back with
    // us while the sheet still showed it moving. Gating those on the stale
    // label would leave ~12,000 rows permanently unbackfillable. The carrier,
    // not the sheet, decides whether a date exists — and a row that has not
    // actually arrived simply returns no date and is left alone.
    // Delhivery is exempt for the same reason, and it is the reason this
    // backfill is needed at all. Its tracker wrote the bare scan code "RTO"
    // or "DTO", which contains no word isArrivalStatus recognises, so the
    // date was never captured AND the row is now invisible to the very pass
    // that would repair it.
    //
    // The exemption is not limited to rows reading RTO/DTO. Delhivery rows go
    // stale exactly as Shadowfax ones do: parcels scanned in at the warehouse
    // on 3 Oct were still reading "in_transit" in the sheet, last touched on
    // 19 and 22 Sept, while the carrier had them as "RETURN Accepted". A stale
    // label cannot be trusted to decide whether to ask. A row that has not
    // actually arrived returns no date and is left alone, so asking costs
    // nothing but an API call.
    const courierForGate = detectCourier(awb);
    if (courierForGate !== 'SHADOWFAX' &&
        courierForGate !== 'DELHIVERY' &&
        !isArrivalStatus(status)) continue;
    remaining++;
    // Collect a pass-sized chunk. The clock, not a fixed cap, decides how much
    // gets done: a pass that is mostly cache hits can cover far more than 3,000.
    if (shiprocketAWBs.length + delhiveryAWBs.length + shadowfaxAWBs.length >= 4000) continue;
    const item = { awb: awb.toString().trim(), rowIndex: i + 2, dataIndex: i };
    const courier = detectCourier(awb);
    if (courier === 'DELHIVERY') delhiveryAWBs.push(item);
    else if (courier === 'SHADOWFAX') shadowfaxAWBs.push(item);
    else shiprocketAWBs.push(item);
  }

  const queued = shiprocketAWBs.length + delhiveryAWBs.length + shadowfaxAWBs.length;
  Logger.log('=== Backfill pass %s: %s rows need a date, checking %s (SR %s, DL %s, SFX %s) ===',
             passes, remaining, queued,
             shiprocketAWBs.length, delhiveryAWBs.length, shadowfaxAWBs.length);
  if (!queued) {
    Logger.log('Backfill complete after %s passes, %s dates written in total.', passes, totalSoFar);
    cancelBackfillDrain_(true);
    return;
  }

  const outOfTime = function () { return Date.now() - started > DRAIN_BUDGET_MS; };
  const dateUpdates = [];
  const takeMap = function (batch, map) {
    batch.forEach(function (it) {
      const r = map[it.awb];
      if (r && r.found && r.deliveryDate) {
        dateUpdates.push({ row: it.rowIndex, col: DELIVERY_DATE_COLUMN, value: r.deliveryDate });
        // The status is written too, not just the date. A row repaired here
        // still reads the bare "RTO"/"DTO" that stranded it, which is not a
        // final status — so without this it would be re-fetched on every
        // later pass for ever, having already been answered.
        if (r.status && /delivered/i.test(r.status.toString())) {
          dateUpdates.push({ row: it.rowIndex, col: STATUS_COLUMN, value: r.status });
        }
      }
    });
  };

  // Shadowfax first: it is the carrier with the whole backlog, and its bulk
  // endpoint is the fastest of the three. Ordering it first means a pass that
  // runs out of time still made progress on the rows that need it most.
  //
  // Each carrier is wrapped: a token expiring or an endpoint throwing must not
  // kill the chain, because an unhandled error exits before the next pass is
  // scheduled and the drain would stop silently hours later.
  let stopped = false;
  try {
  for (let i = 0; i < shadowfaxAWBs.length; i += SFX_BULK_SIZE) {
    if (outOfTime()) { stopped = true; break; }
    const batch = shadowfaxAWBs.slice(i, i + SFX_BULK_SIZE);
    takeMap(batch, trackWithShadowfaxBulk(batch.map(function (it) { return it.awb; })));
  }

  if (!stopped && shiprocketAWBs.length) {
    const token = getShiprocketToken();
    if (token) {
      for (let i = 0; i < shiprocketAWBs.length; i += SR_BULK_SIZE) {
        if (outOfTime()) { stopped = true; break; }
        const batch = shiprocketAWBs.slice(i, i + SR_BULK_SIZE);
        takeMap(batch, trackWithShiprocketBulk(batch.map(function (it) { return it.awb; }), token));
      }
    } else {
      Logger.log('No Shiprocket token, skipped %s rows', shiprocketAWBs.length);
    }
  }

  if (!stopped) {
    for (let i = 0; i < delhiveryAWBs.length; i += BATCH_SIZE) {
      if (outOfTime()) { stopped = true; break; }
      trackWithDelhivery(delhiveryAWBs.slice(i, i + BATCH_SIZE)).forEach(function (r) {
        if (r && r.found && r.deliveryDate && r.item) {
          dateUpdates.push({ row: r.item.rowIndex, col: DELIVERY_DATE_COLUMN, value: r.deliveryDate });
        }
      });
    }
  }
  } catch (e) {
    // Keep whatever this pass already collected, and treat it as a short pass
    // rather than a finished drain, so the next one retries the same rows.
    Logger.log('Pass %s aborted: %s', passes, e && e.message ? e.message : e);
    stopped = true;
  }

  writeUpdatesToSheet(sheet, [], dateUpdates, [], []);
  const total = totalSoFar + dateUpdates.length;
  props.setProperty(DRAIN_PROP_TOTAL, String(total));
  props.setProperty(DRAIN_PROP_PASSES, String(passes));
  Logger.log('Pass %s wrote %s dates (%s total). %s rows still blank.%s',
             passes, dateUpdates.length, total, remaining - dateUpdates.length,
             stopped ? ' Hit the time budget mid-pass.' : '');

  // A pass that asked every queued row and wrote nothing means the rest have
  // not arrived. Shadowfax rows are queued on a blank date alone, so they are
  // re-asked for ever and "remaining" never reaches zero on its own — this is
  // the real stopping condition.
  if (!stopped && dateUpdates.length === 0) {
    Logger.log('Nothing new this pass. Every arrived parcel now has a date; the rest are still moving. Done after %s passes, %s dates.', passes, total);
    cancelBackfillDrain_(true);
    return;
  }

  // A pass that writes nothing AND was cut short has made no progress. Allow a
  // couple of those for a transient outage, then stop: an aborted pass always
  // reschedules, so a dead token would otherwise retry every minute until
  // someone noticed.
  const stalls = dateUpdates.length === 0
    ? Number(props.getProperty(DRAIN_PROP_STALLS) || 0) + 1
    : 0;
  props.setProperty(DRAIN_PROP_STALLS, String(stalls));
  if (stalls >= 3) {
    Logger.log('Three passes in a row made no progress — stopping. Check the log above for the cause, then run backfillDeliveryDates again.');
    cancelBackfillDrain_(true);
    return;
  }

  scheduleBackfillDrain_();
  Logger.log('Next pass in %s seconds. Close the editor if you like — it keeps running.',
             DRAIN_RESUME_MS / 1000);
}

/** Queues the next pass, replacing any trigger an earlier pass left behind. */
function scheduleBackfillDrain_() {
  cancelBackfillDrain_(false);
  ScriptApp.newTrigger('backfillDeliveryDates')
    .timeBased()
    .after(DRAIN_RESUME_MS)
    .create();
}

/** Removes the chain's triggers. `finished` also clears the running tally. */
function cancelBackfillDrain_(finished) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'backfillDeliveryDates') ScriptApp.deleteTrigger(t);
  });
  if (finished) {
    const props = PropertiesService.getScriptProperties();
    props.deleteProperty(DRAIN_PROP_TOTAL);
    props.deleteProperty(DRAIN_PROP_PASSES);
    props.deleteProperty(DRAIN_PROP_STALLS);
  }
}

/**
 * Stops the drain by hand.
 *
 * The chain is self-limiting, but a run against a bad token would otherwise
 * keep rescheduling itself every minute, so there is an explicit off switch.
 */
function stopBackfillDrain() {
  cancelBackfillDrain_(true);
  Logger.log('Backfill drain stopped. Run backfillDeliveryDates to start again.');
  try { SpreadsheetApp.getUi().alert('Backfill drain stopped.'); } catch (e) {}
}

// ========================================
// Clears this run's notes from the Last Check Result column.
// ========================================
function clearLastCheckColumn() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  const cols = resolveColumns_(sheet);
  const last = sheet.getLastRow();
  if (last < 2) return;
  sheet.getRange(2, cols.lastCheck, last - 1, 1).clearContent();
  Logger.log('Cleared column %s, rows 2-%s', cols.lastCheck, last);
}

// ========================================
// RECO: dashboard IN TRANSIT / UNKNOWN list vs live courier status
// ========================================
const RECO_DATA = '213605~152980560274267~i 213610~152980560274283~l 213678~77105236924~u 213882~26061111277080~u 213891~152980550339645~i 213947~77902784960~i 214099~152980560275159~i 214139~152980560275268~l 214183~77901662425~i 214494~1904076320520~u 214498~1904076320520~u 214648~77108333153~i 214831~39598662645235~l 214941~SF39213246563~i 215019~39598663259404~u 215065~77904088415~i 215075~152980560276685~i 215199~152980560276680~i 215202~152980560276677~i 215264~77904130382~i 215427~77905535713~i 215593~152980560277266~i 215599~39598663233014~i 215619~39598663540535~i 215696~39598663234672~i 215780~26061111271502~i 215933~77908184130~i 215962~39598663898773~u 216180~39598663482144~i 216375~39598663879151~i 216493~77116091555~i 216578~39598664786675~i 216633~7D136695442~i 216679~26061111277194~u 216739~39598664164994~i 216789~26061111277323~u 216801~77909180392~i 216813~39598664165005~i 216827~26061111277371~u 216857~7D136683855~i 216919~77119025970~u 216955~39598664152210~i 217032~77117603275~i 217146~39598664597572~i 217186~1904076801475~i 217248~39598664890990~u 217346~77911852421~i 217364~39598664598250~i 217373~1904076854734~i 217378~153508462019459~i 217449~39598664787832~i 217483~1904076801560~i 217503~77910973011~i 217831~1904076956186~i 217840~77911819941~i 217878~26061111270220~u 218081~26061111277684~u 218082~39598665113225~i 218129~1904076956842~i 218256~19041947299053~i 218265~26061111270776~u 218275~7D136709986~i 218377~26061111277710~u 218523~152980560281914~i 218667~SF37809290610~l 218669~152980560282394~u 218671~39598665708074~i 218712~1904077081836~i 218763~26061111277780~u 218897~39598665708586~i 218947~152980560282388~l 219031~26061111271432~u 219033~26061111271421~u 219171~26061111277360~u 219233~SF38282682828~u 219305~26061111277205~u 219378~SF38282714507~u 219424~SF38283374770~u 219498~77134214124~u 219524~SF38282714757~l 219581~26061111277975~u 219601~26061111277964~u 219610~77139560256~i 219718~26061111273731~u 219835~SF38230556839~i 219893~26061111274383~u 219906~SF38284465043~u 219907~26061111273510~u 219916~SF38303923921~u 219952~26061111274033~u 219955~SRSC9158346886~i 219968~26061111277721~u 220068~SF38303927493~u 220326~SF38303927949~l 220411~SF38326009574~l 220447~26061111278255~u 220479~26061111277651~u 220480~26061111277651~u 220591~26061111278292~u 220593~26061111278303~u 220594~SF38303927231~u 220732~SF38525073819~u 220853~SF38303924051~i 220876~26061111275142~u 220919~SF38326010625~u 221058~26061111275186~u 221080~SF38326013476~l 221138~26061111276450~u 221156~26061111275271~u 221454~26061111275363~u 221519~26061111275341~u 221535~77925561641~i 222008~26061111276273~u 222031~26061111276321~u 222088~26061111276575~u 222102~26061111276225~u 222105~SF38749085821~u 222107~26061111276520~u 222108~26061111276262~u 222109~26061111276192~u 222214~SF38814935656~u 222247~SF38814939151~i 222302~26061111276236~u 222425~26061111276365~u 222529~77932084591~i 223260~77932085932~i 223263~SF38854862392~u 223285~77149148193~i 223309~77932088533~i 223311~77932086190~i 223315~77932085560~i 223348~77932085744~i 223349~77932087085~i 223436~39598669242234~i 223456~SF38965821515~u 223615~SF38965820784~u 223619~39598669551446~i 223621~SF38965821590~u 223731~SF38965821068~u 223901~SF38965819710~u 224065~SF39027462288~i 224151~SF1956769048KAA~u 224264~SF39027461220~u 224269~SF39370411390~i 224284~39598669939530~i 224492~SF3156266066KAA~u 224658~SRSC6853909470~i 224683~SF39213243731~u 224770~SF39238006794~i 224826~SF39238006528~i 224853~SF39238008952~i 225018~77937832501~i 225098~SRSC6924928271~i 225281~SF39289236119~u 225416~SF38965821577~i 225452~SF39238006705~u 225453~77160606530~i 225598~SF39289237039~u 225638~SF39289235813~u 225666~SF39238006553~i 225698~SF3156273651KAA~u 225721~SF39289237285~l 225789~SF38965820792~u 225894~SF39370411755~i 225895~26061111282061~u';

function recoDashboard() {
  if (!credentialsReady_()) return;
  const rows = RECO_DATA.trim().split(/\s+/).map(function (x) {
    const p = x.split('~');
    return { order: p[0], awb: p[1], dash: { i: 'in_transit', l: 'lost', u: 'unknown' }[p[2]] };
  });
  Logger.log('Reco input: %s orders with an AWB', rows.length);

  const sr = [], dl = [], sfx = [];
  rows.forEach(function (r, i) {
    r.rowIndex = i + 2; r.dataIndex = i;
    const c = detectCourier(r.awb);
    if (c === 'DELHIVERY') dl.push(r); else if (c === 'SHADOWFAX') sfx.push(r); else sr.push(r);
  });
  Logger.log('Routing -> SR %s, DL %s, SFX %s', sr.length, dl.length, sfx.length);

  const live = {};
  const token = getShiprocketToken(false);
  for (var b = 0; b < sr.length; b += SR_BULK_SIZE) {
    const batch = sr.slice(b, b + SR_BULK_SIZE);
    const map = trackWithShiprocketBulk(batch.map(function (it) { return it.awb; }), token);
    batch.forEach(function (it) {
      const r = map[it.awb];
      live[it.awb] = (r && r.found) ? r.status : null;
      if (!live[it.awb]) {
        const one = trackWithShiprocket(it.awb, token);
        live[it.awb] = (one && one.found) ? one.status : ('NOT FOUND: ' + ((one && one.status) || 'no response'));
      }
    });
    Utilities.sleep(300);
  }
  for (var d = 0; d < dl.length; d += BATCH_SIZE) {
    trackWithDelhivery(dl.slice(d, d + BATCH_SIZE)).forEach(function (res) {
      live[res.item.awb] = res.found ? res.status : ('NOT FOUND: ' + (res.status || 'unresolved'));
    });
    Utilities.sleep(400);
  }
  for (var f = 0; f < sfx.length; f += SFX_BULK_SIZE) {
    const batch = sfx.slice(f, f + SFX_BULK_SIZE);
    const map = trackWithShadowfaxBulk(batch.map(function (it) { return it.awb; }));
    batch.forEach(function (it) {
      const r = map[it.awb];
      live[it.awb] = (r && r.found) ? r.status : ('NOT FOUND: ' + ((r && r.status) || 'no data'));
    });
    Utilities.sleep(400);
  }

  function bucket(st) {
    const t = String(st || '').toLowerCase();
    if (t.indexOf('not found') === 0) return 'NO DATA';
    if (t.indexOf('rto') > -1 || t.indexOf('return') > -1) return 'RTO / RETURNED';
    if (t.indexOf('deliver') > -1) return 'DELIVERED';
    if (t.indexOf('cancel') > -1) return 'CANCELLED';
    if (t.indexOf('lost') > -1 || t.indexOf('damage') > -1) return 'LOST / DAMAGED';
    if (t.indexOf('no status') > -1 || t.indexOf('no scan') > -1 || t.indexOf('no data') > -1) return 'NO SCAN';
    return 'GENUINELY MOVING';
  }

  const counts = {}, samples = {};
  rows.forEach(function (r) {
    r.live = live[r.awb];
    r.bucket = bucket(r.live);
    counts[r.bucket] = (counts[r.bucket] || 0) + 1;
    if (!samples[r.bucket]) samples[r.bucket] = [];
    if (samples[r.bucket].length < 6) samples[r.bucket].push('#' + r.order + ' ' + r.dash + ' -> ' + r.live);
  });

  Logger.log('================ RECO RESULT ================');
  Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).forEach(function (k) {
    Logger.log('%s: %s', k, counts[k]);
    samples[k].forEach(function (x) { Logger.log('    %s', x); });
  });
  const wrong = rows.filter(function (r) { return ['DELIVERED', 'RTO / RETURNED', 'CANCELLED'].indexOf(r.bucket) > -1; });
  Logger.log('--------------------------------------------');
  Logger.log('SETTLED but still shown as in transit/unknown/lost: %s of %s', wrong.length, rows.length);
  Logger.log('Orders: %s', wrong.map(function (r) { return '#' + r.order; }).join(', '));
}

// ========================================
// DIAGNOSTIC: what does Shiprocket really say about the "No Status" AWBs,
// and what does Sheet2 currently hold for the 19 settled orders?
// ========================================
function debugNoScan() {
  if (!credentialsReady_()) return;
  const token = getShiprocketToken(false);

  // 1. Raw single-AWB response for a sample of the "No Scan" shipments.
  const sample = ['152980560274267', '152980550339645', '77902784960',
                  '152980560275159', '77901662425', '77108333153'];
  sample.forEach(function (awb) {
    const res = UrlFetchApp.fetch(SHIPROCKET_TRACK_URL + awb, {
      method: 'get',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    const body = res.getContentText();
    Logger.log('--- %s HTTP %s ---', awb, code);
    Logger.log(body.slice(0, 700));
  });

  // 2. What Sheet2 holds right now for the 19 orders the reco called settled.
  const settled = ['77105236924','1904076320520','39598663259404','26061111271502',
                   '39598663898773','77119025970','39598664890990','77134214124',
                   '77139560256','SF38749085821','SF38965821515','SF38965820784',
                   'SF39027462288','SF39370411390','SF39213243731','SF39289236119',
                   'SF39238006705','SF3156273651KAA'];
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  const cols = resolveColumns_(sheet);
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, cols.width).getValues();
  const idx = {};
  data.forEach(function (r, i) { const a = String(r[AWB_COLUMN - 1] || '').trim(); if (a) idx[a] = i; });
  Logger.log('===== SHEET2 CURRENT VALUES FOR THE SETTLED ONES =====');
  settled.forEach(function (a) {
    const i = idx[a];
    if (i === undefined) { Logger.log('%s -> NOT IN SHEET2', a); return; }
    Logger.log('%s -> status "%s" | lastCheck "%s"', a, data[i][STATUS_COLUMN - 1], data[i][cols.lastCheck - 1]);
  });
}

function debugMissingInSheet() {
  const probe = ['77105236924', '1904076320520', '39598663259404', '77139560256', '152980560274267'];
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  const last = sheet.getLastRow();
  const col = sheet.getRange(2, AWB_COLUMN, last - 1, 1).getValues();
  Logger.log('Sheet2 rows scanned: %s', col.length);
  probe.forEach(function (p) {
    var exact = -1, loose = -1;
    for (var i = 0; i < col.length; i++) {
      var raw = col[i][0];
      var str = String(raw == null ? '' : raw).trim();
      if (str === p) { exact = i + 2; break; }
      if (loose === -1 && str.replace(/\D/g, '') === p) loose = i + 2;
    }
    Logger.log('%s -> exact row %s | loose row %s', p, exact, loose);
  });
  // what do the first few AWB cells actually look like?
  Logger.log('Sample cell types: %s', col.slice(0, 5).map(function (r) {
    return typeof r[0] + '(' + String(r[0]) + ')';
  }).join(' , '));
}

/**
 * Surveys Shadowfax rows: which sheet statuses exist, how many still lack a
 * date, and what the API actually returns for a sample of them.
 *
 * Written because the RTO fix was made against an ASSUMED status_id. Guessing
 * twice would waste another six backfill runs, so this prints the real labels
 * on both sides — the sheet's and the carrier's — before anything else runs.
 */
function debugShadowfaxRtoPayload() {
  if (!credentialsReady_()) return;
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) { Logger.log('Sheet "%s" not found', SHEET_NAME); return; }
  const COLS = resolveColumns_(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const allData = sheet.getRange(2, 1, lastRow - 1, COLS.width).getValues();

  // 1. Every distinct Shadowfax status, with how many are missing a date.
  const tally = {};
  let sfxTotal = 0;
  const sampleByStatus = {};
  for (let i = 0; i < allData.length; i++) {
    const awb = allData[i][AWB_COLUMN - 1];
    if (!awb || !awb.toString().trim()) continue;
    if (detectCourier(awb) !== 'SHADOWFAX') continue;
    sfxTotal++;
    const status = (allData[i][STATUS_COLUMN - 1] || '(blank)').toString().trim();
    const date = allData[i][DELIVERY_DATE_COLUMN - 1];
    const hasDate = date instanceof Date || (date && String(date).trim());
    if (!tally[status]) tally[status] = { total: 0, noDate: 0, eligible: isArrivalStatus(status) };
    tally[status].total++;
    if (!hasDate) {
      tally[status].noDate++;
      if (!sampleByStatus[status]) sampleByStatus[status] = awb.toString().trim();
    }
  }

  Logger.log('=== %s Shadowfax rows, by sheet status ===', sfxTotal);
  Object.keys(tally)
    .sort(function (a, b) { return tally[b].noDate - tally[a].noDate; })
    .forEach(function (k) {
      const t = tally[k];
      Logger.log('%s | total %s | no date %s | backfill eligible: %s',
                 k, t.total, t.noDate, t.eligible ? 'YES' : 'no  <-- never backfilled');
    });

  // 2. What the API returns for one undated row per status. Includes the
  //    INELIGIBLE ones: if the carrier reports an arrival for a status the
  //    sheet spells differently, isArrivalStatus is what needs widening.
  const picked = Object.keys(sampleByStatus).map(function (k) { return sampleByStatus[k]; }).slice(0, 20);
  if (!picked.length) { Logger.log('No undated Shadowfax rows.'); return; }
  Logger.log('=== sampling %s AWBs (one per status) ===', picked.length);

  const res = UrlFetchApp.fetch(SFX_BULK_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Token ' + SHADOWFAX_API_TOKEN },
    payload: JSON.stringify({ awb_numbers: picked }),
    muteHttpExceptions: true
  });
  Logger.log('HTTP %s', res.getResponseCode());
  if (res.getResponseCode() !== 200) { Logger.log(res.getContentText().slice(0, 500)); return; }

  const arr = (JSON.parse(res.getContentText()) || {}).data || [];
  Logger.log('Response carried %s of %s AWBs', arr.length, picked.length);
  arr.forEach(function (o) {
    const scans = Array.isArray(o.tracking_details) ? o.tracking_details : [];
    Logger.log('--- %s | status_display=%s | %s scans',
               o.awb_number, o.status_display || o.status, scans.length);
    scans.slice(-6).forEach(function (sc) {
      Logger.log('    status_id=%s | status=%s | created=%s', sc.status_id, sc.status, sc.created);
    });
    Logger.log('    -> parsed deliveryDate: %s', parseShadowfaxOrder(o).deliveryDate);
  });
}

// ========================================
// DAILY SCHEDULE
// ========================================
/*
 * There is deliberately NO trigger installer here.
 *
 * trackAWBsSmartRouting is already scheduled every 4 hours through a trigger
 * created in the Apps Script UI. Triggers live in project settings, not in
 * code, so a function that created its own would have to delete that one first
 * and would silently replace a 4-hourly run with something coarser.
 *
 * Every 4 hours is also the better schedule: RTO claims are aged from the date
 * the courier returned the parcel, so the sooner a date lands the more accurate
 * the claim age. Change the interval in Triggers in the sidebar, not here.
 */

/** Lists what is currently scheduled, so the state is never a guess. */
function showSchedule() {
  const rows = ScriptApp.getProjectTriggers().map(function (t) {
    return t.getHandlerFunction() + '  (' + t.getEventType() + ')';
  });
  const msg = rows.length ? rows.join('\n') : 'Nothing is scheduled.';
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert('Scheduled jobs:\n\n' + msg); } catch (e) {}
}

/** Sheet menu, so none of this depends on finding a function in the dropdown. */
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('Tracking')
      .addItem('Run tracking now', 'trackAWBsSmartRouting')
      .addSeparator()
      .addItem('Fill missing dates (drain)', 'backfillDeliveryDates')
      .addItem('Stop the drain', 'stopBackfillDrain')
      .addSeparator()
      .addItem('Show schedule', 'showSchedule')
      .addToUi();
  } catch (e) {
    // A container-bound script with no UI context (a trigger run) must not fail here.
  }
}

/**
 * Prints exactly what Shiprocket returns for a few named AWBs, and what the
 * sheet currently holds for them.
 *
 * For the case where a tracking page plainly reads DELIVERED but our row says
 * unknown. The answer is always one of: the AWB is not in the sheet at all, it
 * is in the sheet under a different string, Shiprocket does not recognise it,
 * or it answers with a status our parser drops. Guessing between those wastes a
 * run each time, so this shows all four at once.
 */
function debugNamedAwbs() {
  if (!credentialsReady_()) return;
  var TARGETS = ['77105236924', '1904076320520', '39598663259404'];

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  var COLS = resolveColumns_(sheet);
  var lastRow = sheet.getLastRow();
  var allData = sheet.getRange(2, 1, lastRow - 1, COLS.width).getValues();

  Logger.log('=== what the sheet holds ===');
  TARGETS.forEach(function (t) {
    var hits = [];
    for (var i = 0; i < allData.length; i++) {
      var raw = allData[i][AWB_COLUMN - 1];
      if (!raw) continue;
      var a = raw.toString().trim();
      if (a === t || a.replace(/[^0-9a-zA-Z]/g, '') === t) {
        hits.push('row ' + (i + 2) +
                  ' | awb="' + a + '"' +
                  ' | status="' + allData[i][STATUS_COLUMN - 1] + '"' +
                  ' | date="' + allData[i][DELIVERY_DATE_COLUMN - 1] + '"' +
                  ' | routed=' + detectCourier(a));
      }
    }
    Logger.log('%s -> %s', t, hits.length ? hits.join(' ;; ') : 'NOT IN SHEET');
  });

  Logger.log('=== what Shiprocket says ===');
  var token = getShiprocketToken();
  if (!token) { Logger.log('no Shiprocket token'); return; }
  var map = trackWithShiprocketBulk(TARGETS, token);
  TARGETS.forEach(function (t) {
    var r = map[t];
    Logger.log('%s -> found=%s status=%s date=%s',
               t, r && r.found, r && r.status, r && r.deliveryDate);
  });

  Logger.log('=== raw bulk payload ===');
  var res = UrlFetchApp.fetch(SR_BULK_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ awbs: TARGETS.join(',') }),
    muteHttpExceptions: true
  });
  Logger.log('HTTP %s', res.getResponseCode());
  Logger.log(res.getContentText().slice(0, 3000));
}

/**
 * Measures the Delhivery RTO-date hit rate before committing to a full drain.
 *
 * 2,893 rows classified RTO carry no return date and nearly all are Delhivery.
 * A full drain is six passes and thousands of calls, so this samples a few
 * hundred first and reports how many actually come back with a date. If the
 * rate is near zero the drain is not worth running and the reason is in the
 * log; if it is high, the drain is worth the passes.
 */
function debugDelhiveryRtoDateRate() {
  if (!credentialsReady_()) return;
  var SAMPLE = 200;

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  var COLS = resolveColumns_(sheet);
  var lastRow = sheet.getLastRow();
  var allData = sheet.getRange(2, 1, lastRow - 1, COLS.width).getValues();

  // Newest first, matching how the drain works.
  var picked = [];
  for (var i = allData.length - 1; i >= 0 && picked.length < SAMPLE; i--) {
    var awb = allData[i][AWB_COLUMN - 1];
    var date = allData[i][DELIVERY_DATE_COLUMN - 1];
    if (!awb) continue;
    var a = awb.toString().trim();
    if (detectCourier(a) !== 'DELHIVERY') continue;
    if (date instanceof Date || (date && String(date).trim())) continue;
    picked.push({ awb: a, rowIndex: i + 2, dataIndex: i,
                  sheetStatus: allData[i][STATUS_COLUMN - 1] });
  }
  Logger.log('Sampling %s undated Delhivery rows (newest first)', picked.length);
  if (!picked.length) { Logger.log('None found.'); return; }

  var withDate = 0, found = 0, notFound = 0;
  var statusTally = {};
  var shown = 0;
  for (var b = 0; b < picked.length; b += BATCH_SIZE) {
    var batch = picked.slice(b, b + BATCH_SIZE);
    trackWithDelhivery(batch).forEach(function (r) {
      if (!r) return;
      if (r.found) {
        found++;
        var st = (r.status || '(blank)').toString();
        statusTally[st] = (statusTally[st] || 0) + 1;
        if (r.deliveryDate) withDate++;
        else if (shown < 12) {
          shown++;
          Logger.log('  no date: %s | sheet="%s" | delhivery="%s"',
                     r.awb, r.item && r.item.sheetStatus, st);
        }
      } else {
        notFound++;
        if (shown < 12) { shown++; Logger.log('  NOT FOUND: %s | %s', r.awb, r.status); }
      }
    });
    Utilities.sleep(400);
  }

  Logger.log('=== result over %s sampled ===', picked.length);
  Logger.log('answered by Delhivery : %s', found);
  Logger.log('not found             : %s', notFound);
  Logger.log('CARRY A DATE          : %s  (%s%%)', withDate,
             picked.length ? Math.round(withDate * 1000 / picked.length) / 10 : 0);
  Logger.log('--- what Delhivery calls them ---');
  Object.keys(statusTally).sort(function (a, b2) { return statusTally[b2] - statusTally[a]; })
    .forEach(function (k) {
      Logger.log('  %s  %s   (arrival? %s)', statusTally[k], k, isArrivalStatus(k));
    });
}

