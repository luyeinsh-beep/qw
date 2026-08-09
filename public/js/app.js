// ============ AUTH ============
function getToken() { return localStorage.getItem('rw_token'); }
function getUser() {
  try { return JSON.parse(localStorage.getItem('rw_user')); }
  catch { return null; }
}

function logout() {
  localStorage.removeItem('rw_token');
  localStorage.removeItem('rw_user');
  window.location.href = '/';
}

// Check auth on load
if (!getToken()) { window.location.href = '/'; }

// Show current user
const user = getUser();
if (user) {
  document.getElementById('currentUserName').textContent = user.display_name || user.username;
  document.getElementById('currentUserRole').textContent = user.role === 'admin' ? '管理员' : '成员';
}

// ============ API ============
async function api(path, options = {}) {
  const token = getToken();
  if (!token) { window.location.href = '/'; return; }

  const headers = { 'Content-Type': 'application/json', ...options.headers };
  headers['Authorization'] = 'Bearer ' + token;

  const resp = await fetch(path, { ...options, headers });
  if (resp.status === 401) {
    localStorage.removeItem('rw_token');
    window.location.href = '/';
    throw new Error('登录已过期');
  }
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || '请求失败');
  return data;
}

// ============ DIMENSIONS ============
const DIMENSIONS = [
  { id: 'positioning', name: '定位', icon: '🎯', color: '#2563EB',
    subItems: ['目标客群清晰度','价格带竞争力','差异化优势','选址与流量匹配'],
    desc: '评估门店的目标市场定位是否清晰，价格策略是否合理，与竞争对手的差异化程度以及选址与目标客群的匹配度。' },
  { id: 'product', name: '产品', icon: '🍳', color: '#10B981',
    subItems: ['菜品结构合理度','爆品打造能力','毛利结构健康度','出品稳定性'],
    desc: '评估菜单结构是否科学，是否有具备竞争力的招牌产品，毛利结构是否合理，出品质量是否稳定。' },
  { id: 'marketing', name: '营销', icon: '📢', color: '#F59E0B',
    subItems: ['获客能力','复购与留存','活动策划效果','线上平台表现'],
    desc: '评估门店的获客渠道与效率、顾客复购率、营销活动的设计与执行效果，以及线上平台的运营能力。' },
  { id: 'brandTone', name: '品牌定调', icon: '🎨', color: '#8B5CF6',
    subItems: ['品牌理念表达','风格统一性','客群共鸣度','体验连贯性'],
    desc: '评估品牌核心理念是否清晰传达，视觉与语言风格是否统一，品牌调性是否与目标客群产生共鸣。' },
  { id: 'brandProduction', name: '品牌制作', icon: '🖼️', color: '#EC4899',
    subItems: ['VI系统完整度','空间体验感','物料品质感','数字视觉呈现'],
    desc: '评估VI视觉系统的完整度、门店空间设计的体验感、各类物料的品质以及线上数字化视觉呈现效果。' },
  { id: 'brandPromotion', name: '品牌宣发', icon: '📱', color: '#06B6D4',
    subItems: ['社媒运营力','内容质量','传播影响力','本地化渗透'],
    desc: '评估社交媒体运营能力、发布内容的质量、品牌传播的影响范围以及在本地市场的渗透程度。' },
  { id: 'businessIntegration', name: '业务串联', icon: '🔗', color: '#F97316',
    subItems: ['O2O融合度','供应链效能','数据应用能力','组织协同力'],
    desc: '评估线上线下的融合程度、供应链管理的效率、数据驱动决策的能力以及团队组织的协同效能。' }
];

function getDefaultEval() {
  const eval_ = { date: new Date().toISOString().split('T')[0], evaluator: getUser()?.display_name || '', summary: '', priorityActions: [], dimensions: {} };
  DIMENSIONS.forEach(d => {
    eval_.dimensions[d.id] = { subItems: d.subItems.map(s => ({ name: s, score: 0 })), comment: '', suggestion: '' };
  });
  return eval_;
}

// ============ STATE ============
let merchantsData = [];
let currentMerchantId = null;
let currentEvalData = null;
let currentMerchantForEval = null;
let activeDimTab = 0;
let isSaving = false;

// ============ UTILS ============
function showToast(msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast ' + (type||'') + ' show';
  setTimeout(() => t.classList.remove('show'), 2200);
}
function getGrade(score) {
  if (score >= 4.5) return { grade: 'A+', label: '卓越', cls: 'A' };
  if (score >= 4.0) return { grade: 'A', label: '优秀', cls: 'A' };
  if (score >= 3.5) return { grade: 'B+', label: '良好', cls: 'B' };
  if (score >= 3.0) return { grade: 'B', label: '一般', cls: 'B' };
  if (score >= 2.0) return { grade: 'C', label: '需改进', cls: 'C' };
  return { grade: 'D', label: '待提升', cls: 'D' };
}
function calcDimScore(dimData) {
  if (!dimData || !dimData.subItems) return 0;
  const scores = dimData.subItems.map(s => s.score).filter(s => s > 0);
  return scores.length ? Math.round(scores.reduce((a,b)=>a+b,0) / scores.length * 10) / 10 : 0;
}
function calcOverallScore(evalData) {
  const dimScores = DIMENSIONS.map(d => calcDimScore(evalData.dimensions[d.id])).filter(s => s > 0);
  return dimScores.length ? Math.round(dimScores.reduce((a,b)=>a+b,0) / dimScores.length * 10) / 10 : 0;
}

// ============ VIEW NAVIGATION ============
function switchView(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('view-' + view).classList.add('active');
  document.querySelector(`[data-view="${view}"]`)?.classList.add('active');

  if (view === 'dashboard') loadDashboard();
  else if (view === 'merchants') loadMerchantList();
}

function switchViewRaw(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + view).classList.add('active');
}

// ============ DASHBOARD ============
async function loadDashboard() {
  try {
    const stats = await api('/api/stats');
    document.getElementById('stat-total').textContent = stats.total;
    document.getElementById('stat-evaluated').textContent = stats.evaluated;
    document.getElementById('stat-pending').textContent = stats.pending;
    document.getElementById('stat-avg').textContent = stats.avgScore !== null ? stats.avgScore.toFixed(1) : '-';
    document.getElementById('merchantCount').textContent = stats.total;
  } catch (e) { /* stats load fail, non-critical */ }

  await loadMerchants();
  renderDashboard();
}

async function loadMerchants() {
  try {
    const search = document.getElementById('dashSearch')?.value || '';
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    const data = await api('/api/merchants?' + params.toString());
    merchantsData = data.merchants;
  } catch (e) {
    showToast('加载商户失败: ' + e.message, 'danger');
  }
}

function renderDashboard() {
  const search = (document.getElementById('dashSearch')?.value || '').toLowerCase();
  let filtered = merchantsData;
  if (search) filtered = merchantsData.filter(m => m.name.toLowerCase().includes(search) || (m.address||'').toLowerCase().includes(search));

  const grid = document.getElementById('dashboardGrid');
  const empty = document.getElementById('emptyDashboard');

  if (filtered.length === 0) { grid.innerHTML = ''; empty.style.display = 'block'; return; }
  empty.style.display = 'none';

  grid.innerHTML = filtered.map(m => {
    const ev = m.latestEval;
    const g = ev && ev.overallScore > 0 ? getGrade(ev.overallScore) : null;
    return `<div class="merchant-card" onclick="openEvalView('${m.id}')">
      <div class="mc-header">
        <span class="mc-name">${escHtml(m.name)}</span>
        <span class="mc-type">${escHtml(m.type || '未分类')}</span>
      </div>
      <div class="mc-meta">
        <span>📍 ${escHtml(m.address || '未填写')}</span>
        <span>🏷️ ${escHtml(m.scale || '未知规模')}</span>
        ${m.creator_name ? `<span>👤 ${escHtml(m.creator_name)}</span>` : ''}
      </div>
      ${g ? `
      <div class="mc-score-row">
        <div class="mc-grade ${g.cls}">${g.grade}</div>
        <div class="mc-score-text">
          <strong>${ev.overallScore.toFixed(1)}</strong> / 5.0 · ${g.label}<br>
          <span style="font-size:12px;color:var(--text-muted)">${ev.evaluatorName || ''} 评估于 ${ev.date || ''}</span>
        </div>
      </div>
      ${renderMiniBars(ev.data)}
      ` : `
      <div class="mc-score-row">
        <div class="mc-grade NA">—</div>
        <div class="mc-score-text">尚未评估<br><span style="font-size:12px;color:var(--text-muted)">点击开始评估</span></div>
      </div>`}
      <div class="mc-actions" onclick="event.stopPropagation()">
        <button class="btn btn-ghost btn-sm" onclick="openEvalView('${m.id}')">${g ? '重新评估' : '开始评估'}</button>
        <button class="btn btn-ghost btn-sm" onclick="editMerchant('${m.id}')">编辑</button>
        ${g ? `<button class="btn btn-ghost btn-sm" onclick="viewReport('${m.id}')">查看报告</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

function renderMiniBars(evalData) {
  if (!evalData || !evalData.dimensions) return '';
  return DIMENSIONS.map(d => {
    const dimData = evalData.dimensions[d.id];
    const s = calcDimScore(dimData);
    const color = s >= 3.5 ? 'var(--success)' : s >= 2.5 ? 'var(--warning)' : 'var(--danger)';
    return `<div style="display:flex;align-items:center;gap:6px;font-size:11px;">
      <span style="width:48px;color:var(--text-muted);">${d.icon} ${d.name}</span>
      <div class="score-bar"><div class="score-bar-fill" style="width:${s*20}%;background:${color};min-width:4px;"></div></div>
      <span style="width:24px;text-align:right;font-weight:600;">${s||'-'}</span>
    </div>`;
  }).join('');
}

function escHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ============ MERCHANT LIST ============
async function loadMerchantList() {
  const search = document.getElementById('merchantSearch')?.value || '';
  const type = document.getElementById('merchantTypeFilter')?.value || '';
  const status = document.getElementById('merchantStatusFilter')?.value || '';

  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (type) params.set('type', type);
  if (status) params.set('status', status);

  try {
    const data = await api('/api/merchants?' + params.toString());
    merchantsData = data.merchants;
    renderMerchantList();
  } catch (e) {
    showToast('加载商户失败: ' + e.message, 'danger');
  }
}

function renderMerchantList() {
  const grid = document.getElementById('merchantListGrid');
  const empty = document.getElementById('emptyMerchants');
  if (merchantsData.length === 0) { grid.innerHTML = ''; empty.style.display = 'block'; return; }
  empty.style.display = 'none';

  grid.innerHTML = merchantsData.map(m => {
    const ev = m.latestEval;
    const g = ev && ev.overallScore > 0 ? getGrade(ev.overallScore) : null;
    return `<div class="merchant-card" onclick="openEvalView('${m.id}')">
      <div class="mc-header">
        <span class="mc-name">${escHtml(m.name)}</span>
        <span class="mc-type">${escHtml(m.type || '未分类')}</span>
      </div>
      <div class="mc-meta">
        <span>📍 ${escHtml(m.address || '未填写')}</span>
        <span>👤 ${escHtml(m.contact || '未填写')}</span>
        ${m.creator_name ? `<span>创建: ${escHtml(m.creator_name)}</span>` : ''}
      </div>
      ${g ? `
      <div class="mc-score-row">
        <div class="mc-grade ${g.cls}">${g.grade}</div>
        <div class="mc-score-text"><strong>${ev.overallScore.toFixed(1)}</strong> / 5.0 · ${g.label}</div>
      </div>
      <div class="mc-evaluator">评估人: ${escHtml(ev.evaluatorName || '未知')} · ${ev.date || ''}</div>
      ` : `
      <div class="mc-score-row"><div class="mc-grade NA">—</div><div class="mc-score-text">待评估</div></div>`}
      <div class="mc-actions" onclick="event.stopPropagation()">
        <button class="btn btn-ghost btn-sm" onclick="openEvalView('${m.id}')">${g ? '重新评估' : '开始评估'}</button>
        ${g ? `<button class="btn btn-ghost btn-sm" onclick="viewReport('${m.id}')">查看报告</button>` : ''}
        <button class="btn btn-ghost btn-sm" onclick="editMerchant('${m.id}')">编辑</button>
        <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="deleteMerchant('${m.id}')">删除</button>
      </div>
    </div>`;
  }).join('');
}

// ============ MERCHANT CRUD ============
function openMerchantModal(editId) {
  const modal = document.getElementById('merchantModal');
  if (editId) {
    const m = merchantsData.find(x => x.id === editId);
    if (!m) return;
    document.getElementById('modalTitle').textContent = '编辑商户';
    setField('mName', m.name || '');
    setField('mType', m.type || '');
    setField('mAddress', m.address || '');
    setField('mContact', m.contact || '');
    setField('mPhone', m.phone || '');
    setField('mScale', m.scale || '');
    setField('mRevenue', m.revenue || '');
    setField('mNote', m.note || '');
    modal._editId = editId;
  } else {
    document.getElementById('modalTitle').textContent = '新建商户';
    ['mName','mType','mAddress','mContact','mPhone','mScale','mRevenue','mNote'].forEach(id => setField(id, ''));
    modal._editId = null;
  }
  modal.classList.add('active');
}

function setField(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val;
}

function editMerchant(id) { openMerchantModal(id); }

function closeMerchantModal() { document.getElementById('merchantModal').classList.remove('active'); }

async function saveMerchant() {
  const name = document.getElementById('mName').value.trim();
  if (!name) { showToast('请输入商户名称', 'danger'); return; }

  const modal = document.getElementById('merchantModal');
  const body = {
    name, type: document.getElementById('mType').value,
    address: document.getElementById('mAddress').value.trim(),
    contact: document.getElementById('mContact').value.trim(),
    phone: document.getElementById('mPhone').value.trim(),
    scale: document.getElementById('mScale').value,
    revenue: document.getElementById('mRevenue').value,
    note: document.getElementById('mNote').value.trim()
  };

  try {
    if (modal._editId) {
      await api('/api/merchants/' + modal._editId, { method: 'PUT', body: JSON.stringify(body) });
    } else {
      await api('/api/merchants', { method: 'POST', body: JSON.stringify(body) });
    }
    closeMerchantModal();
    showToast('商户保存成功', 'success');
    loadDashboard();
    loadMerchantList();
  } catch (e) {
    showToast('保存失败: ' + e.message, 'danger');
  }
}

async function deleteMerchant(id) {
  if (!confirm('确定删除该商户及其所有评估数据？此操作不可恢复。')) return;
  try {
    await api('/api/merchants/' + id, { method: 'DELETE' });
    showToast('商户已删除', 'success');
    loadDashboard();
    loadMerchantList();
  } catch (e) {
    showToast('删除失败: ' + e.message, 'danger');
  }
}

// ============ EVALUATION ============
function openEvalView(merchantId) {
  currentMerchantId = merchantId;
  currentMerchantForEval = merchantsData.find(x => x.id === merchantId);
  if (!currentMerchantForEval) return;

  const m = currentMerchantForEval;
  // If existing evaluation, clone it; else create default
  if (m.latestEval && m.latestEval.data) {
    currentEvalData = JSON.parse(JSON.stringify(m.latestEval.data));
    currentEvalData.evaluator = m.latestEval.evaluatorName || getUser()?.display_name || '';
    currentEvalData.date = m.latestEval.date || new Date().toISOString().split('T')[0];
  } else {
    currentEvalData = getDefaultEval();
  }

  activeDimTab = 0;
  document.getElementById('evalTitle').textContent = '门店评估：' + m.name;
  document.getElementById('evalSubtitle').textContent = (m.type || '') + ' · ' + (m.address || '未填写地址');
  switchViewRaw('evaluation');
  renderEvalForm();
}

function renderEvalForm() {
  document.getElementById('dimTabs').innerHTML = DIMENSIONS.map((d, i) =>
    `<button class="dim-tab${i === activeDimTab ? ' active' : ''}" onclick="switchDimTab(${i})">${d.icon} ${d.name}</button>`
  ).join('');

  document.getElementById('dimSections').innerHTML = DIMENSIONS.map((d, i) => {
    const dimData = currentEvalData.dimensions[d.id];
    const dimScore = calcDimScore(dimData);
    return `<div class="dim-section${i === activeDimTab ? ' active' : ''}" id="dim-section-${d.id}">
      <div class="form-section">
        <h3><span class="dim-icon">${d.icon}</span> ${d.name} · 维度评估 <span style="font-size:14px;color:${d.color};margin-left:8px;">综合 ${dimScore || '-'} / 5</span></h3>
        <p style="color:var(--text-secondary);font-size:13px;margin-bottom:16px;">${d.desc}</p>
        <div class="score-items">
          ${d.subItems.map((si, siIdx) => {
            const sv = dimData.subItems[siIdx]?.score || 0;
            return `<div class="score-item">
              <span class="si-label">${si}</span>
              <div class="score-stars">${[1,2,3,4,5].map(v =>
                `<span class="score-star${v <= sv ? ' filled' : ''}" onclick="setSubScore('${d.id}',${siIdx},${v})">★</span>`
              ).join('')}</div>
              <span class="score-value">${sv || '-'}</span>
            </div>`;
          }).join('')}
        </div>
      </div>
      <div class="form-section">
        <div class="form-row full">
          <div class="form-group"><label>评语 / 现状描述</label><textarea id="txt-${d.id}-comment" onchange="updateDimField('${d.id}','comment',this.value)">${dimData.comment || ''}</textarea></div>
          <div class="form-group"><label>改进建议</label><textarea id="txt-${d.id}-suggestion" onchange="updateDimField('${d.id}','suggestion',this.value)">${dimData.suggestion || ''}</textarea></div>
        </div>
      </div>
    </div>`;
  }).join('');

  // Summary section
  document.getElementById('dimSections').innerHTML += `
    <div class="form-section" style="margin-top:8px;">
      <h3>📝 评估总结</h3>
      <div class="form-row">
        <div class="form-group"><label>评估人</label><input type="text" id="evalEvaluator" value="${escHtml(currentEvalData.evaluator || getUser()?.display_name || '')}" onchange="currentEvalData.evaluator=this.value"></div>
        <div class="form-group"><label>评估日期</label><input type="date" id="evalDate" value="${currentEvalData.date || ''}" onchange="currentEvalData.date=this.value"></div>
      </div>
      <div class="form-row full" style="margin-top:12px;">
        <div class="form-group"><label>整体评语摘要（将显示在报告顶部）</label><textarea id="evalSummary" onchange="currentEvalData.summary=this.value">${currentEvalData.summary || ''}</textarea></div>
      </div>
    </div>`;
}

function switchDimTab(idx) {
  activeDimTab = idx;
  document.querySelectorAll('.dim-tab').forEach((t, i) => t.classList.toggle('active', i === idx));
  document.querySelectorAll('.dim-section').forEach((s, i) => s.classList.toggle('active', i === idx));
}

function setSubScore(dimId, subIdx, val) {
  const currentVal = currentEvalData.dimensions[dimId].subItems[subIdx].score;
  currentEvalData.dimensions[dimId].subItems[subIdx].score = (currentVal === val) ? 0 : val;
  renderEvalForm();
  switchDimTab(activeDimTab);
}

function updateDimField(dimId, field, val) {
  currentEvalData.dimensions[dimId][field] = val;
}

// ============ SAVE & REPORT ============
async function saveAndViewReport() {
  if (!currentMerchantId || isSaving) return;

  let hasScores = false;
  DIMENSIONS.forEach(d => { if (calcDimScore(currentEvalData.dimensions[d.id]) > 0) hasScores = true; });
  if (!hasScores) { showToast('请至少为一个维度打分', 'danger'); return; }

  // Sync fields from DOM
  const evalEl = document.getElementById('evalEvaluator');
  if (evalEl) currentEvalData.evaluator = evalEl.value;
  const dateEl = document.getElementById('evalDate');
  if (dateEl) currentEvalData.date = dateEl.value;
  const summaryEl = document.getElementById('evalSummary');
  if (summaryEl) currentEvalData.summary = summaryEl.value;

  const overallScore = calcOverallScore(currentEvalData);
  const grade = getGrade(overallScore);
  const evaluatorName = currentEvalData.evaluator || getUser()?.display_name || '';

  isSaving = true;
  document.getElementById('btnSaveEval').disabled = true;
  document.getElementById('btnSaveEval').textContent = '保存中...';

  try {
    await api('/api/merchants/' + currentMerchantId + '/evaluations', {
      method: 'POST',
      body: JSON.stringify({
        data: currentEvalData,
        overallScore,
        grade: grade.grade,
        evaluatorName
      })
    });
    showToast('评估已保存', 'success');
    // Store for report viewing
    currentEvalData.overallScore = overallScore;
    currentEvalData.grade = grade;
    await loadMerchants(); // Refresh data
    viewReport(currentMerchantId);
  } catch (e) {
    showToast('保存失败: ' + e.message, 'danger');
  } finally {
    isSaving = false;
    document.getElementById('btnSaveEval').disabled = false;
    document.getElementById('btnSaveEval').textContent = '保存并查看报告';
  }
}

function viewReport(merchantId) {
  const m = merchantsData.find(x => x.id === merchantId);
  if (!m || !m.latestEval) { showToast('该商户尚未评估', 'danger'); return; }
  currentMerchantId = merchantId;
  currentMerchantForEval = m;
  currentEvalData = { ...m.latestEval.data, overallScore: m.latestEval.overallScore, evaluator: m.latestEval.evaluatorName, date: m.latestEval.date };

  document.getElementById('reportSubtitle').textContent = m.name + ' · ' + (m.type || '') + ' · 评估日期 ' + (m.latestEval.date || '');
  switchViewRaw('report');
  renderReport(m);
  setTimeout(() => drawRadarChart(), 150);
}

function renderReport(m) {
  const ev = m.latestEval;
  const overall = ev.overallScore;
  const g = getGrade(overall);
  const evalData = ev.data;
  const dimScores = DIMENSIONS.map(d => ({ ...d, score: calcDimScore(evalData.dimensions?.[d.id]), data: evalData.dimensions?.[d.id] }));
  const sorted = [...dimScores].sort((a,b) => b.score - a.score);
  const strongDims = sorted.filter(d => d.score >= 3.5);
  const weakDims = sorted.filter(d => d.score > 0 && d.score < 2.5);

  document.getElementById('reportContent').innerHTML = `
    <div class="report-header">
      <h2>${escHtml(m.name)} · 门店经营评估报告</h2>
      <div class="rh-meta">
        <span>🏷️ ${escHtml(m.type || '未分类')}</span>
        <span>📍 ${escHtml(m.address || '未填写地址')}</span>
        <span>📅 ${ev.date || ''}</span>
        <span>👤 ${escHtml(ev.evaluatorName || '未署名')}</span>
      </div>
    </div>

    <div class="report-overall">
      <div class="ro-grade ${g.cls}">
        <span class="ro-grade-text">${g.grade}</span>
        <span class="ro-grade-label">${g.label}</span>
      </div>
      <div class="ro-info">
        <h4>综合评分：${overall.toFixed(1)} / 5.0</h4>
        <p>${evalData.summary || '基于7个维度对门店经营状况进行了系统评估。'}</p>
        <p style="margin-top:4px;font-size:12px;">
          优势维度：${strongDims.length ? strongDims.map(d=>d.name).join('、') : '暂无显著优势'} |
          待改善：${weakDims.length ? weakDims.map(d=>d.name).join('、') : '各维度较为均衡'}
        </p>
      </div>
    </div>

    <div class="report-chart-row">
      <div class="chart-box"><canvas id="radarChart" width="320" height="320"></canvas></div>
      <div class="dim-summary-list">
        ${sorted.map(d => {
          const cls = d.score >= 3.5 ? 'strong' : d.score < 2.5 ? 'weak' : '';
          return `<div class="dim-summary ${cls}">
            <div class="ds-header">
              <span class="ds-name">${d.icon} ${d.name}</span>
              <span class="ds-score" style="color:${d.color}">${d.score || '-'}</span>
            </div>
            <div class="ds-suggestion">${d.data?.suggestion || (d.score ? '—' : '尚未评分')}</div>
          </div>`;
        }).join('')}
      </div>
    </div>

    <h3 style="margin-bottom:16px;font-size:17px;">📋 各维度详细评估</h3>
    <div class="report-detail-grid">
      ${dimScores.map(d => `
        <div class="report-dim-card">
          <div class="rdc-header">
            <span class="rdc-name">${d.icon} ${d.name}</span>
            <span class="rdc-score" style="color:${d.color}">${d.score || '-'} / 5</span>
          </div>
          <div class="sub-scores">
            ${(d.data?.subItems || []).map(si =>
              `<span class="sub-score-tag">${escHtml(si.name)} <span class="sst-val">${si.score || '-'}</span></span>`
            ).join('')}
          </div>
          ${d.data?.comment ? `<div class="rdc-comment">💬 ${escHtml(d.data.comment)}</div>` : ''}
          ${d.data?.suggestion ? `<div class="rdc-suggestion">💡 建议：${escHtml(d.data.suggestion)}</div>` : ''}
        </div>
      `).join('')}
    </div>

    <div class="disclaimer">
      <h4>📌 免责声明</h4>
      <p>本报告基于评估时的门店信息与观察，提供一个相对客观的经营参考。评分仅为经营诊断参考，不构成投资或经营决策建议。每个门店有其独特情况，建议结合实际情况综合判断。无论是否与我方达成合作，我们都希望这份评估能帮助您更好地理解门店的经营现状。</p>
    </div>
  `;
}

let radarChartInstance = null;
function drawRadarChart() {
  const canvas = document.getElementById('radarChart');
  if (!canvas) return;
  if (radarChartInstance) radarChartInstance.destroy();

  const evalData = currentEvalData.dimensions || currentEvalData;
  const labels = DIMENSIONS.map(d => d.name);
  const data = DIMENSIONS.map(d => calcDimScore(evalData[d.id]));
  const colors = DIMENSIONS.map(d => d.color);

  radarChartInstance = new Chart(canvas, {
    type: 'radar',
    data: {
      labels,
      datasets: [{
        label: '门店评分',
        data,
        backgroundColor: 'rgba(37,99,235,0.15)',
        borderColor: '#2563EB',
        borderWidth: 2,
        pointBackgroundColor: data.map((v, i) => v > 0 ? colors[i] : '#CBD5E1'),
        pointBorderColor: '#fff',
        pointBorderWidth: 2,
        pointRadius: 6,
        pointHoverRadius: 9,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      scales: {
        r: {
          beginAtZero: true, max: 5, min: 0,
          ticks: { stepSize: 1, backdropColor: 'transparent', font: { size: 10 } },
          pointLabels: { font: { size: 12, weight: 'bold' }, color: '#1E293B' },
          grid: { color: '#E2E8F0' },
          angleLines: { color: '#E2E8F0' },
        }
      },
      plugins: { legend: { display: false } }
    }
  });
}

function goBackToEval() {
  if (currentMerchantId) openEvalView(currentMerchantId);
}

// ============ INIT ============
document.addEventListener('DOMContentLoaded', () => {
  loadDashboard();

  // Modal overlay click to close
  document.getElementById('merchantModal').addEventListener('click', function(e) {
    if (e.target === this) closeMerchantModal();
  });

  // Global error handler for network issues
  window.addEventListener('unhandledrejection', function(e) {
    if (e.reason && e.reason.message === 'Failed to fetch') {
      showToast('网络连接失败，请检查网络', 'danger');
    }
  });
});
