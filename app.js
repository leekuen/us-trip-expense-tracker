/* ---------- constants ---------- */
const DB_NAME = 'usExpenseDB';
const DB_VERSION = 1;
const STORE_EXPENSES = 'expenses';
const STORE_META = 'meta';

const DEFAULT_CATEGORIES = ['🚗 交通', '🏨 住宿', '🍽 三餐', '☕️ 小食', '🤡 娛樂', '🛍️ 伴手禮', '🎲 其他'];
const DEFAULT_METHODS = ['現金', '刷卡', '電子支付', '中信刷卡'];
const TWD_BUDGET_CAP = 317200; // STUF計畫核定經費：機票40,000＋生活費270,000＋保險費6,000＋簽證費1,200

let db = null;
let state = {
  syncUrl: '',
  lastPullTime: '',
  categories: DEFAULT_CATEGORIES,
  methods: DEFAULT_METHODS,
  pendingOptions: [], // [{field:'category'|'method', value}] typed via the "✏️ 自訂" chip, waiting to sync to the sheet's dropdown
  syncing: false,
  syncErrors: {}, // per-item last failure, keyed by localId or 'opt:field:value' (in-memory, for the 同步狀態 panel)
  lastSyncError: null, // {message, at} of the most recent cycle-level failure
  lastSyncOk: '',
};

/* ---------- tiny helpers ---------- */
function uid() {
  return 'e_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}
function nowISO() { return new Date().toISOString(); }
function $(sel) { return document.querySelector(sel); }
function fmtMoney(n) {
  if (n == null || n === '') return '';
  const num = Number(n);
  if (Number.isNaN(num)) return '';
  return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
function showToast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.remove('show'), 2400);
}

/* ---------- IndexedDB ---------- */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE_EXPENSES)) {
        const store = d.createObjectStore(STORE_EXPENSES, { keyPath: 'localId' });
        store.createIndex('lastModified', 'lastModified');
        store.createIndex('sheetRow', 'sheetRow');
      }
      if (!d.objectStoreNames.contains(STORE_META)) {
        d.createObjectStore(STORE_META, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function tx(storeName, mode) {
  return db.transaction(storeName, mode).objectStore(storeName);
}
function idbGetAll(storeName) {
  return new Promise((resolve, reject) => {
    const req = tx(storeName, 'readonly').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbPut(storeName, value) {
  return new Promise((resolve, reject) => {
    const req = tx(storeName, 'readwrite').put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbDelete(storeName, key) {
  return new Promise((resolve, reject) => {
    const req = tx(storeName, 'readwrite').delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
async function loadMeta() {
  const rows = await idbGetAll(STORE_META);
  for (const r of rows) {
    if (r.key === 'syncUrl') state.syncUrl = r.value;
    if (r.key === 'lastPullTime') state.lastPullTime = r.value;
    if (r.key === 'categories' && r.value && r.value.length) state.categories = r.value;
    if (r.key === 'methods' && r.value && r.value.length) state.methods = r.value;
    if (r.key === 'pendingOptions' && Array.isArray(r.value)) state.pendingOptions = r.value;
    if (r.key === 'lastSyncOk') state.lastSyncOk = r.value;
  }
}
function saveMeta(key, value) {
  return idbPut(STORE_META, { key, value });
}

/* ---------- custom category/method entered via the "✏️ 自訂" chip ---------- */
// Adds the value to the local chip list immediately (so it's usable right away,
// even offline) and queues it to be written into the sheet's dropdown list on
// the next successful sync.
async function registerCustomOption(field, value) {
  const list = field === 'category' ? state.categories : state.methods;
  if (list.includes(value)) return;
  list.push(value);
  await saveMeta(field === 'category' ? 'categories' : 'methods', list);
  if (!state.pendingOptions.some((o) => o.field === field && o.value === value)) {
    state.pendingOptions.push({ field, value });
    await saveMeta('pendingOptions', state.pendingOptions);
  }
}

async function pushPendingOptions() {
  if (!state.pendingOptions.length) return;
  const remaining = [];
  const skippedOptions = [];
  const queue = state.pendingOptions;
  for (let i = 0; i < queue.length; i++) {
    const opt = queue[i];
    const key = 'opt:' + opt.field + ':' + opt.value;
    try {
      await callSync('addOption', opt);
      delete state.syncErrors[key];
    } catch (e) {
      // Errors that retrying can never fix (the sheet's dropdown isn't a plain
      // list, column not found): drop the option instead of showing "待同步"
      // forever. The value is already usable locally and in the sheet's cells.
      if (e.server && /不是簡單清單型態|找不到欄位|缺少要新增的值/.test(e.message)) {
        delete state.syncErrors[key];
        skippedOptions.push(opt.value);
        continue;
      }
      console.error('addOption sync failed, will retry later', e);
      state.syncErrors[key] = { message: e.message, at: nowISO() };
      remaining.push(opt);
      if (e.network) { remaining.push(...queue.slice(i + 1)); break; }
    }
  }
  state.pendingOptions = remaining;
  await saveMeta('pendingOptions', remaining);
  if (skippedOptions.length) {
    showToast('這些選項無法自動加進試算表的下拉選單（不影響記帳）：' + skippedOptions.join('、'));
  }
}

/* ---------- expense CRUD (local-first) ---------- */
async function getAllExpenses() {
  const rows = await idbGetAll(STORE_EXPENSES);
  return rows.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.lastModified.localeCompare(a.lastModified));
}

function buildExpenseRecord(fields) {
  return {
    localId: uid(),
    date: fields.date,
    category: fields.category,
    item: fields.item,
    method: fields.method,
    amountUSD: fields.amountUSD,
    amountTWD: fields.amountTWD,
    note: fields.note || '',
    actualCardTWD: fields.actualCardTWD,
    lastModified: nowISO(),
    sheetRow: null,
    syncStatus: 'pending-create',
  };
}

async function addExpense(fields) {
  await idbPut(STORE_EXPENSES, buildExpenseRecord(fields));
  await renderAll();
  runSync();
}

async function addExpensesBatch(fieldsList) {
  for (const fields of fieldsList) await idbPut(STORE_EXPENSES, buildExpenseRecord(fields));
  await renderAll();
  runSync();
}

async function updateExpense(localId, fields) {
  const rows = await idbGetAll(STORE_EXPENSES);
  const rec = rows.find((r) => r.localId === localId);
  if (!rec) return;
  Object.assign(rec, fields, { lastModified: nowISO() });
  rec.syncStatus = rec.sheetRow ? 'pending-update' : 'pending-create';
  await idbPut(STORE_EXPENSES, rec);
  await renderAll();
  runSync();
}

async function deleteExpense(localId) {
  const rows = await idbGetAll(STORE_EXPENSES);
  const rec = rows.find((r) => r.localId === localId);
  if (!rec) return;
  if (!rec.sheetRow) {
    await idbDelete(STORE_EXPENSES, localId);
  } else {
    rec.syncStatus = 'pending-delete';
    rec.lastModified = nowISO();
    await idbPut(STORE_EXPENSES, rec);
  }
  await renderAll();
  runSync();
}

/* ---------- sync engine ---------- */
// Content-Type text/plain avoids a CORS preflight (Apps Script doesn't answer OPTIONS).
// err.network = the request never produced a usable answer (offline, bad URL,
// login page instead of JSON) so there's no point retrying the rest of this
// cycle; err.server = the backend answered with an error for this request only.
async function callSync(action, payload) {
  let json;
  try {
    const resp = await fetch(state.syncUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, ...payload }),
    });
    json = await resp.json();
  } catch (e) {
    const err = new Error(e instanceof SyntaxError
      ? '伺服器回應不是 JSON，可能是 Apps Script 網址或「誰可以存取」設定有誤'
      : '連線失敗（網路中斷或網址不正確）：' + e.message);
    err.network = true;
    throw err;
  }
  if (json.status !== 'ok') {
    const err = new Error(json.message || '伺服器回報失敗');
    err.server = true;
    throw err;
  }
  return json;
}

function setSyncBadge(text, cls) {
  const el = $('#syncBadge');
  el.textContent = text;
  el.className = 'sync-badge' + (cls ? ' ' + cls : '');
}

async function updateSyncBadge() {
  const rows = await idbGetAll(STORE_EXPENSES);
  const pendingCount = rows.filter((r) => r.syncStatus && r.syncStatus.startsWith('pending')).length + state.pendingOptions.length;
  $('#offlineBanner').classList.toggle('show', !navigator.onLine);
  if (state.syncing) { setSyncBadge('🔄 同步中…', 'syncing'); return; }
  if (!state.syncUrl) { setSyncBadge('⚙️ 尚未設定同步', ''); return; }
  if (!navigator.onLine) { setSyncBadge(pendingCount ? `📴 離線・待同步 ${pendingCount}` : '📴 離線', 'offline'); return; }
  if (pendingCount) { setSyncBadge(`⏳ 待同步 ${pendingCount}`, 'pending'); return; }
  setSyncBadge('✅ 已同步', '');
}

let syncQueued = false;
async function runSync() {
  // The guard below must run with no `await` ahead of it — otherwise two
  // rapid calls (e.g. add-then-delete within the same second) can both read
  // state.syncing as false before either sets it, and run two overlapping
  // pull/push cycles that race on the same IndexedDB records.
  if (!state.syncUrl || !navigator.onLine) { await updateSyncBadge(); return; }
  if (state.syncing) { syncQueued = true; return; }
  state.syncing = true;
  await updateSyncBadge();
  try {
    await pullFromSheet();
    await pushPendingOptions();
    await pushPendingToSheet();
    state.lastSyncError = null;
    state.lastSyncOk = nowISO();
    await saveMeta('lastSyncOk', state.lastSyncOk);
  } catch (e) {
    console.error('sync failed', e);
    state.lastSyncError = { message: e.message, at: nowISO() };
    showToast('同步失敗：' + e.message);
  } finally {
    state.syncing = false;
    await updateSyncBadge();
    await renderAll();
    if (syncQueued) { syncQueued = false; runSync(); }
  }
}

// A backend that predates the timezone fix serializes Date cells as UTC ISO
// strings ("2026-08-31T16:00:00.000Z" for 9/1 in a GMT+8 sheet). Convert those
// back to the calendar date in Taipei so the app doesn't depend on whether the
// Apps Script was redeployed; also accept a typed "2026/9/1".
function normalizeRemoteDate(v) {
  const s = String(v == null ? '' : v).trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d)) {
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    }
  }
  const m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return s;
}

async function pullFromSheet() {
  const fullPull = !state.lastPullTime;
  const res = await callSync('pull', { since: state.lastPullTime || '' });
  if (res.categories && res.categories.length) { state.categories = res.categories; await saveMeta('categories', res.categories); }
  if (res.methods && res.methods.length) { state.methods = res.methods; await saveMeta('methods', res.methods); }

  const rows = await idbGetAll(STORE_EXPENSES);
  const bySheetRow = new Map(rows.filter((r) => r.sheetRow).map((r) => [r.sheetRow, r]));

  for (const remote of res.rows) {
    const local = bySheetRow.get(remote.row);
    const data = { ...remote.data, date: normalizeRemoteDate(remote.data && remote.data.date) };
    if (local) {
      const localPending = local.syncStatus && local.syncStatus.startsWith('pending');
      const remoteWins = !localPending || remote.lastModified > local.lastModified;
      if (!remoteWins) continue; // local edit is newer, will be pushed instead
      if (remote.deleted) {
        await idbDelete(STORE_EXPENSES, local.localId);
      } else {
        Object.assign(local, data, { lastModified: remote.lastModified, syncStatus: 'synced', sheetRow: remote.row });
        await idbPut(STORE_EXPENSES, local);
      }
    } else if (!remote.deleted) {
      await idbPut(STORE_EXPENSES, {
        localId: uid(),
        ...data,
        lastModified: remote.lastModified,
        sheetRow: remote.row,
        syncStatus: 'synced',
      });
    }
  }
  if (fullPull) {
    // A full pull returns every row that exists in the sheet, so a synced
    // local record whose row didn't come back no longer exists there (e.g.
    // its row was deleted and later rows shifted up). Drop it so the phone
    // matches the sheet; records with unsynced changes are left alone.
    const seen = new Set(res.rows.filter((r) => !r.deleted).map((r) => r.row));
    for (const r of await idbGetAll(STORE_EXPENSES)) {
      if (r.sheetRow && r.syncStatus === 'synced' && !seen.has(r.sheetRow)) await idbDelete(STORE_EXPENSES, r.localId);
    }
  }
  state.lastPullTime = res.serverTime;
  await saveMeta('lastPullTime', res.serverTime);
}

async function pushPendingToSheet() {
  const rows = await idbGetAll(STORE_EXPENSES);
  const pending = rows.filter((r) => r.syncStatus && r.syncStatus.startsWith('pending')).sort((a, b) => a.lastModified.localeCompare(b.lastModified));
  for (const rec of pending) {
    try {
      await pushOneRecord(rec);
      delete state.syncErrors[rec.localId];
    } catch (e) {
      console.error('push failed for', rec.localId, e);
      state.syncErrors[rec.localId] = { message: e.message, at: nowISO() };
      // A server-side rejection of this one record must not block the ones
      // queued behind it; a network failure means the rest would fail too.
      if (e.network) throw e;
    }
  }
}

async function pushOneRecord(rec) {
  const data = {
    date: rec.date, category: rec.category, item: rec.item, method: rec.method,
    amountUSD: rec.amountUSD, amountTWD: rec.amountTWD, note: rec.note,
    actualCardTWD: rec.actualCardTWD, lastModified: rec.lastModified,
  };
  const queuedAt = rec.lastModified;

  if (rec.syncStatus === 'pending-create') {
    // localId lets the backend recognize a retried request (e.g. the phone
    // lost signal right after the server created the row but before the
    // response arrived) and return the existing row instead of appending
    // a duplicate.
    const res = await callSync('create', { data, localId: rec.localId });
    // Re-read instead of writing the pre-await snapshot back — the user
    // may have edited or deleted this record locally while the request
    // was in flight, and blindly overwriting would either lose that edit
    // or resurrect a record the user just deleted.
    const current = (await idbGetAll(STORE_EXPENSES)).find((r) => r.localId === rec.localId);
    if (!current) return; // deleted locally in the meantime; the row now exists orphaned in the sheet, which is an acceptable rare edge case
    current.sheetRow = res.row;
    current.syncStatus = current.lastModified === queuedAt ? 'synced' : 'pending-update';
    await idbPut(STORE_EXPENSES, current);
  } else if (rec.syncStatus === 'pending-update') {
    await callSync('update', { row: rec.sheetRow, data, localId: rec.localId });
    const current = (await idbGetAll(STORE_EXPENSES)).find((r) => r.localId === rec.localId);
    if (!current) return;
    if (current.lastModified === queuedAt) current.syncStatus = 'synced';
    await idbPut(STORE_EXPENSES, current);
  } else if (rec.syncStatus === 'pending-delete') {
    await callSync('delete', { row: rec.sheetRow, data: { lastModified: rec.lastModified } });
    const current = (await idbGetAll(STORE_EXPENSES)).find((r) => r.localId === rec.localId);
    // Only remove locally if nothing changed the record since we queued
    // this delete (e.g. the user didn't reopen and edit it mid-flight).
    if (current && current.lastModified === queuedAt) await idbDelete(STORE_EXPENSES, rec.localId);
  }
}

/* ---------- rendering ---------- */
async function renderAll() {
  const rows = await getAllExpenses();
  renderSummary(rows);
  renderList(rows);
  await updateSyncBadge();
  await renderSyncDiag();
}

function fmtTime(iso) {
  if (!iso) return '尚無紀錄';
  const d = new Date(iso);
  return isNaN(d) ? String(iso) : d.toLocaleString('zh-TW', { hour12: false });
}

// 同步狀態 panel: what is pending and why, plus how the totals are made up, so
// a stuck "待同步" or a total that disagrees with the sheet can be diagnosed
// from the phone instead of guessed at.
async function renderSyncDiag() {
  const box = $('#syncDiag');
  if (!box) return;
  const all = await idbGetAll(STORE_EXPENSES);
  const live = all.filter((r) => r.syncStatus !== 'pending-delete');
  const pending = all.filter((r) => r.syncStatus && r.syncStatus.startsWith('pending'));
  const label = { 'pending-create': '新增', 'pending-update': '修改', 'pending-delete': '刪除' };
  const sumTWD = live.reduce((s, r) => s + (Number(r.amountTWD) || 0), 0);
  const sumUSD = live.reduce((s, r) => s + (Number(r.amountUSD) || 0), 0);
  const usdOnly = live.filter((r) => !(Number(r.amountTWD) > 0) && Number(r.amountUSD) > 0);

  let html = '';
  if (!state.syncUrl) html += '<div class="diag-error">尚未設定同步網址，資料只存在這支手機上。</div>';
  if (state.lastSyncError) {
    html += `<div class="diag-error">最近一次同步失敗（${escapeHtml(fmtTime(state.lastSyncError.at))}）：${escapeHtml(state.lastSyncError.message)}</div>`;
  }
  html += `<div class="hint">最近一次成功同步：${escapeHtml(fmtTime(state.lastSyncOk))}</div>`;
  html += `<div class="hint">本機共 ${live.length} 筆・台幣合計 NT$${fmtMoney(sumTWD)}・美金合計 $${fmtMoney(sumUSD)}</div>`;
  if (usdOnly.length) {
    html += `<div class="hint">其中 ${usdOnly.length} 筆只填了美金（不計入台幣預算）：${escapeHtml(usdOnly.slice(0, 5).map((r) => r.item || '(未命名)').join('、'))}${usdOnly.length > 5 ? '…' : ''}</div>`;
  }

  if (!pending.length && !state.pendingOptions.length) {
    html += '<div class="hint">目前沒有待同步項目 ✅</div>';
  } else {
    html += '<div class="diag-list">';
    for (const r of pending) {
      const err = state.syncErrors[r.localId];
      const amt = r.amountTWD ? 'NT$' + fmtMoney(r.amountTWD) : (r.amountUSD ? '$' + fmtMoney(r.amountUSD) : '');
      html += `<div class="diag-item">
        <div><span class="diag-tag">${label[r.syncStatus] || '待處理'}</span> ${escapeHtml(r.date || '')} ${escapeHtml(r.item || '(未命名)')} ${escapeHtml(amt)}${r.sheetRow ? `（試算表第 ${r.sheetRow} 列）` : ''}</div>
        ${err ? `<div class="diag-error">失敗原因：${escapeHtml(err.message)}</div>` : '<div class="hint">還沒收到失敗訊息（可能還沒輪到或正在同步）</div>'}
        <button class="icon-btn" data-discard="${escapeHtml(r.localId)}">放棄同步這筆</button>
      </div>`;
    }
    state.pendingOptions.forEach((o, i) => {
      const err = state.syncErrors['opt:' + o.field + ':' + o.value];
      html += `<div class="diag-item">
        <div><span class="diag-tag">選項</span> ${o.field === 'category' ? '分類' : '付款方式'}：${escapeHtml(o.value)}</div>
        ${err ? `<div class="diag-error">失敗原因：${escapeHtml(err.message)}</div>` : '<div class="hint">還沒收到失敗訊息</div>'}
        <button class="icon-btn" data-discard-opt="${i}">放棄寫入試算表下拉選單</button>
      </div>`;
    });
    html += '</div>';
  }
  box.innerHTML = html;
}

async function discardPending(localId) {
  const rec = (await idbGetAll(STORE_EXPENSES)).find((r) => r.localId === localId);
  if (!rec) return;
  // create/delete: the sheet never had it / should not have it, so drop it
  // locally. update: keep the local values and just stop retrying.
  if (rec.syncStatus === 'pending-update') {
    rec.syncStatus = 'synced';
    await idbPut(STORE_EXPENSES, rec);
  } else {
    await idbDelete(STORE_EXPENSES, localId);
  }
  delete state.syncErrors[localId];
  await renderAll();
}

function wireSyncDiag() {
  $('#syncDiag').addEventListener('click', async (e) => {
    const id = e.target.dataset && e.target.dataset.discard;
    const optIdx = e.target.dataset && e.target.dataset.discardOpt;
    if (id) {
      if (!confirm('放棄後這筆不會再嘗試同步。確定嗎？')) return;
      await discardPending(id);
    } else if (optIdx !== undefined) {
      if (!confirm('放棄後這個新選項不會寫進試算表的下拉選單（本機仍可使用）。確定嗎？')) return;
      state.pendingOptions.splice(Number(optIdx), 1);
      await saveMeta('pendingOptions', state.pendingOptions);
      await renderAll();
    }
  });
  $('#retrySyncBtn').addEventListener('click', () => {
    if (!state.syncUrl) { showToast('請先設定 Apps Script 網址'); return; }
    runSync();
  });
  $('#fullResyncBtn').addEventListener('click', async () => {
    if (!state.syncUrl) { showToast('請先設定 Apps Script 網址'); return; }
    if (!confirm('會以試算表為準重建手機上的紀錄：已同步的紀錄改成跟試算表一致，試算表上已不存在的會從手機移除；尚未同步的本機變更會保留。確定嗎？')) return;
    state.lastPullTime = '';
    await saveMeta('lastPullTime', '');
    runSync();
  });
}

function renderSummary(allRows) {
  const rows = allRows.filter((r) => r.syncStatus !== 'pending-delete'); // already deleted from the user's point of view
  const totalUSD = rows.reduce((s, r) => s + (Number(r.amountUSD) || 0), 0);
  const totalTWD = rows.reduce((s, r) => s + (Number(r.amountTWD) || 0), 0);
  $('#totalUSD').textContent = '$' + fmtMoney(totalUSD);
  $('#totalTWD').textContent = 'NT$' + fmtMoney(totalTWD);

  const remaining = TWD_BUDGET_CAP - totalTWD;
  const el = $('#budgetRemaining');
  el.textContent = (remaining < 0 ? '-NT$' + fmtMoney(-remaining) : 'NT$' + fmtMoney(remaining));
  el.classList.toggle('over-budget', remaining < 0);
}

function renderList(rows) {
  const container = $('#expenseList');
  if (!rows.length) {
    container.innerHTML = '<div class="empty-state">還沒有記帳紀錄，點右下角 ＋ 開始記帳</div>';
    return;
  }
  const groups = new Map();
  for (const r of rows) {
    const key = r.date || '未填日期';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  let html = '';
  for (const [date, items] of groups) {
    html += `<div class="day-group"><div class="day-group-title">${escapeHtml(date)}</div>`;
    for (const r of items) {
      const pending = r.syncStatus && r.syncStatus.startsWith('pending');
      html += `
        <div class="expense-item ${pending ? 'pending' : ''}" data-id="${r.localId}">
          <div class="exp-left">
            <div class="exp-title">${escapeHtml(r.item || '(未命名)')}</div>
            <div class="exp-meta">
              <span class="exp-tag">${escapeHtml(r.category || '')}</span>
              <span class="exp-tag">${escapeHtml(r.method || '')}</span>
              ${pending ? '<span class="exp-tag pending-tag">待同步</span>' : ''}
              ${r.note ? '　' + escapeHtml(r.note) : ''}
            </div>
          </div>
          <div class="exp-amount">
            ${r.amountUSD ? '$' + fmtMoney(r.amountUSD) : ''}
            <small>${r.amountTWD ? 'NT$' + fmtMoney(r.amountTWD) : ''}</small>
          </div>
        </div>`;
    }
    html += '</div>';
  }
  container.innerHTML = html;
  container.querySelectorAll('.expense-item').forEach((el) => {
    el.addEventListener('click', () => openExpenseModal(el.dataset.id));
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- modal ---------- */
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const CUSTOM_CHIP_SENTINEL = '__custom__';

function chipGroupHtml(name, options, selected) {
  const isCustom = !!selected && !options.includes(selected);
  const groupValue = isCustom ? CUSTOM_CHIP_SENTINEL : (selected || '');
  const chips = options.map((o) => `<button type="button" class="chip ${o === selected ? 'selected' : ''}" data-value="${escapeHtml(o)}">${escapeHtml(o)}</button>`).join('');
  const otherLabel = name === 'category' ? '分類' : '付款方式';
  const otherChip = `<button type="button" class="chip chip-other ${isCustom ? 'selected' : ''}" data-other="1">✏️ 自訂</button>`;
  const otherInput = `<input type="text" id="${name}OtherInput" class="other-input" placeholder="輸入自訂${otherLabel}" value="${isCustom ? escapeHtml(selected) : ''}" style="display:${isCustom ? 'block' : 'none'}">`;
  return `<div class="chip-group" id="${name}Chips" data-value="${escapeHtml(groupValue)}">${chips}${otherChip}</div>${otherInput}`;
}
function wireChipGroup(name) {
  const group = $(`#${name}Chips`);
  const otherInput = $(`#${name}OtherInput`);
  group.addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    group.querySelectorAll('.chip').forEach((c) => c.classList.toggle('selected', c === btn));
    if (btn.dataset.other) {
      group.dataset.value = CUSTOM_CHIP_SENTINEL;
      otherInput.style.display = 'block';
      otherInput.focus();
    } else {
      group.dataset.value = btn.dataset.value;
      otherInput.style.display = 'none';
      otherInput.value = '';
    }
  });
}
function resolveChipValue(name) {
  const group = $(`#${name}Chips`);
  if (group.dataset.value === CUSTOM_CHIP_SENTINEL) return $(`#${name}OtherInput`).value.trim();
  return group.dataset.value;
}

async function openExpenseModal(localId) {
  let rec = null;
  if (localId) {
    const rows = await idbGetAll(STORE_EXPENSES);
    rec = rows.find((r) => r.localId === localId);
  }
  const isEdit = !!rec;
  const selectedCategory = rec ? rec.category : state.categories[0];
  const selectedMethod = rec ? rec.method : state.methods[0];

  const root = $('#modalRoot');
  root.innerHTML = `
    <div class="modal-backdrop" id="modalBackdrop">
      <div class="modal-sheet">
        <h3>${isEdit ? '編輯記帳' : '新增記帳'}</h3>
        <div class="form-row">
          <label>日期</label>
          <input type="date" id="f_date" value="${rec ? rec.date : todayStr()}">
        </div>
        <div class="form-row">
          <label>大項目</label>
          ${chipGroupHtml('category', state.categories, selectedCategory)}
        </div>
        <div class="form-row">
          <label>支付方式</label>
          ${chipGroupHtml('method', state.methods, selectedMethod)}
        </div>
        <div class="form-row">
          <label>項目名稱</label>
          <input type="text" id="f_item" value="${rec ? escapeHtml(rec.item) : ''}" placeholder="例如：午餐">
        </div>
        <div class="form-row-split">
          <div class="form-row">
            <label>金額（美金）</label>
            <input type="number" inputmode="decimal" id="f_usd" value="${rec && rec.amountUSD != null ? rec.amountUSD : ''}">
          </div>
          <div class="form-row">
            <label>金額（台幣）</label>
            <input type="number" inputmode="decimal" id="f_twd" value="${rec && rec.amountTWD != null ? rec.amountTWD : ''}">
          </div>
        </div>
        <div class="form-row">
          <label>備註</label>
          <textarea id="f_note">${rec ? escapeHtml(rec.note) : ''}</textarea>
        </div>
        <div class="modal-actions">
          ${isEdit ? '<button class="delete-btn" id="deleteBtn">刪除</button>' : ''}
          <button class="cancel-btn" id="cancelBtn">取消</button>
          <button class="save-btn" id="saveBtn">儲存</button>
        </div>
      </div>
    </div>`;

  wireChipGroup('category');
  wireChipGroup('method');
  $('#modalBackdrop').addEventListener('click', (e) => { if (e.target.id === 'modalBackdrop') closeModal(); });
  $('#cancelBtn').addEventListener('click', closeModal);
  if (isEdit) $('#deleteBtn').addEventListener('click', async () => {
    if (!confirm('確定要刪除這筆記帳嗎？')) return;
    await deleteExpense(localId);
    closeModal();
  });
  $('#saveBtn').addEventListener('click', async () => {
    // actualCardTWD is intentionally not collected here — it's filled in later
    // during desktop reconciliation directly in the sheet, and updateExpense
    // preserves whatever value is already on the local record.
    const category = resolveChipValue('category');
    const method = resolveChipValue('method');
    const fields = {
      date: $('#f_date').value,
      category,
      method,
      item: $('#f_item').value.trim(),
      amountUSD: $('#f_usd').value === '' ? null : Number($('#f_usd').value),
      amountTWD: $('#f_twd').value === '' ? null : Number($('#f_twd').value),
      note: $('#f_note').value.trim(),
    };
    if (!fields.date || !fields.item || !category || !method) { showToast('請至少填日期、項目名稱、分類和付款方式'); return; }
    // Registering is a no-op if the value already exists in the known list;
    // for a genuinely new value it updates the chip list right away and
    // queues it to sync into the sheet's dropdown on the next successful sync.
    await registerCustomOption('category', category);
    await registerCustomOption('method', method);
    if (isEdit) await updateExpense(localId, fields);
    else await addExpense(fields);
    closeModal();
  });
}
function closeModal() { $('#modalRoot').innerHTML = ''; }

/* ---------- screenshot import (recognition happens in claude.ai, no API key) ---------- */
function normOptionText(s) { return String(s || '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase(); }

// Claude may echo a category back without its emoji (or with a different
// emoji variation selector), so compare on the letters/digits only.
function matchOption(value, list) {
  const v = String(value || '').trim();
  if (!v) return '';
  const exact = list.find((o) => o === v);
  if (exact) return exact;
  const n = normOptionText(v);
  return n ? (list.find((o) => normOptionText(o) === n) || '') : '';
}

function toAmount(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function buildImportPrompt() {
  const today = todayStr();
  const richart = state.methods.find((m) => normOptionText(m).includes('richart')) || 'Richart card';
  return `我會附上一或多張消費截圖（信用卡通知、行動支付、收據、訂單截圖等）。請辨識每一筆「實際消費」，只輸出一個 JSON 陣列，不要輸出任何其他文字或說明。

每筆物件的欄位：
- date：消費日期，格式 YYYY-MM-DD（今天是 ${today}，截圖沒標年份時請用 ${today.slice(0, 4)} 年）
- time：消費時間，24 小時制 HH:mm，看不到就填 ""
- item：商家或品項名稱（保留原文）
- amountUSD：美金金額（數字），截圖是美金才填，否則 null
- amountTWD：台幣金額（數字），截圖是台幣才填，否則 null
- category：只能從這些選一個，請原樣輸出：${state.categories.join('、')}
- method：只能從這些選一個，請原樣輸出：${state.methods.join('、')}；判斷不出來填 ""
- note：其他補充（例如原始時間、卡號末四碼、小費、稅），沒有就填 ""

規則：
1. 退款、轉帳、餘額、點數、廣告等非消費項目不要列入。
2. date 和 time 一律照截圖上顯示的時間填（銀行顯示的是台灣時間），不要做任何時區換算或判斷。
3. 若截圖是台新銀行（台新帳戶、Richart）的通知或交易明細，method 一律填「${richart}」，不用再判斷。
4. 同一筆消費在多張截圖重複出現時只列一次。
5. 金額只填數字，不要幣別符號和千分位逗號。
6. 不確定的欄位寧可填 "" 或 null，不要猜。`;
}

function normalizeImportItem(o) {
  if (!o || typeof o !== 'object') return null;
  const amountUSD = toAmount(o.amountUSD);
  const amountTWD = toAmount(o.amountTWD);
  const item = String(o.item || '').trim();
  if (!item && amountUSD == null && amountTWD == null) return null;
  const dateStr = String(o.date || '').trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : todayStr();
  const category = matchOption(o.category, state.categories)
    || state.categories.find((c) => normOptionText(c).includes('其他')) || '';
  const method = matchOption(o.method, state.methods);
  const note = ['📸待確認', String(o.time || '').trim(), String(o.note || '').trim()].filter(Boolean).join(' ');
  return { date, category, method, item, amountUSD, amountTWD, note };
}

function parseImportText(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start === -1 || end <= start) throw new Error('找不到 JSON 陣列，請確認有把 Claude 的整段回覆貼進來');
  let arr;
  try { arr = JSON.parse(body.slice(start, end + 1)); } catch (e) { throw new Error('JSON 格式有誤，請請 Claude 重新輸出一次'); }
  if (!Array.isArray(arr)) throw new Error('回覆不是陣列格式');
  return arr.map(normalizeImportItem).filter(Boolean);
}

function looksDuplicate(it, existing) {
  return existing.some((e) => e.syncStatus !== 'pending-delete' && e.date === it.date && (
    (it.amountTWD != null && Number(e.amountTWD) === it.amountTWD) ||
    (it.amountUSD != null && Number(e.amountUSD) === it.amountUSD)));
}

let importDraft = '';

function openImportModal() {
  $('#modalRoot').innerHTML = `
    <div class="modal-backdrop" id="modalBackdrop">
      <div class="modal-sheet">
        <h3>📸 從截圖匯入</h3>
        <ol class="import-steps">
          <li>按下方按鈕複製提示詞。</li>
          <li>打開 claude.ai，貼上提示詞並附上消費截圖（可一次多張），送出。</li>
          <li>把 Claude 回覆的內容整段複製，貼到下面。</li>
        </ol>
        <button class="btn-secondary" id="copyPromptBtn">📋 複製提示詞</button>
        <a class="btn-secondary import-link" href="https://claude.ai/new" target="_blank" rel="noopener">🔗 開啟 claude.ai</a>
        <details class="howto">
          <summary>複製沒反應？手動複製提示詞</summary>
          <textarea id="promptFallback" readonly rows="8"></textarea>
        </details>
        <div class="form-row">
          <label>Claude 的回覆</label>
          <textarea id="importPaste" rows="6" placeholder="貼上 Claude 回覆的 JSON…"></textarea>
        </div>
        <div class="modal-actions">
          <button class="cancel-btn" id="cancelBtn">取消</button>
          <button class="save-btn" id="parseBtn">解析</button>
        </div>
      </div>
    </div>`;
  $('#promptFallback').value = buildImportPrompt();
  $('#importPaste').value = importDraft;
  $('#modalBackdrop').addEventListener('click', (e) => { if (e.target.id === 'modalBackdrop') closeModal(); });
  $('#cancelBtn').addEventListener('click', closeModal);
  $('#copyPromptBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(buildImportPrompt());
      showToast('已複製提示詞');
    } catch (e) {
      showToast('無法自動複製，請展開下方手動複製');
    }
  });
  $('#parseBtn').addEventListener('click', async () => {
    importDraft = $('#importPaste').value;
    let items;
    try { items = parseImportText(importDraft); } catch (e) { showToast(e.message); return; }
    if (!items.length) { showToast('沒有辨識到任何消費紀錄'); return; }
    await showImportPreview(items);
  });
}

async function showImportPreview(items) {
  const existing = await getAllExpenses();
  const rows = items.map((it) => ({ it, dup: looksDuplicate(it, existing) }));
  const amountHtml = (it) => (it.amountTWD != null ? 'NT$' + fmtMoney(it.amountTWD) : '')
    + (it.amountUSD != null ? (it.amountTWD != null ? '<br>' : '') + '$' + fmtMoney(it.amountUSD) : '');

  $('#modalRoot').innerHTML = `
    <div class="modal-backdrop" id="modalBackdrop">
      <div class="modal-sheet">
        <h3>辨識到 ${rows.length} 筆</h3>
        <p class="hint">勾選要匯入的項目；「可能重複」代表同一天已有相同金額的紀錄，預設不勾選。匯入後可逐筆點開修改細節。</p>
        <div id="importList">
          ${rows.map((r, i) => `
            <label class="import-row ${r.dup ? 'dup' : ''}">
              <input type="checkbox" data-i="${i}" ${r.dup ? '' : 'checked'}>
              <div class="import-main">
                <div class="exp-title">${escapeHtml(r.it.item || '(未命名)')}</div>
                <div class="exp-meta">${escapeHtml(r.it.date)}　${escapeHtml(r.it.category)}　${escapeHtml(r.it.method || '付款方式待選')}${r.dup ? '　⚠️可能重複' : ''}</div>
                <div class="exp-meta">${escapeHtml(r.it.note)}</div>
              </div>
              <div class="exp-amount">${amountHtml(r.it)}</div>
            </label>`).join('')}
        </div>
        <div class="modal-actions">
          <button class="cancel-btn" id="backBtn">返回</button>
          <button class="save-btn" id="importBtnConfirm"></button>
        </div>
      </div>
    </div>`;

  const selected = () => [...document.querySelectorAll('#importList input:checked')].map((el) => rows[Number(el.dataset.i)].it);
  const refreshCount = () => {
    const n = selected().length;
    const btn = $('#importBtnConfirm');
    btn.textContent = `匯入 ${n} 筆`;
    btn.disabled = n === 0;
  };
  refreshCount();
  $('#importList').addEventListener('change', refreshCount);
  $('#modalBackdrop').addEventListener('click', (e) => { if (e.target.id === 'modalBackdrop') closeModal(); });
  $('#backBtn').addEventListener('click', openImportModal);
  $('#importBtnConfirm').addEventListener('click', async () => {
    const chosen = selected();
    if (!chosen.length) return;
    await addExpensesBatch(chosen);
    importDraft = '';
    closeModal();
    showToast(`已匯入 ${chosen.length} 筆，請逐筆確認細節`);
  });
}

/* ---------- settings ---------- */
function wireSettings() {
  $('#syncUrlInput').value = state.syncUrl;
  $('#saveSyncUrlBtn').addEventListener('click', async () => {
    const url = $('#syncUrlInput').value.trim();
    state.syncUrl = url;
    await saveMeta('syncUrl', url);
    $('#syncResult').textContent = url ? '已儲存，開始同步…' : '已清除，記帳將只存在本機。';
    runSync();
  });
  $('#manualSyncBtn').addEventListener('click', () => {
    if (!state.syncUrl) { showToast('請先設定 Apps Script 網址'); return; }
    runSync();
  });
  $('#copyAppsScriptBtn').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('#appsScriptCode').textContent);
    showToast('已複製程式碼');
  });
  $('#clearLocalBtn').addEventListener('click', async () => {
    if (!$('#clearLocalCheckbox').checked) { showToast('請先勾選確認'); return; }
    if (!confirm('確定清除本機所有記帳資料？（不影響雲端試算表）')) return;
    const rows = await idbGetAll(STORE_EXPENSES);
    for (const r of rows) await idbDelete(STORE_EXPENSES, r.localId);
    // Without this the next pull still asks only for rows changed since the old
    // lastPullTime, so everything older would never come back from the sheet.
    state.lastPullTime = '';
    await saveMeta('lastPullTime', '');
    await renderAll();
    showToast('本機資料已清除');
  });
}

/* ---------- tabs ---------- */
function switchTab(tabId) {
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === tabId));
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tabId));
  $('#addFab').style.display = tabId === 'tab-record' ? '' : 'none';
}
function wireTabs() {
  document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
}

/* ---------- init ---------- */
async function init() {
  db = await openDB();
  await loadMeta();
  wireSettings();
  wireTabs();
  wireSyncDiag();
  $('#addFab').addEventListener('click', () => openExpenseModal(null));
  $('#importBtn').addEventListener('click', openImportModal);
  $('#syncBadge').addEventListener('click', () => {
    if (state.syncUrl) runSync();
    else switchTab('tab-settings');
  });
  window.addEventListener('online', () => { showToast('已恢復連線，開始同步'); runSync(); });
  window.addEventListener('offline', () => { showToast('已離線，記帳會先存在手機上'); updateSyncBadge(); });
  await renderAll();
  if (state.syncUrl) runSync();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.error('SW register failed', e));
  }
}

document.addEventListener('DOMContentLoaded', init);
