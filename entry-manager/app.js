'use strict';

const STORAGE_KEY = 'entry-manager-state-v2';
const VERSION = 1;
let reviewContext = null;
let actionContext = null;
let completionContext = null;
let toastTimer = null;

const $ = (id) => document.getElementById(id);
const nowIso = () => new Date().toISOString();
const uid = (prefix) => prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
let state = loadState();

function blankFormat(n){
  return {
    id: uid('fmt'),
    label: 'フォーマット' + n,
    lastName: '',
    firstName: '',
    lastKana: '',
    firstKana: '',
    postalCode: '',
    prefecture: '',
    city: '',
    street: '',
    building: '',
    phone: '',
    email: '',
    memo: '',
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
}

function defaultState(){
  return {
    version: VERSION,
    formats: [blankFormat(1), blankFormat(2), blankFormat(3)],
    history: [],
    pageRules: [],
    settings: { trialMode: true, defaultFormatsSeeded: true },
    activeJob: null
  };
}

function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return defaultState();
    const parsed = JSON.parse(raw);
    const settings = Object.assign({trialMode:true, defaultFormatsSeeded:false}, parsed.settings || {});
    let formats = Array.isArray(parsed.formats) ? parsed.formats : [];
    // 初期公開版で空のformatsが保存された端末向けの一度限りの移行。
    // settings値に依存せず専用マイグレーションキーで判定する。
    const seedMigrationKey = 'entry-manager-seed-formats-v3';
    if(formats.length === 0 && localStorage.getItem(seedMigrationKey) !== '1'){
      formats = [blankFormat(1), blankFormat(2), blankFormat(3)];
      settings.defaultFormatsSeeded = true;
      try{
        localStorage.setItem(seedMigrationKey, '1');
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          version: VERSION,
          formats,
          history: Array.isArray(parsed.history) ? parsed.history : [],
          pageRules: Array.isArray(parsed.pageRules) ? parsed.pageRules : [],
          settings,
          activeJob: parsed.activeJob || null
        }));
      }catch(_){}
    }
    return {
      version: VERSION,
      formats,
      history: Array.isArray(parsed.history) ? parsed.history : [],
      pageRules: Array.isArray(parsed.pageRules) ? parsed.pageRules : [],
      settings,
      activeJob: parsed.activeJob || null
    };
  }catch(error){
    console.error(error);
    return defaultState();
  }
}

function saveState(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  renderAll();
}

function formatFullName(f){
  return [f.lastName, f.firstName].filter(Boolean).join(' ') || '氏名未登録';
}

function formatAddress(f){
  return [f.postalCode ? '〒' + f.postalCode : '', f.prefecture, f.city, f.street, f.building].filter(Boolean).join(' ');
}

function escapeHtml(value){
  return String(value == null ? '' : value)
    .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
    .replaceAll('"','&quot;').replaceAll("'","&#039;");
}

function showToast(message){
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2400);
}

function renderAll(){
  // Entryマネージャーは最低3つの初期フォーマットを持つ。
  // 旧版で0件状態が保存されていても、画面描画前に復旧する。
  if(!Array.isArray(state.formats) || state.formats.length === 0){
    state.formats = [blankFormat(1), blankFormat(2), blankFormat(3)];
    try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }catch(_){}
  }
  renderFormats();
  renderHistory();
  renderRules();
  $('statFormats').textContent = state.formats.length;
  $('statHistory').textContent = state.history.length;
  $('statRules').textContent = state.pageRules.length;
  $('ruleCount').textContent = state.pageRules.length + '件';
  $('trialModeToggle').checked = !!state.settings.trialMode;
  $('trialBadge').textContent = state.settings.trialMode ? '試用期間' : '通常運用';
}

function renderFormats(){
  const root = $('formatList');
  if(!state.formats.length){
    root.innerHTML = '<div class="empty">フォーマットがありません。「＋ 追加」から作成してください。</div>';
    return;
  }
  root.innerHTML = state.formats.map((f, index) => {
    const meta = [
      formatFullName(f),
      f.email || 'メール未登録',
      f.phone || '電話未登録',
      formatAddress(f)
    ].filter(Boolean).map(escapeHtml).join('<br>');
    return '<article class="formatCard" data-format-id="' + escapeHtml(f.id) + '">' +
      '<div class="formatTop"><div><div class="formatName">' + escapeHtml(f.label || ('フォーマット' + (index + 1))) + '</div>' +
      '<div class="formatMeta">' + meta + '</div></div>' +
      '<button class="miniBtn editFormatBtn" type="button">編集</button></div>' +
      '<div class="urlArea"><label>入力するキャンペーンURL</label>' +
      '<div class="urlRow"><input class="campaignUrlInput" type="url" inputmode="url" placeholder="https://..." autocomplete="off">' +
      '<button class="primaryBtn startBtn" type="button">スタート</button></div></div></article>';
  }).join('');

  root.querySelectorAll('.editFormatBtn').forEach(btn => btn.addEventListener('click', () => {
    const card = btn.closest('.formatCard');
    openFormatDialog(card.dataset.formatId);
  }));
  root.querySelectorAll('.startBtn').forEach(btn => btn.addEventListener('click', () => {
    const card = btn.closest('.formatCard');
    const input = card.querySelector('.campaignUrlInput');
    startEntry(card.dataset.formatId, input.value);
  }));
}

function renderHistory(){
  const root = $('historyList');
  if(!state.history.length){
    root.innerHTML = '<div class="empty">応募完了したキャンペーンはまだありません。</div>';
    return;
  }
  const sorted = state.history.slice().sort((a,b) => String(b.completedAt).localeCompare(String(a.completedAt)));
  root.innerHTML = sorted.map(h => {
    return '<article class="historyCard" data-history-id="' + escapeHtml(h.id) + '">' +
      '<h3>' + escapeHtml(h.campaignName || 'キャンペーン') + '</h3>' +
      '<div class="historyMeta">' +
      '<span>完了：' + escapeHtml(formatDateTime(h.completedAt)) + '</span>' +
      '<span>フォーマット：' + escapeHtml(h.formatLabel || '-') + '</span>' +
      '<span>メール：' + escapeHtml(h.email || '-') + '</span>' +
      '<span>URL：' + escapeHtml(h.url || '-') + '</span>' +
      (h.memo ? '<span>メモ：' + escapeHtml(h.memo) + '</span>' : '') +
      '</div><div class="historyActions"><button class="miniBtn editHistoryBtn" type="button">編集</button></div></article>';
  }).join('');
  root.querySelectorAll('.editHistoryBtn').forEach(btn => btn.addEventListener('click', () => editHistory(btn.closest('.historyCard').dataset.historyId)));
}

function renderRules(){
  const root = $('pageRuleList');
  if(!state.pageRules.length){
    root.innerHTML = '<div class="empty">確認不要にしたページ形式はありません。</div>';
    return;
  }
  root.innerHTML = state.pageRules.map(rule => {
    return '<article class="ruleCard" data-rule-id="' + escapeHtml(rule.id) + '">' +
      '<div class="rowBetween"><div><div class="ruleTitle">' + escapeHtml(rule.label || rule.hostname || 'ページ形式') + '</div>' +
      '<div class="ruleMeta">' + escapeHtml(rule.hostname || '') + '<br>' + escapeHtml(rule.fingerprint || '') + '</div></div>' +
      '<button class="miniBtn deleteRuleBtn" type="button">解除</button></div></article>';
  }).join('');
  root.querySelectorAll('.deleteRuleBtn').forEach(btn => btn.addEventListener('click', () => {
    const id = btn.closest('.ruleCard').dataset.ruleId;
    if(!confirm('この「確認不要」設定を解除しますか？')) return;
    state.pageRules = state.pageRules.filter(r => r.id !== id);
    saveState();
  }));
}

function formatDateTime(iso){
  try{
    return new Intl.DateTimeFormat('ja-JP',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(iso));
  }catch(_){
    return iso || '';
  }
}

function showView(name){
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.dataset.view === name));
  document.querySelectorAll('.navBtn').forEach(b => b.classList.toggle('active', b.dataset.target === name));
  window.scrollTo({top:0,behavior:'smooth'});
}

function openFormatDialog(formatId){
  const f = state.formats.find(item => item.id === formatId);
  const isNew = !f;
  const source = f || blankFormat(state.formats.length + 1);
  $('formatDialogTitle').textContent = isNew ? 'フォーマット追加' : 'フォーマット編集';
  $('formatId').value = isNew ? '' : source.id;
  ['label','lastName','firstName','lastKana','firstKana','postalCode','prefecture','city','street','building','phone','email','memo'].forEach(key => {
    const id = key === 'label' ? 'formatLabel' : key === 'memo' ? 'formatMemo' : key;
    $(id).value = source[key] || '';
  });
  $('deleteFormatBtn').style.visibility = isNew ? 'hidden' : 'visible';
  $('formatDialog').showModal();
}

function collectFormatForm(){
  return {
    label: $('formatLabel').value.trim(),
    lastName: $('lastName').value.trim(),
    firstName: $('firstName').value.trim(),
    lastKana: $('lastKana').value.trim(),
    firstKana: $('firstKana').value.trim(),
    postalCode: $('postalCode').value.trim(),
    prefecture: $('prefecture').value.trim(),
    city: $('city').value.trim(),
    street: $('street').value.trim(),
    building: $('building').value.trim(),
    phone: $('phone').value.trim(),
    email: $('email').value.trim(),
    memo: $('formatMemo').value.trim()
  };
}

function saveFormatFromDialog(){
  const id = $('formatId').value;
  const values = collectFormatForm();
  if(!values.label){
    showToast('表示名を入力してください');
    return false;
  }
  if(id){
    const f = state.formats.find(item => item.id === id);
    if(f) Object.assign(f, values, {updatedAt:nowIso()});
  }else{
    state.formats.push(Object.assign(blankFormat(state.formats.length + 1), values));
  }
  saveState();
  showToast('フォーマットを保存しました');
  return true;
}

function deleteFormat(){
  const id = $('formatId').value;
  if(!id) return;
  const f = state.formats.find(item => item.id === id);
  if(!f) return;
  if(!confirm((f.label || 'フォーマット') + ' を削除しますか？')) return;
  state.formats = state.formats.filter(item => item.id !== id);
  saveState();
  $('formatDialog').close();
}

function validHttpUrl(raw){
  try{
    const url = new URL(String(raw).trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  }catch(_){
    return null;
  }
}

function startEntry(formatId, rawUrl){
  const url = validHttpUrl(rawUrl);
  if(!url){
    showToast('正しいURLを入力してください');
    return;
  }
  const format = state.formats.find(f => f.id === formatId);
  if(!format){
    showToast('フォーマットが見つかりません');
    return;
  }
  state.activeJob = {
    id: uid('job'),
    formatId,
    formatLabel: format.label,
    url: url.href,
    startedAt: nowIso(),
    campaignName: '',
    completionCandidate: false,
    lastAction: null
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

  emitHelper('START_ENTRY',{
    jobId: state.activeJob.id,
    url: url.href,
    format: publicFormat(format),
    trialMode: !!state.settings.trialMode,
    pageRules: state.pageRules.map(r => ({fingerprint:r.fingerprint}))
  });

  if(isHelperConnected()){
    showToast('Helperへ開始指示を送りました');
  }else{
    window.open(url.href, '_blank', 'noopener');
    showToast('URLを開きました。自動入力にはAndroid Helperが必要です');
  }
}

function publicFormat(f){
  const copy = Object.assign({}, f);
  delete copy.createdAt;
  delete copy.updatedAt;
  return copy;
}

function isHelperConnected(){
  return !!(window.EntryHelper && typeof window.EntryHelper.startEntry === 'function') || document.documentElement.dataset.helperConnected === 'true';
}

function updateHelperStatus(){
  $('helperStatus').textContent = isHelperConnected()
    ? 'Android Helper：接続済み'
    : 'Android Helper：未接続（管理・CSV・履歴機能は利用可能）';
}

function emitHelper(type, detail){
  window.dispatchEvent(new CustomEvent('entry-manager:helper-response',{detail:{type,...detail}}));
  try{
    if(window.EntryHelper && typeof window.EntryHelper.onEntryManagerMessage === 'function'){
      window.EntryHelper.onEntryManagerMessage(JSON.stringify({type,...detail}));
    }
  }catch(error){
    console.error(error);
  }
}

function findFormatForReview(payload){
  const id = payload.formatId || (state.activeJob && state.activeJob.formatId);
  return state.formats.find(f => f.id === id) || null;
}

function showInputReview(payload){
  const format = findFormatForReview(payload || {});
  reviewContext = {
    payload: payload || {},
    format,
    original: {}
  };
  $('reviewCampaign').textContent = payload.campaignName || 'キャンペーン名を確認中';
  if(state.activeJob && payload.campaignName) state.activeJob.campaignName = payload.campaignName;
  const fields = Array.isArray(payload.fields) ? payload.fields : [];
  const root = $('reviewFields');
  root.innerHTML = fields.map((field,index) => {
    const key = field.key || ('field' + index);
    reviewContext.original[key] = field.value == null ? '' : String(field.value);
    return '<div class="reviewRow"><label for="reviewField' + index + '">' + escapeHtml(field.label || key) + '</label>' +
      '<input id="reviewField' + index + '" data-key="' + escapeHtml(key) + '" value="' + escapeHtml(field.value == null ? '' : field.value) + '"></div>';
  }).join('');
  $('updateFormatWrap').classList.add('hidden');
  $('updateFormatCheck').checked = false;
  $('inputReviewDialog').showModal();
}

function collectReviewValues(){
  const values = {};
  $('reviewFields').querySelectorAll('input[data-key]').forEach(input => { values[input.dataset.key] = input.value; });
  return values;
}

function reviewChanged(){
  if(!reviewContext) return false;
  const values = collectReviewValues();
  return Object.keys(values).some(key => String(values[key]) !== String(reviewContext.original[key] || ''));
}

function updateCurrentFormat(values){
  const format = reviewContext && reviewContext.format;
  if(!format) return;
  const allowed = ['lastName','firstName','lastKana','firstKana','postalCode','prefecture','city','street','building','phone','email','memo'];
  allowed.forEach(key => {
    if(Object.prototype.hasOwnProperty.call(values,key)) format[key] = values[key];
  });
  format.updatedAt = nowIso();
}

function closeInputReview(resultType){
  if(!reviewContext) return;
  const values = collectReviewValues();
  const changed = reviewChanged();

  if(resultType === 'cancel'){
    emitHelper('INPUT_REVIEW_RESULT',{jobId:activeJobId(),action:'cancel'});
    $('inputReviewDialog').close();
    reviewContext = null;
    return;
  }

  if(resultType === 'unchanged'){
    emitHelper('INPUT_REVIEW_RESULT',{jobId:activeJobId(),action:'continue',values:reviewContext.original,updateFormat:false});
    $('inputReviewDialog').close();
    reviewContext = null;
    return;
  }

  if(!changed){
    emitHelper('INPUT_REVIEW_RESULT',{jobId:activeJobId(),action:'continue',values,updateFormat:false});
    $('inputReviewDialog').close();
    reviewContext = null;
    return;
  }

  const updateFormat = $('updateFormatCheck').checked;
  if(updateFormat){
    updateCurrentFormat(values);
    saveState();
  }
  emitHelper('INPUT_REVIEW_RESULT',{jobId:activeJobId(),action:'continue',values,updateFormat});
  $('inputReviewDialog').close();
  reviewContext = null;
}

async function showActionReview(payload){
  payload = payload || {};
  const fingerprint = payload.fingerprint || (payload.pageDescriptor ? await makePageFingerprint(payload.pageDescriptor) : '');
  const savedRule = fingerprint ? state.pageRules.find(r => r.fingerprint === fingerprint) : null;

  if(!state.settings.trialMode && savedRule){
    emitHelper('ACTION_REVIEW_RESULT',{
      jobId:activeJobId(),
      action:'approve',
      skipFuture:true,
      marksCompletion:false,
      fingerprint
    });
    return;
  }

  actionContext = Object.assign({},payload,{fingerprint});
  if(state.activeJob && payload.campaignName) state.activeJob.campaignName = payload.campaignName;
  $('actionCampaign').textContent = payload.campaignName || (state.activeJob && state.activeJob.campaignName) || 'キャンペーン名を確認中';
  $('actionButtonText').textContent = payload.buttonText || '次へ';
  $('completionCheck').checked = !!payload.suggestCompletion;
  $('skipPageCheck').checked = false;

  if(payload.screenshotDataUrl){
    $('actionShot').src = payload.screenshotDataUrl;
    $('actionShotWrap').classList.remove('hidden');
  }else{
    $('actionShot').removeAttribute('src');
    $('actionShotWrap').classList.add('hidden');
  }
  $('actionReviewDialog').showModal();
}

function cancelActionReview(){
  emitHelper('ACTION_REVIEW_RESULT',{jobId:activeJobId(),action:'cancel'});
  $('actionReviewDialog').close();
  actionContext = null;
}

function approveActionReview(){
  if(!actionContext) return;
  const marksCompletion = $('completionCheck').checked;
  const skipFuture = $('skipPageCheck').checked;
  if(skipFuture && actionContext.fingerprint){
    upsertPageRule(actionContext);
  }
  if(state.activeJob){
    state.activeJob.completionCandidate = marksCompletion;
    state.activeJob.lastAction = {
      buttonText: actionContext.buttonText || '',
      fingerprint: actionContext.fingerprint || '',
      approvedAt: nowIso()
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }
  emitHelper('ACTION_REVIEW_RESULT',{
    jobId:activeJobId(),
    action:'approve',
    marksCompletion,
    skipFuture,
    fingerprint:actionContext.fingerprint || ''
  });
  $('actionReviewDialog').close();
  actionContext = null;
}

function upsertPageRule(payload){
  const fingerprint = payload.fingerprint;
  if(!fingerprint) return;
  const descriptor = payload.pageDescriptor || {};
  const url = validHttpUrl(payload.url || (state.activeJob && state.activeJob.url) || '');
  const existing = state.pageRules.find(r => r.fingerprint === fingerprint);
  const next = {
    id: existing ? existing.id : uid('rule'),
    fingerprint,
    hostname: descriptor.hostname || (url ? url.hostname : ''),
    label: payload.pageLabel || payload.buttonText || descriptor.title || 'ページ形式',
    descriptor,
    savedAt: nowIso()
  };
  if(existing) Object.assign(existing,next);
  else state.pageRules.push(next);
  saveState();
}

function activeJobId(){
  return state.activeJob ? state.activeJob.id : null;
}

function completionDetected(payload){
  payload = payload || {};
  if(!state.activeJob) return;
  if(payload.success === false){
    state.activeJob.completionCandidate = false;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    showToast('完了を確認できなかったため履歴には登録していません');
    return;
  }
  commitHistory(payload);
}

function completionUnknown(payload){
  payload = payload || {};
  if(!state.activeJob || !state.activeJob.completionCandidate) return;
  completionContext = payload;
  $('completionFallbackDialog').showModal();
}

function commitHistory(payload){
  if(!state.activeJob) return;
  const format = state.formats.find(f => f.id === state.activeJob.formatId);
  const campaignName = payload.campaignName || state.activeJob.campaignName || 'キャンペーン';
  const duplicate = state.history.find(h => h.jobId === state.activeJob.id);
  if(duplicate) return;
  state.history.push({
    id: uid('hist'),
    jobId: state.activeJob.id,
    campaignName,
    url: state.activeJob.url,
    formatId: format ? format.id : state.activeJob.formatId,
    formatLabel: format ? format.label : state.activeJob.formatLabel,
    email: payload.email || (format ? format.email : ''),
    completedAt: payload.completedAt || nowIso(),
    memo: payload.memo || ''
  });
  state.activeJob = null;
  saveState();
  showToast('応募完了として履歴に登録しました');
}

function forceComplete(){
  if(!state.activeJob) return;
  commitHistory(completionContext || {});
  completionContext = null;
  $('completionFallbackDialog').close();
}

function notComplete(){
  if(state.activeJob){
    state.activeJob.completionCandidate = false;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }
  completionContext = null;
  $('completionFallbackDialog').close();
  showToast('履歴には登録していません');
}

function editHistory(id){
  const item = state.history.find(h => h.id === id);
  if(!item) return;
  const name = prompt('キャンペーン名', item.campaignName || '');
  if(name === null) return;
  const memo = prompt('メモ', item.memo || '');
  if(memo === null) return;
  item.campaignName = name.trim() || item.campaignName;
  item.memo = memo.trim();
  const remove = confirm('内容を保存します。\n\nこの履歴自体を削除する場合は「OK」の後、次の確認で削除を選べます。');
  if(remove){
    const shouldDelete = confirm('この応募完了履歴を削除しますか？\n削除しない場合は「キャンセル」を押してください。');
    if(shouldDelete){
      state.history = state.history.filter(h => h.id !== id);
      saveState();
      return;
    }
  }
  saveState();
}

function csvEscape(value){
  const s = String(value == null ? '' : value);
  return '"' + s.replaceAll('"','""') + '"';
}

function exportCsv(){
  const rows = [['type','id','label','data_json']];
  state.formats.forEach(f => rows.push(['format',f.id,f.label,JSON.stringify(f)]));
  state.history.forEach(h => rows.push(['history',h.id,h.campaignName,JSON.stringify(h)]));
  state.pageRules.forEach(r => rows.push(['page_rule',r.id,r.label,JSON.stringify(r)]));
  rows.push(['settings','settings','settings',JSON.stringify(state.settings)]);
  const csv = '\ufeff' + rows.map(row => row.map(csvEscape).join(',')).join('\r\n');
  const blob = new Blob([csv],{type:'text/csv;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'EntryManager_Backup_' + new Date().toISOString().slice(0,10).replaceAll('-','') + '.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  showToast('CSVを書き出しました');
}

function parseCsv(text){
  const rows = [];
  let row = [], cell = '', quoted = false;
  for(let i=0;i<text.length;i++){
    const ch = text[i];
    if(quoted){
      if(ch === '"' && text[i+1] === '"'){ cell += '"'; i++; }
      else if(ch === '"') quoted = false;
      else cell += ch;
    }else{
      if(ch === '"') quoted = true;
      else if(ch === ','){ row.push(cell); cell = ''; }
      else if(ch === '\n'){ row.push(cell.replace(/\r$/,'')); rows.push(row); row=[]; cell=''; }
      else cell += ch;
    }
  }
  if(cell.length || row.length){ row.push(cell.replace(/\r$/,'')); rows.push(row); }
  return rows;
}

async function importCsv(file){
  if(!file) return;
  const text = (await file.text()).replace(/^\ufeff/,'');
  const rows = parseCsv(text);
  if(!rows.length || rows[0][0] !== 'type'){
    showToast('EntryマネージャーのCSVではありません');
    return;
  }
  const next = {formats:[],history:[],pageRules:[],settings:{trialMode:true}};
  try{
    rows.slice(1).forEach(row => {
      if(row.length < 4) return;
      const data = JSON.parse(row[3]);
      if(row[0] === 'format') next.formats.push(data);
      if(row[0] === 'history') next.history.push(data);
      if(row[0] === 'page_rule') next.pageRules.push(data);
      if(row[0] === 'settings') next.settings = Object.assign(next.settings,data);
    });
  }catch(error){
    console.error(error);
    showToast('CSVの読み込みに失敗しました');
    return;
  }
  if(!confirm('現在の端末内データをCSVの内容で置き換えますか？')) return;
  state.formats = next.formats;
  state.history = next.history;
  state.pageRules = next.pageRules;
  state.settings = next.settings;
  state.activeJob = null;
  saveState();
  showToast('CSVから復元しました');
}

function normalizeFingerprintText(value){
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .replace(/\s+/g,' ')
    .trim()
    .toLowerCase();
}

async function makePageFingerprint(descriptor){
  descriptor = descriptor || {};
  const source = [
    normalizeFingerprintText(descriptor.hostname),
    normalizeFingerprintText(descriptor.pathname),
    normalizeFingerprintText(descriptor.title),
    (descriptor.headings || []).map(normalizeFingerprintText).join('|'),
    (descriptor.campaignTexts || descriptor.identityTexts || []).map(normalizeFingerprintText).join('|'),
    (descriptor.fields || []).map(item => normalizeFingerprintText(typeof item === 'string' ? item : (item.label || item.name || item.type))).join('|'),
    (descriptor.buttons || []).map(item => normalizeFingerprintText(typeof item === 'string' ? item : (item.text || item.label))).join('|')
  ].join('\n');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2,'0')).join('');
}

function onHelperMessage(data){
  if(!data || typeof data !== 'object') return;
  const type = data.type;
  if(type === 'HELPER_CONNECTED'){
    document.documentElement.dataset.helperConnected = 'true';
    updateHelperStatus();
  }else if(type === 'INPUT_REVIEW'){
    showInputReview(data);
  }else if(type === 'ACTION_REVIEW'){
    showActionReview(data);
  }else if(type === 'COMPLETION_DETECTED'){
    completionDetected(data);
  }else if(type === 'COMPLETION_UNKNOWN'){
    completionUnknown(data);
  }else if(type === 'ACTION_FAILED'){
    completionDetected({success:false});
  }else if(type === 'CAMPAIGN_IDENTIFIED'){
    if(state.activeJob){
      state.activeJob.campaignName = data.campaignName || state.activeJob.campaignName;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }
  }
}

window.EntryManagerBridge = {
  version: VERSION,
  getActiveJob: () => state.activeJob,
  getFormat: (id) => state.formats.find(f => f.id === id) || null,
  getPageRule: (fingerprint) => state.pageRules.find(r => r.fingerprint === fingerprint) || null,
  makePageFingerprint,
  showInputReview,
  showActionReview,
  completionDetected,
  completionUnknown,
  helperConnected: () => {
    document.documentElement.dataset.helperConnected = 'true';
    updateHelperStatus();
  }
};

document.querySelectorAll('.navBtn').forEach(btn => btn.addEventListener('click', () => showView(btn.dataset.target)));
$('addFormatBtn').addEventListener('click', () => openFormatDialog(null));
$('deleteFormatBtn').addEventListener('click', deleteFormat);
$('formatForm').addEventListener('submit', event => {
  if(event.submitter && event.submitter.value === 'cancel') return;
  event.preventDefault();
  if(saveFormatFromDialog()) $('formatDialog').close();
});
$('trialModeToggle').addEventListener('change', event => {
  state.settings.trialMode = event.target.checked;
  saveState();
});
$('exportCsvBtn').addEventListener('click', exportCsv);
$('importCsvInput').addEventListener('change', event => {
  importCsv(event.target.files && event.target.files[0]);
  event.target.value = '';
});

$('reviewCancelBtn').addEventListener('click', () => closeInputReview('cancel'));
$('reviewNoChangeBtn').addEventListener('click', () => closeInputReview('unchanged'));
$('reviewChangedBtn').addEventListener('click', () => {
  if(!reviewChanged()){
    showToast('変更はありません。「変更無しで進む」を使用してください');
    return;
  }
  closeInputReview('changed');
});

$('actionCancelBtn').addEventListener('click', cancelActionReview);
$('actionApproveBtn').addEventListener('click', approveActionReview);
$('notCompleteBtn').addEventListener('click', notComplete);
$('forceCompleteBtn').addEventListener('click', forceComplete);

window.addEventListener('message', event => {
  if(event.data && event.data.source === 'entry-helper') onHelperMessage(event.data);
});
window.addEventListener('entry-helper:message', event => onHelperMessage(event.detail));

window.addEventListener('load', () => {
  renderAll();
  updateHelperStatus();
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('./sw.js?v=20260922-3').catch(console.error);
  }
});

renderAll();
updateHelperStatus();
