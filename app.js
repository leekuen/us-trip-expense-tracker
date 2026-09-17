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
  for (const opt of state.pendingOptions) {
    try {
      await callSync('addOption', opt);
    } catch (e) {
      console.error('addOption sync failed, will retry later', e);
      remaining.push(opt);
    }
  }
  state.pendingOptions = remaining;
  await saveMeta('pendingOptions', remaining);
}

/* ---------- expense CRUD (local-first) ---------- */
async function getAllExpenses() {
  const rows = await idbGetAll(STORE_EXPENSES);
  return rows.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.lastModified.localeCompare(a.lastModified));
}

async function addExpense(fields) {
  const rec = {
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
  await idbPut(STORE_EXPENSES, rec);
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
async function callSync(action, payload) {
  const resp = await fetch(state.syncUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, ...payload }),
  });
  const json = await resp.json();
  if (json.status !== 'ok') throw new Error(json.message || 'sync failed');
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
  } catch (e) {
    console.error('sync failed', e);
    showToast('同步失敗，稍後會自動重試');
  } finally {
    state.syncing = false;
    await updateSyncBadge();
    await renderAll();
    if (syncQueued) { syncQueued = false; runSync(); }
  }
}

async function pullFromSheet() {
  const res = await callSync('pull', { since: state.lastPullTime || '' });
  if (res.categories && res.categories.length) { state.categories = res.categories; await saveMeta('categories', res.categories); }
  if (res.methods && res.methods.length) { state.methods = res.methods; await saveMeta('methods', res.methods); }

  const rows = await idbGetAll(STORE_EXPENSES);
  const bySheetRow = new Map(rows.filter((r) => r.sheetRow).map((r) => [r.sheetRow, r]));

  for (const remote of res.rows) {
    const local = bySheetRow.get(remote.row);
    if (local) {
      const localPending = local.syncStatus && local.syncStatus.startsWith('pending');
      const remoteWins = !localPending || remote.lastModified > local.lastModified;
      if (!remoteWins) continue; // local edit is newer, will be pushed instead
      if (remote.deleted) {
        await idbDelete(STORE_EXPENSES, local.localId);
      } else {
        Object.assign(local, remote.data, { lastModified: remote.lastModified, syncStatus: 'synced', sheetRow: remote.row });
        await idbPut(STORE_EXPENSES, local);
      }
    } else if (!remote.deleted) {
      await idbPut(STORE_EXPENSES, {
        localId: uid(),
        ...remote.data,
        lastModified: remote.lastModified,
        sheetRow: remote.row,
        syncStatus: 'synced',
      });
    }
  }
  state.lastPullTime = res.serverTime;
  await saveMeta('lastPullTime', res.serverTime);
}

async function pushPendingToSheet() {
  const rows = await idbGetAll(STORE_EXPENSES);
  const pending = rows.filter((r) => r.syncStatus && r.syncStatus.startsWith('pending')).sort((a, b) => a.lastModified.localeCompare(b.lastModified));
  for (const rec of pending) {
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
      if (!current) continue; // deleted locally in the meantime; the row now exists orphaned in the sheet, which is an acceptable rare edge case
      current.sheetRow = res.row;
      current.syncStatus = current.lastModified === queuedAt ? 'synced' : 'pending-update';
      await idbPut(STORE_EXPENSES, current);
    } else if (rec.syncStatus === 'pending-update') {
      await callSync('update', { row: rec.sheetRow, data, localId: rec.localId });
      const current = (await idbGetAll(STORE_EXPENSES)).find((r) => r.localId === rec.localId);
      if (!current) continue;
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
}

/* ---------- rendering ---------- */
async function renderAll() {
  const rows = await getAllExpenses();
  renderSummary(rows);
  renderList(rows);
  await updateSyncBadge();
}

function renderSummary(rows) {
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
  $('#addFab').addEventListener('click', () => openExpenseModal(null));
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
