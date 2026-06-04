// ── State ────────────────────────────────────────────────────
let token = localStorage.getItem('token');
let currentUser = JSON.parse(localStorage.getItem('user') || 'null');
let currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
let charts = {};

const CATEGORIES = ['Moradia','Alimentação','Transporte','Saúde','Educação','Lazer','Vestuário','Contas','Outros'];
const MONTHS_PT = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
const CAT_COLORS = ['#1565C0','#E65100','#6A1B9A','#B71C1C','#00838F','#F9A825','#AD1457','#37474F','#558B2F'];
const PM_TYPES = { dinheiro: '💵 Dinheiro', pix: '⚡ PIX', credito: '💳 Crédito', debito: '🏧 Débito' };
let paymentMethods = []; // cached list
let savingsAccounts = []; // cached list
let _historyPage = 1;
let _txPage = 1;
const PAGE_SIZE = 20;
let remindersList = [];
let currentAlertReminder = null;
let reminderPollInterval = null;
let shoppingItems = [];
let shoppingLists = [];
let activeShoppingOwnerId = null;
let chargePollInterval = null;
let currentCharges = { incoming:[], outgoing:[] };

// ── Helpers ──────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const fmtBRL = v => 'R$ ' + (v||0).toLocaleString('pt-BR', {minimumFractionDigits:2, maximumFractionDigits:2});
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const applyTxFiltersDebounced = debounce(() => { _txPage = 1; applyTxFilters(); }, 250);
const fmtPct = v => ((v||0)*100).toFixed(1) + '%';
const fmtDate = s => s ? s.split('-').reverse().join('/') : '';
const monthLabel = m => { const [y,mo] = m.split('-'); return MONTHS_PT[parseInt(mo)-1] + ' ' + y; };
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));

function toast(msg, type='success') {
  let el = $('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.className = `show ${type}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3000);
}

// AbortController por página — cancela fetches ao navegar antes de concluir
let _pageAbort = null;
function newPageSignal() {
  _pageAbort?.abort();
  _pageAbort = new AbortController();
  return _pageAbort.signal;
}

async function api(method, path, body, signal) {
  const res = await fetch(path, {
    method, signal: signal || undefined,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Erro');
  return data;
}

function destroyChart(key) {
  if (charts[key]) { charts[key].destroy(); delete charts[key]; }
}

// ── Auth ─────────────────────────────────────────────────────
function showTab(tab) {
  document.querySelectorAll('.tab-btn').forEach((b,i) => b.classList.toggle('active', (i===0&&tab==='login')||(i===1&&tab==='register')));
  $('login-form').classList.toggle('hidden', tab !== 'login');
  $('register-form').classList.toggle('hidden', tab !== 'register');
  $('forgot-form')?.classList.toggle('hidden', tab !== 'forgot');
  $('reset-form')?.classList.toggle('hidden', tab !== 'reset');
}

async function forgotPassword(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  const msg = $('forgot-msg');
  btn.disabled = true; btn.textContent = 'Enviando...';
  try {
    await api('POST', '/api/forgot-password', { email: $('forgot-email').value });
    msg.className = ''; msg.style.background='#e8f5e9'; msg.style.color='#2e7d32'; msg.style.border='1px solid #a5d6a7';
    msg.textContent = '✅ Se este e-mail estiver cadastrado, você receberá o link em breve.';
    msg.classList.remove('hidden');
    btn.textContent = 'Enviado!';
  } catch(err) {
    msg.className = ''; msg.style.background='#ffebee'; msg.style.color='#c62828'; msg.style.border='1px solid #ef9a9a';
    msg.textContent = err.message || 'Erro ao enviar. Tente novamente.';
    msg.classList.remove('hidden');
    btn.disabled = false; btn.textContent = 'Enviar link de recuperação';
  }
}

async function resetPassword(e) {
  e.preventDefault();
  const pw1 = $('reset-password').value;
  const pw2 = $('reset-password2').value;
  const errEl = $('reset-error');
  if (pw1 !== pw2) { errEl.textContent = 'As senhas não coincidem.'; errEl.classList.remove('hidden'); return; }
  const token = new URLSearchParams(location.search).get('reset');
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true; btn.textContent = 'Salvando...';
  try {
    await api('POST', '/api/reset-password', { token, password: pw1 });
    errEl.className = ''; errEl.style.background='#e8f5e9'; errEl.style.color='#2e7d32'; errEl.style.border='1px solid #a5d6a7';
    errEl.textContent = '✅ Senha redefinida! Redirecionando para o login...';
    errEl.classList.remove('hidden');
    // Limpa o token da URL e vai para login
    setTimeout(() => { history.replaceState({}, '', '/'); showTab('login'); }, 2000);
  } catch(err) {
    errEl.style.background=''; errEl.style.color=''; errEl.style.border='';
    errEl.textContent = err.message || 'Link inválido ou expirado.';
    errEl.classList.remove('hidden');
    btn.disabled = false; btn.textContent = 'Redefinir senha';
  }
}

// Detectar token de reset na URL ao carregar
(function checkResetToken() {
  const token = new URLSearchParams(location.search).get('reset');
  if (token) {
    document.addEventListener('DOMContentLoaded', () => showTab('reset'), { once: true });
    // fallback se DOM já carregou
    if (document.readyState !== 'loading') showTab('reset');
  }
})();

async function login(e) {
  e.preventDefault();
  const err = $('login-error');
  err.classList.add('hidden');
  try {
    const data = await api('POST', '/api/login', { email: $('login-email').value, password: $('login-password').value });
    saveSession(data);
  } catch(ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
}

async function register(e) {
  e.preventDefault();
  const err = $('reg-error');
  err.classList.add('hidden');
  try {
    const data = await api('POST', '/api/register', { name: $('reg-name').value, email: $('reg-email').value, password: $('reg-password').value });
    saveSession(data);
  } catch(ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
}

function saveSession({ token: t, user }) {
  token = t; currentUser = user;
  localStorage.setItem('token', t);
  localStorage.setItem('user', JSON.stringify(user));
  bootApp();
}

function logout() {
  token = null; currentUser = null;
  localStorage.clear();
  location.reload();
}

function openChangePassword(required=false) {
  openModal(required ? 'Definir nova senha' : 'Alterar senha', `
    <div class="modal-form">
      ${required ? '<p style="color:var(--gray-700);font-size:.9rem">Sua senha é temporária. Cadastre uma nova senha para continuar.</p>' : `
      <div class="field"><label>Senha atual</label><input type="password" id="pwd-current"></div>`}
      <div class="field"><label>Nova senha</label><input type="password" id="pwd-new" minlength="6" placeholder="mínimo 6 caracteres"></div>
      <div class="field"><label>Confirmar nova senha</label><input type="password" id="pwd-confirm" minlength="6"></div>
      <div class="modal-actions">
        ${required ? '' : '<button class="btn-secondary" onclick="closeModal()">Cancelar</button>'}
        <button class="btn-primary" onclick="savePasswordChange()">Salvar senha</button>
      </div>
    </div>`);
}

async function savePasswordChange() {
  const np = $('pwd-new').value;
  if (np !== $('pwd-confirm').value) return toast('As senhas não conferem', 'error');
  try {
    await api('PUT', '/api/change-password', { current_password: $('pwd-current')?.value || '', new_password: np });
    currentUser.must_change_password = 0;
    localStorage.setItem('user', JSON.stringify(currentUser));
    closeModal();
    toast('Senha atualizada!');
  } catch(e) { toast(e.message, 'error'); }
}

// ── Boot ─────────────────────────────────────────────────────
async function bootApp() {
  $('auth-screen').classList.add('hidden');
  $('app-screen').classList.remove('hidden');
  document.body.classList.remove('auth-page');

  $('user-name-nav').textContent = currentUser.name;
  $('user-email-nav').textContent = currentUser.email;
  $('user-avatar').textContent = currentUser.name[0].toUpperCase();
  document.querySelectorAll('.admin-only').forEach(el => el.classList.toggle('hidden', !currentUser.is_admin));

  if (currentUser.must_change_password) {
    openChangePassword(true);
  }

  paymentMethods = await api('GET', '/api/payment-methods').catch(() => []);
  savingsAccounts = await api('GET', '/api/savings').catch(() => []);

  updateMonthDisplay();
  navigate('dashboard');
  startReminderPolling();
  startChargePolling();
}

// ── Month navigation ─────────────────────────────────────────
function updateMonthDisplay() {
  $('month-display').textContent = monthLabel(currentMonth) + ' ▾';
}

function changeMonth(dir) {
  const [y, m] = currentMonth.split('-').map(Number);
  const d = new Date(y, m - 1 + dir, 1);
  currentMonth = d.toISOString().slice(0, 7);
  updateMonthDisplay();
  const active = document.querySelector('.nav-item.active');
  if (active) navigate(active.dataset.page || 'dashboard');
}

function toggleMonthPicker() {
  const picker = $('month-picker');
  if (!picker.classList.contains('hidden')) {
    picker.classList.add('hidden');
    return;
  }
  renderMonthPicker();
  picker.classList.remove('hidden');
}

function renderMonthPicker() {
  const picker = $('month-picker');
  const now = new Date();
  const [cy, cm] = currentMonth.split('-').map(Number);

  // Range: 3 years back to 1 year ahead
  const startYear = now.getFullYear() - 3;
  const endYear = now.getFullYear() + 1;

  let html = '<div class="month-picker-header"><span>Selecionar competência</span></div>';

  for (let year = endYear; year >= startYear; year--) {
    html += `<div class="month-picker-year">${year}</div><div class="month-picker-grid">`;
    for (let mo = 1; mo <= 12; mo++) {
      const val = `${year}-${String(mo).padStart(2,'0')}`;
      const isFuture = year > now.getFullYear() || (year === now.getFullYear() && mo > now.getMonth() + 1);
      const isActive = year === cy && mo === cm;
      html += `<button class="month-picker-btn${isActive ? ' active' : ''}${isFuture ? ' future' : ''}" onclick="selectMonth('${val}')">${MONTHS_PT[mo-1]}</button>`;
    }
    html += '</div>';
  }

  picker.innerHTML = html;
  // Scroll to active month
  setTimeout(() => {
    const active = picker.querySelector('.active');
    if (active) active.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, 50);
}

function selectMonth(val) {
  currentMonth = val;
  updateMonthDisplay();
  $('month-picker').classList.add('hidden');
  loadSidebarPanels();
  const active = document.querySelector('.nav-item.active');
  if (active) navigate(active.dataset.page || 'dashboard');
}

// Close picker when clicking outside
document.addEventListener('click', e => {
  const sel = $('month-selector');
  if (sel && !sel.contains(e.target)) $('month-picker')?.classList.add('hidden');
});



// ── Navigation ────────────────────────────────────────────────
const pages = { dashboard: renderDashboard, transactions: renderTransactions, categories: renderCategories, cards: renderCards, incomeSources: renderIncomeSources, savings: renderSavings, goals: renderGoals, charges: renderCharges, shoppingList: renderShoppingList, history: renderHistory, users: renderUsers, report: renderReport };
const pageTitles = { dashboard: '📊 Dashboard', transactions: '💸 Lançamentos', categories: '📋 Categorias', cards: '💳 Cartões', incomeSources: '💼 Proventos', savings: '🏦 Cofrinhos', goals: '🎯 Metas', charges: '💲 Cobranças', shoppingList: '🛒 Lista de mercado', history: '🧾 Histórico', users: '👥 Usuários', report: '📅 Relatório' };

function navigate(page) {
  document.querySelectorAll('.nav-item').forEach(el => { el.classList.remove('active'); el.dataset.page = el.getAttribute('onclick')?.match(/'(\w+)'/)?.[1]; });
  document.querySelectorAll('.nav-item').forEach(el => { if (el.dataset.page === page) el.classList.add('active'); });
  $('page-title').textContent = pageTitles[page] || page;
  Object.keys(charts).forEach(destroyChart);
  $('main-content').innerHTML = '<div class="loading-page"><div class="spinner"></div></div>';
  if (window.innerWidth < 768) closeSidebar();
  // Cancela fetches da página anterior antes de iniciar a nova
  Promise.resolve(pages[page]?.()).catch(e => { if (e?.name !== 'AbortError') console.error(e); });
}

function toggleSidebar() {
  const sb = $('sidebar'), ov = $('sidebar-overlay');
  const open = sb.classList.toggle('open');
  ov.classList.toggle('hidden', !open);
}
function closeSidebar() {
  $('sidebar').classList.remove('open');
  $('sidebar-overlay').classList.add('hidden');
}

// ── Modal ─────────────────────────────────────────────────────
function openModal(title, html) {
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = html;
  $('modal-overlay').classList.remove('hidden');
}
function closeModal() { $('modal-overlay').classList.add('hidden'); }

// ── Dashboard ─────────────────────────────────────────────────
async function renderDashboard() {
  const sig = newPageSignal();
  const data = await api('GET', `/api/summary?month=${currentMonth}`, null, sig);
  const savingRate = data.income > 0 ? (data.balance / data.income) : 0;

  const limitsMap = {};
  (data.limits || []).forEach(l => limitsMap[l.category] = l.limit_amount);

  // Pug mood
  const pugMood = calcPugMood(data.income, data.expense, data.balance, data.limits, data.byCategory);
  const PUG_INFO = {
    eufórico:   { label:'Eufórico! 🎉',    msg:'Você é um gênio das finanças! Continua assim!',           color:'#2e7d32' },
    feliz:      { label:'Feliz! 😊',        msg:'Ótimo mês! Bom trabalho guardando dinheiro.',             color:'#388e3c' },
    normal:     { label:'Normal 🙂',        msg:'Tá indo... Mas dá pra guardar um pouquinho mais!',        color:'#f57c00' },
    preocupado: { label:'Preocupado 😟',    msg:'Cuidado! Alguns limites estão quase no teto...',          color:'#e65100' },
    assustado:  { label:'Assustado! 😱',    msg:'Ei! Tem limite ultrapassado ou o saldo está negativo!',   color:'#c62828' },
    desesperado:{ label:'Desesperado! 😭',  msg:'Situação crítica! Revise os gastos urgente!',             color:'#880000' },
  };
  const pi = PUG_INFO[pugMood];

  $('main-content').innerHTML = `
    <div class="cards-grid">
      <div class="card green-border">
        <div class="card-icon">💵</div>
        <div class="card-label">Receita</div>
        <div class="card-value text-green">${fmtBRL(data.income)}</div>
      </div>
      <div class="card red-border">
        <div class="card-icon">💸</div>
        <div class="card-label">Despesas</div>
        <div class="card-value text-red">${fmtBRL(data.expense)}</div>
      </div>
      <div class="card ${data.balance>=0?'green-border':'red-border'}">
        <div class="card-icon">💰</div>
        <div class="card-label">Saldo</div>
        <div class="card-value ${data.balance>=0?'text-green':'text-red'}">${fmtBRL(data.balance)}</div>
      </div>
      <div class="card blue-border">
        <div class="card-icon">📈</div>
        <div class="card-label">Taxa Poupança</div>
        <div class="card-value" style="color:var(--blue)">${fmtPct(savingRate)}</div>
      </div>
    </div>

    <!-- 🐾 Pug widget -->
    <div class="pug-widget">
      <div class="pug-svg-wrap">${pugSVG(pugMood)}</div>
      <div class="pug-info">
        <div class="pug-mood-label" style="color:${pi.color}">${pi.label}</div>
        <div class="pug-mood-msg">${pi.msg}</div>
        <div class="pug-footer">🐾 O pugzinho reflete seu orçamento de ${monthLabel(currentMonth)}</div>
      </div>
    </div>

    <div class="charts-grid">
      <div class="chart-card">
        <h3>Gastos por Categoria</h3>
        <div class="chart-wrap"><canvas id="chart-pie"></canvas></div>
      </div>
      <div class="chart-card">
        <h3>Evolução Mensal</h3>
        <div class="chart-wrap"><canvas id="chart-monthly"></canvas></div>
      </div>
    </div>

    <div class="table-card">
      <div class="table-header">
        <h3>Limites por Categoria</h3>
      </div>
      <div id="limits-list">
        ${(data.byCategory.length === 0 && Object.keys(limitsMap).length === 0) ? '<div class="empty-state"><div class="empty-icon">📊</div><p>Nenhum gasto registrado neste mês</p></div>' : ''}
        ${CATEGORIES.map(cat => {
          const spent = data.byCategory.find(b => b.category === cat)?.total || 0;
          const limit = limitsMap[cat] || 0;
          const pct = limit > 0 ? Math.min(spent / limit, 1) : 0;
          const over = limit > 0 && spent > limit;
          const warn = limit > 0 && spent / limit >= 0.9 && !over;
          const barClass = over ? 'progress-red' : warn ? 'progress-orange' : 'progress-green';
          const badge = over ? '<span class="badge badge-red">🚨 Excedido</span>' : warn ? '<span class="badge badge-orange">⚠️ Atenção</span>' : spent===0 ? '<span class="badge badge-blue">✅ Sem gastos</span>' : '<span class="badge badge-green">✅ OK</span>';
          return `
            <div class="limit-row">
              <div class="limit-name">${cat}</div>
              <div class="limit-bar-wrap">
                <div class="limit-meta">
                  <span>${fmtBRL(spent)} de ${fmtBRL(limit)}</span>
                  <span>${limit > 0 ? fmtPct(spent/limit) : '—'}</span>
                </div>
                <div class="progress-wrap"><div class="progress-bar ${barClass}" style="width:${pct*100}%"></div></div>
              </div>
              ${badge}
            </div>`;
        }).join('')}
      </div>
    </div>
  `;

  // Pie chart
  if (data.byCategory.length > 0) {
    charts['pie'] = new Chart($('chart-pie'), {
      type: 'pie',
      data: {
        labels: data.byCategory.map(b => b.category),
        datasets: [{ data: data.byCategory.map(b => b.total), backgroundColor: CAT_COLORS, borderWidth: 2, borderColor: '#fff' }]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { font: { size: 11 }, padding: 10 } } } }
    });
  } else {
    $('chart-pie').parentElement.innerHTML = '<div class="empty-state" style="height:200px"><div class="empty-icon">🥧</div><p>Sem despesas neste mês</p></div>';
  }

  // Monthly bar chart — current month + next 5
  const targetMonths = Array.from({length: 6}, (_, i) => {
    const [y, m] = currentMonth.split('-').map(Number);
    return new Date(y, m - 1 + i, 1).toISOString().slice(0, 7);
  });
  const monthMap = Object.fromEntries((data.monthly || []).map(m => [m.month, m]));
  const monthly = targetMonths.map(m => monthMap[m] || { month: m, income: 0, expense: 0 });
  if (monthly.length > 0) {
    charts['monthly'] = new Chart($('chart-monthly'), {
      type: 'bar',
      data: {
        labels: monthly.map(m => monthLabel(m.month)),
        datasets: [
          { label: 'Receita', data: monthly.map(m => m.income), backgroundColor: '#a5d6a7', borderColor: '#2e7d32', borderWidth: 1.5, borderRadius: 6 },
          { label: 'Despesa', data: monthly.map(m => m.expense), backgroundColor: '#ef9a9a', borderColor: '#c62828', borderWidth: 1.5, borderRadius: 6 }
        ]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } }, scales: { y: { beginAtZero: true, ticks: { callback: v => 'R$' + (v/1000).toFixed(0) + 'k' } } } }
    });
  } else {
    $('chart-monthly').parentElement.innerHTML = '<div class="empty-state" style="height:200px"><div class="empty-icon">📊</div><p>Sem dados históricos</p></div>';
  }
}

// ── Transactions ──────────────────────────────────────────────
let _allTxs = []; // cache for client-side filtering

async function renderTransactions() {
  const sig = newPageSignal();
  _txPage = 1;
  _allTxs = await api('GET', `/api/transactions?month=${currentMonth}`, null, sig);

  // Collect unique categories and payment methods for filter dropdowns
  const cats = [...new Set(_allTxs.map(t => t.category))].sort();
  const pms  = [...new Set(_allTxs.map(t => t.pm_name || t.payment_type || 'dinheiro'))].sort();

  $('main-content').innerHTML = `
    <div class="table-card">
      <div class="table-header">
        <h3>Lançamentos — ${monthLabel(currentMonth)}</h3>
        <div style="display:flex;gap:.5rem">
          <button class="btn-secondary" onclick="openDepositFromTransactions()">🏦 Guardar</button>
          <button class="btn-primary" onclick="openAddTransaction()">+ Novo</button>
        </div>
      </div>

      <!-- Filtros -->
      <div class="tx-filters" id="tx-filters">
        <input type="search" id="f-search" placeholder="🔍 Buscar descrição..." oninput="applyTxFiltersDebounced()" class="f-input">
        <select id="f-type" onchange="_txPage=1;applyTxFilters()" class="f-select">
          <option value="">Tipo: Todos</option>
          <option value="Receita">💚 Receita</option>
          <option value="Despesa">❤️ Despesa</option>
        </select>
        <select id="f-cat" onchange="_txPage=1;applyTxFilters()" class="f-select">
          <option value="">Categoria: Todas</option>
          ${cats.map(c => `<option value="${c}">${c}</option>`).join('')}
        </select>
        <select id="f-pm" onchange="_txPage=1;applyTxFilters()" class="f-select">
          <option value="">Pagamento: Todos</option>
          ${pms.map(p => `<option value="${p}">${p}</option>`).join('')}
        </select>
        <button class="f-clear" onclick="clearTxFilters()" title="Limpar filtros">✕ Limpar</button>
      </div>

      <div id="tx-table-wrap"></div>
    </div>`;

  applyTxFilters();
}

function applyTxFilters() {
  const search = ($('f-search')?.value || '').toLowerCase();
  const type   = $('f-type')?.value || '';
  const cat    = $('f-cat')?.value || '';
  const pm     = $('f-pm')?.value || '';

  const filtered = _allTxs.filter(t => {
    if (search && !t.description.toLowerCase().includes(search)) return false;
    if (type   && t.type !== type) return false;
    if (cat    && t.category !== cat) return false;
    if (pm) {
      const txPm = t.pm_name || t.payment_type || 'dinheiro';
      if (txPm !== pm) return false;
    }
    return true;
  });

  const hasFilter = search || type || cat || pm;
  const wrap = $('tx-table-wrap');
  if (!wrap) return;

  if (_allTxs.length === 0) {
    wrap.innerHTML = '<div class="empty-state"><div class="empty-icon">💸</div><p>Nenhum lançamento neste mês.</p><br><button class="btn-primary" onclick="openAddTransaction()">Adicionar primeiro lançamento</button></div>';
    return;
  }
  if (filtered.length === 0) {
    wrap.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><p>Nenhum resultado para os filtros aplicados.</p>${hasFilter?'<br><button class="btn-secondary" onclick="clearTxFilters()">Limpar filtros</button>':''}</div>`;
    return;
  }

  const totR = filtered.filter(t=>t.type==='Receita').reduce((s,t)=>s+t.amount,0);
  const totD = filtered.filter(t=>t.type==='Despesa').reduce((s,t)=>s+t.amount,0);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  if (_txPage > totalPages) _txPage = totalPages;
  const pageItems = filtered.slice((_txPage - 1) * PAGE_SIZE, _txPage * PAGE_SIZE);

  wrap.innerHTML = `
    ${hasFilter ? `<div class="f-summary">
      <span>📋 ${filtered.length} de ${_allTxs.length} lançamentos</span>
      ${totR>0?`<span style="color:var(--green);font-weight:700">+${fmtBRL(totR)}</span>`:''}
      ${totD>0?`<span style="color:var(--red);font-weight:700">-${fmtBRL(totD)}</span>`:''}
    </div>` : ''}
    <div style="overflow-x:auto"><table>
      <thead><tr><th>Data</th><th>Descrição</th><th>Categoria</th><th>Pagamento</th><th>Tipo</th><th style="text-align:right">Valor</th><th></th></tr></thead>
      <tbody>
        ${pageItems.map(t => `
          <tr>
            <td style="white-space:nowrap">${fmtDate(t.date)}</td>
            <td>
              ${t.description}
              ${t.installments>1?` <span class="inst-badge">${t.installment_number}/${t.installments}</span>`:''}
              ${t.recurring_template_id?` <span class="fixed-badge">🔄 fixo</span>`:''}
              ${t.competence_month && t.competence_month !== t.date?.slice(0,7) ? `<span class="comp-badge">📅 pag. ${monthLabel(t.competence_month)}</span>` : ''}
            </td>
            <td><span class="badge badge-blue">${t.category}</span></td>
            <td>${pmBadgeHTML(t)}</td>
            <td><span class="badge ${t.type==='Receita'?'badge-green':'badge-red'}">${t.type}</span></td>
            <td style="text-align:right;font-weight:700;color:${t.type==='Receita'?'var(--green)':'var(--red)'}">${fmtBRL(t.amount)}</td>
            <td style="white-space:nowrap">
              <button class="btn-icon" onclick="openEditTransaction(${t.id})">✏️</button>
              <button class="btn-icon" onclick="deleteTransaction(${t.id},'${t.group_id||''}','${t.recurring_template_id||''}')">🗑️</button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table></div>
    ${totalPages > 1 ? `<div class="pagination">
      <button onclick="changeTxPage(-1)" ${_txPage<=1?'disabled':''}>‹ Anterior</button>
      <span class="page-info">Página ${_txPage} de ${totalPages} · ${filtered.length} lançamentos</span>
      <button onclick="changeTxPage(1)" ${_txPage>=totalPages?'disabled':''}>Próxima ›</button>
    </div>` : ''}
  `;
}

function clearTxFilters() {
  const ids = ['f-search','f-type','f-cat','f-pm'];
  ids.forEach(id => { const el = $(id); if (el) el.value = ''; });
  _txPage = 1;
  applyTxFilters();
}

function changeTxPage(dir) {
  _txPage += dir;
  applyTxFilters();
  $('tx-table-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function changeHistoryPage(dir) {
  _historyPage += dir;
  renderHistoryTable();
}

// ── Loading / Confirmation modals ─────────────────────────────
let _loadingTimers = [];

function showLoadingModal() {
  const overlay = $('loading-overlay');
  overlay.classList.remove('hidden');
  $('loading-bar').style.width = '0%';
  $('loading-pct').textContent = '0%';
  $('loading-msg').textContent = 'Iniciando...';

  const steps = [
    { pct: 20, msg: 'Validando informações...', delay: 180 },
    { pct: 50, msg: 'Registrando lançamento...', delay: 550 },
    { pct: 80, msg: 'Atualizando carteiras...', delay: 950 },
  ];
  _loadingTimers.forEach(clearTimeout);
  _loadingTimers = steps.map(({ pct, msg, delay }) =>
    setTimeout(() => {
      if (!overlay.classList.contains('hidden')) {
        $('loading-bar').style.width = pct + '%';
        $('loading-pct').textContent = pct + '%';
        $('loading-msg').textContent = msg;
      }
    }, delay)
  );
}

function hideLoadingModal(cb) {
  _loadingTimers.forEach(clearTimeout);
  $('loading-bar').style.width = '100%';
  $('loading-pct').textContent = '100%';
  $('loading-msg').textContent = 'Concluído! ✅';
  setTimeout(() => {
    $('loading-overlay').classList.add('hidden');
    if (cb) cb();
  }, 420);
}

function showTxConfirmModal(summary) {
  const installLabel = summary.is_fixed
    ? '🔄 Fixo mensal'
    : summary.installments > 1 ? `${summary.installments} parcelas` : 'À vista';
  const amtLabel = summary.installments > 1
    ? `${fmtBRL(summary.amount)} <span style="font-size:.78rem;color:var(--gray-500)">(total)</span>`
    : fmtBRL(summary.amount);

  openModal('✅ Lançamento confirmado!', `
    <div style="padding:.25rem 0 .5rem">
      <div class="confirm-row"><span>Tipo</span><span class="badge ${summary.type==='Receita'?'badge-green':'badge-red'}">${summary.type}</span></div>
      <div class="confirm-row"><span>Descrição</span><strong>${summary.desc}</strong></div>
      <div class="confirm-row"><span>Valor</span><strong style="color:${summary.type==='Receita'?'var(--green)':'var(--red)'}">${amtLabel}</strong></div>
      <div class="confirm-row"><span>Data</span>${fmtDate(summary.date)}</div>
      <div class="confirm-row"><span>Categoria</span><span class="badge badge-blue">${summary.cat}</span></div>
      <div class="confirm-row"><span>Parcelamento</span>${installLabel}</div>
      <div class="modal-actions" style="margin-top:.75rem">
        <button class="btn-secondary" onclick="closeModal();openAddTransaction()">+ Novo lançamento</button>
        <button class="btn-primary" onclick="closeModal()">OK</button>
      </div>
    </div>`);
}

function pmBadgeHTML(t) {
  if (!t.payment_type || t.payment_type === 'dinheiro') return '<span class="pm-badge pm-badge-dinheiro">💵 Dinheiro</span>';
  if (t.payment_type === 'receita') return t.pm_name ? `<span class="pm-badge pm-badge-dinheiro" style="background:${t.pm_color||'#2e7d32'}">${t.pm_name}</span>` : '<span class="pm-badge pm-badge-dinheiro">Receita</span>';
  if (t.payment_type === 'pix') return '<span class="pm-badge pm-badge-pix">⚡ PIX</span>';
  if (t.pm_name) return `<span class="pm-badge pm-badge-credito" style="background:${t.pm_color||'#1565c8'}">${t.pm_name}</span>`;
  if (t.payment_type === 'debito') return '<span class="pm-badge pm-badge-debito">🏧 Débito</span>';
  return '';
}

function txFormHTML(t) {
  const isEdit = !!t;
  const d = t || { type: 'Despesa', date: new Date().toISOString().slice(0,10), payment_type: 'dinheiro', competence_month: new Date().toISOString().slice(0,7) };
  const creditCards = paymentMethods.filter(p => p.type === 'credito');
  const debitCards  = paymentMethods.filter(p => p.type === 'debito');
  const incomeSources = paymentMethods.filter(p => p.type === 'receita');
  const allCards = [...creditCards, ...debitCards];
  return `
    <div class="modal-form">
      <div class="field">
        <label>Tipo</label>
        <div class="type-toggle">
          <button type="button" id="btn-receita" class="${d.type==='Receita'?'active-receita':''}" onclick="setType('Receita')">💵 Receita</button>
          <button type="button" id="btn-despesa" class="${d.type==='Despesa'?'active-despesa':''}" onclick="setType('Despesa')">💸 Despesa</button>
        </div>
        <input type="hidden" id="tx-type" value="${d.type}">
      </div>
      <div class="row">
        <div class="field"><label>Data</label><input type="date" id="tx-date" value="${d.date||''}"></div>
        <div class="field"><label>Valor Total (R$)</label><input type="number" id="tx-amount" step="0.01" min="0.01" value="${d.amount||''}" placeholder="0,00"></div>
      </div>
      <div class="field"><label>Descrição</label><input type="text" id="tx-desc" value="${d.description?.replace(/ \(\d+\/\d+\)$/,'')||''}" placeholder="Ex: Supermercado"></div>
      <div class="field">
        <label>Categoria</label>
        <select id="tx-cat">
          <option value="Receita" ${d.category==='Receita'?'selected':''}>Receita</option>
          ${CATEGORIES.map(c => `<option value="${c}" ${d.category===c?'selected':''}>${c}</option>`).join('')}
        </select>
      </div>
      <div class="field" id="field-payment-type">
        <label>Forma de Pagamento</label>
        <select id="tx-ptype" onchange="onPtypeChange()">
          <option value="dinheiro" ${d.payment_type==='dinheiro'?'selected':''}>💵 Dinheiro</option>
          <option value="pix"      ${d.payment_type==='pix'?'selected':''}>⚡ PIX</option>
          ${allCards.map(pm => `<option value="card-${pm.id}" ${d.payment_method_id===pm.id?'selected':''}>${pm.type==='credito'?'💳':'🏧'} ${pm.name}</option>`).join('')}
          <option value="debito" ${d.payment_type==='debito'&&!d.payment_method_id?'selected':''}>🏧 Débito (outro)</option>
        </select>
      </div>
      <div class="field hidden" id="field-income-source">
        <label>Fonte de Receita / Provento</label>
        <select id="tx-income-source">
          <option value="">Sem fonte detalhada</option>
          ${incomeSources.map(pm => `<option value="${pm.id}" ${d.payment_method_id===pm.id?'selected':''}>${pm.name}</option>`).join('')}
        </select>
        <div style="font-size:.75rem;color:var(--gray-500);margin-top:.25rem">Use a aba Proventos para criar fontes como salÃ¡rio, benefÃ­cio, aluguel ou comissÃ£o.</div>
      </div>
      <div class="field" id="field-competence">
        <label>📅 Mês de pagamento / competência
          <span style="font-size:.75rem;color:var(--gray-500);font-weight:400"> — quando entra no orçamento</span>
        </label>
        <input type="month" id="tx-competence" value="${d.competence_month || d.date?.slice(0,7) || new Date().toISOString().slice(0,7)}"
               style="width:100%;padding:.65rem .9rem;border:1.5px solid var(--gray-300);border-radius:8px;font-size:.9rem;outline:none">
        <div style="font-size:.75rem;color:var(--gray-500);margin-top:.25rem" id="competence-hint"></div>
      </div>
      <div class="field hidden" id="field-installments">
        <label>Parcelas</label>
        <select id="tx-installments">
          <option value="1">À vista</option>
          ${Array.from({length:23},(_,i)=>i+2).map(n=>`<option value="${n}" ${d.installments===n?'selected':''}>${n}x</option>`).join('')}
        </select>
      </div>
      <div class="field hidden" id="field-installment-amount-mode">
        <label>Valor informado</label>
        <select id="tx-amount-mode">
          <option value="total">Valor total da compra</option>
          <option value="parcel">Valor de cada parcela</option>
        </select>
      </div>
      <div class="field"><label>Observação (opcional)</label><input type="text" id="tx-note" value="${d.note||''}" placeholder="..."></div>
      ${isEdit && d.group_id ? `
      <div class="fixed-check-row">
        <input type="checkbox" id="tx-edit-all-installments">
        <label for="tx-edit-all-installments">Editar todas as parcelas deste lançamento</label>
      </div>` : ''}
      ${isEdit && !d.recurring_template_id && !d.group_id ? `
      <div class="fixed-check-row" style="border-top:1px solid var(--gray-200);padding-top:.75rem;margin-top:.25rem">
        <input type="checkbox" id="tx-convert-fixed">
        <label for="tx-convert-fixed">🔄 Converter para lançamento fixo (replica todo mês automaticamente)</label>
      </div>` : ''}
      ${isEdit && d.recurring_template_id ? `
      <div style="padding:.5rem .75rem;background:#e8f5e9;border-radius:8px;font-size:.82rem;color:#2e7d32;margin-top:.25rem">
        🔄 <strong>Lançamento fixo ativo</strong> — replica automaticamente todo mês.
      </div>` : ''}
      ${!isEdit ? `
      <div class="fixed-check-row">
        <input type="checkbox" id="tx-fixed" onchange="onFixedChange()">
        <label for="tx-fixed">🔄 Lançamento Fixo (replica todo mês automaticamente)</label>
      </div>
      ${savingsAccounts.length > 0 ? `
      <div class="fixed-check-row">
        <input type="checkbox" id="tx-to-savings" onchange="onSavingsCheck()">
        <label for="tx-to-savings">🏦 Guardar em cofrinho</label>
      </div>
      <div id="field-savings-acc" class="field hidden">
        <label>Cofrinho de destino</label>
        <select id="tx-savings-acc">
          ${savingsAccounts.map(a => `<option value="${a.id}">${a.name}</option>`).join('')}
        </select>
      </div>` : ''}` : ''}
      <div class="modal-actions">
        <button class="btn-secondary" onclick="closeModal()">Cancelar</button>
        <button class="btn-primary" onclick="${isEdit?`saveEditTransaction(${t.id})`:'saveNewTransaction()'}">${isEdit?'Salvar':'Adicionar'}</button>
      </div>
    </div>`;
}

function onPtypeChange() {
  const sel = $('tx-ptype')?.value || 'dinheiro';
  const instField = $('field-installments');
  const modeField = $('field-installment-amount-mode');
  if (!instField) return;
  const pm = sel.startsWith('card-') ? paymentMethods.find(p => p.id === parseInt(sel.split('-')[1])) : null;
  const isCredit = pm?.type === 'credito';
  const isReceita = $('tx-type')?.value === 'Receita';
  if (!isReceita) {
    instField.classList.toggle('hidden', !isCredit);
    modeField?.classList.toggle('hidden', !isCredit);
  }

  // Auto-set competence month: credit card → next month by default
  const compInput = $('tx-competence');
  const hint      = $('competence-hint');
  if (!compInput) return;
  const spendDate = $('tx-date')?.value || new Date().toISOString().slice(0,10);
  const [sy, sm] = spendDate.split('-').map(Number);
  if (isCredit) {
    const nextMonth = new Date(sy, sm, 1); // sm is already 0-based because we need next month
    const nextStr   = nextMonth.toISOString().slice(0, 7);
    compInput.value = nextStr;
    compInput.style.borderColor = '#1565c8';
    if (hint) hint.innerHTML = `💳 Cartão de crédito → pagamento em <strong>${monthLabel(nextStr)}</strong>`;
  } else {
    const thisMonth = `${String(sy).padStart(4,'0')}-${String(sm).padStart(2,'0')}`;
    compInput.value = thisMonth;
    compInput.style.borderColor = '';
    if (hint) hint.innerHTML = '';
  }
}

function setType(type) {
  $('tx-type').value = type;
  $('btn-receita').className = type==='Receita' ? 'active-receita' : '';
  $('btn-despesa').className = type==='Despesa' ? 'active-despesa' : '';
  if (type === 'Receita') { $('tx-cat').value = 'Receita'; }
  const paymentField = $('field-payment-type');
  if (paymentField) paymentField.classList.toggle('hidden', type === 'Receita');
  const incomeField = $('field-income-source');
  if (incomeField) incomeField.classList.toggle('hidden', type !== 'Receita');
  const instField = $('field-installments');
  if (instField && type === 'Receita') {
    instField.classList.remove('hidden');
    const lbl = instField.querySelector('label');
    if (lbl) lbl.textContent = 'Receber em quantas parcelas?';
    const modeField = $('field-installment-amount-mode');
    if (modeField) {
      modeField.classList.remove('hidden');
      const sel = modeField.querySelector('select');
      if (sel) sel.innerHTML = `<option value="total">Valor total a receber</option><option value="parcel">Valor de cada parcela</option>`;
    }
  }
  // For Despesa, installments visibility is controlled by onPtypeChange (credit card logic)
  if (type === 'Despesa') {
    const lbl = instField?.querySelector('label');
    if (lbl) lbl.textContent = 'Parcelas';
    const sel = $('field-installment-amount-mode')?.querySelector('select');
    if (sel) sel.innerHTML = `<option value="total">Valor total da compra</option><option value="parcel">Valor de cada parcela</option>`;
    onPtypeChange();
  }
}

function onFixedChange() {
  // Fixed and installments are mutually exclusive
  const fixed = $('tx-fixed')?.checked;
  const instField = $('field-installments');
  if (fixed && instField) {
    instField.classList.add('hidden');
    $('field-installment-amount-mode')?.classList.add('hidden');
  }
  else onPtypeChange();
}

function onSavingsCheck() {
  const checked = $('tx-to-savings')?.checked;
  $('field-savings-acc')?.classList.toggle('hidden', !checked);
  if (checked && $('tx-type')) { $('tx-type').value = 'Despesa'; setType('Despesa'); }
}

function parsePtypeValue(selValue) {
  if (!selValue || selValue === 'dinheiro') return { payment_type: 'dinheiro', payment_method_id: null };
  if (selValue === 'pix') return { payment_type: 'pix', payment_method_id: null };
  if (selValue === 'debito') return { payment_type: 'debito', payment_method_id: null };
  if (selValue.startsWith('card-')) {
    const id = parseInt(selValue.split('-')[1]);
    const pm = paymentMethods.find(p => p.id === id);
    return { payment_type: pm?.type || 'credito', payment_method_id: id };
  }
  return { payment_type: 'dinheiro', payment_method_id: null };
}

function openAddTransaction() {
  openModal('Novo Lançamento', txFormHTML(null));
  setType('Despesa');
  onPtypeChange();
}

async function openEditTransaction(id) {
  // Usa cache da página atual; caso contrário busca somente este ID
  const t = _allTxs.find(x => x.id === id) || await api('GET', `/api/transactions/${id}`);
  if (t) {
    openModal('Editar Lançamento', txFormHTML(t));
    setType(t.type || 'Despesa');
    onPtypeChange();
  }
}

async function saveNewTransaction() {
  // Captura resumo antes de fechar o modal
  const summary = {
    type: $('tx-type').value,
    desc: $('tx-desc').value,
    amount: parseFloat($('tx-amount').value) || 0,
    date: $('tx-date').value,
    cat: $('tx-cat').value,
    installments: parseInt($('tx-installments')?.value) || 1,
    is_fixed: $('tx-fixed')?.checked || false,
  };

  let { payment_type, payment_method_id } = parsePtypeValue($('tx-ptype')?.value);
  if (summary.type === 'Receita') {
    payment_type = 'receita';
    payment_method_id = $('tx-income-source')?.value || null;
  }
  const toSavings = $('tx-to-savings')?.checked || false;
  const savingsAccId = $('tx-savings-acc')?.value;

  closeModal();
  showLoadingModal();

  try {
    const result = await api('POST', '/api/transactions', {
      date: summary.date, description: summary.desc,
      category: summary.cat, type: summary.type,
      amount: summary.amount, note: $('tx-note')?.value || '',
      payment_type, payment_method_id,
      installments: summary.is_fixed ? 1 : summary.installments,
      amount_mode: $('tx-amount-mode')?.value || 'total',
      is_fixed: summary.is_fixed,
      competence_month: $('tx-competence')?.value || null
    });

    if (toSavings && savingsAccId) {
      const txId = result.id || (result.ids && result.ids[0]);
      await api('POST', `/api/savings/${savingsAccId}/deposits`, {
        amount: summary.amount, date: summary.date,
        note: summary.desc, transaction_id: txId
      });
      savingsAccounts = await api('GET', '/api/savings').catch(() => savingsAccounts);
    }

    hideLoadingModal(() => showTxConfirmModal(summary));
    paymentMethods = await api('GET', '/api/payment-methods').catch(() => paymentMethods);
    renderTransactions();
  } catch(e) {
    hideLoadingModal();
    toast(e.message, 'error');
  }
}

async function saveEditTransaction(id) {
  try {
    let { payment_type, payment_method_id } = parsePtypeValue($('tx-ptype')?.value);
    if ($('tx-type').value === 'Receita') {
      payment_type = 'receita';
      payment_method_id = $('tx-income-source')?.value || null;
    }
    // Check if it's a recurring transaction — usa cache ou busca individual
    const tx = _allTxs.find(t => t.id === id) || await api('GET', `/api/transactions/${id}`);
    let update_future = false;
    if (tx?.recurring_template_id) {
      update_future = confirm('Este é um lançamento fixo.\n\nOK = atualizar este mês e todos os futuros\nCancelar = atualizar só este mês');
    }
    await api('PUT', `/api/transactions/${id}`, {
      date: $('tx-date').value, description: $('tx-desc').value,
      category: $('tx-cat').value, type: $('tx-type').value,
      amount: $('tx-amount').value, note: $('tx-note').value,
      payment_type, payment_method_id, update_future,
      update_installments: $('tx-edit-all-installments')?.checked || false,
      competence_month: $('tx-competence')?.value || null
    });
    // Converter para fixo se solicitado
    if ($('tx-convert-fixed')?.checked) {
      await api('POST', `/api/transactions/${id}/make-fixed`);
      closeModal(); toast('🔄 Convertido para lançamento fixo!'); renderTransactions();
      return;
    }
    closeModal(); toast('Atualizado!'); renderTransactions();
  } catch(e) { toast(e.message, 'error'); }
}

async function deleteTransaction(id, groupId, recurringId) {
  let url = `/api/transactions/${id}`;

  // ── Lançamento FIXO ──────────────────────────────────────────
  if (recurringId) {
    const choice = await showChoiceModal(
      '🔄 Cancelar Lançamento Fixo',
      'O que deseja fazer com este lançamento recorrente?',
      [
        { label: '❌ Cancelar o fixo — excluir este e todos os futuros', value: 'all',    bg: '#c62828' },
        { label: '🗑️ Excluir só este mês (manter fixo ativo)',          value: 'one',    bg: '#e65100' },
        { label: '↩️ Não fazer nada',                                    value: 'cancel', bg: '#9e9e9e' },
      ]
    );
    if (!choice || choice === 'cancel') return;
    if (choice === 'all') url += '?all_recurring=1';

  // ── Lançamento PARCELADO ─────────────────────────────────────
  } else if (groupId) {
    const choice = await showChoiceModal(
      '💳 Excluir Parcela',
      'O que deseja excluir?',
      [
        { label: '🗑️ Excluir TODAS as parcelas restantes', value: 'all',    bg: '#c62828' },
        { label: '🗑️ Excluir só esta parcela',             value: 'one',    bg: '#e65100' },
        { label: '↩️ Cancelar',                             value: 'cancel', bg: '#9e9e9e' },
      ]
    );
    if (!choice || choice === 'cancel') return;
    if (choice === 'all') url += '?all_installments=1';

  // ── Lançamento SIMPLES ───────────────────────────────────────
  } else {
    if (!confirm('Remover este lançamento?')) return;
  }

  try {
    await api('DELETE', url);
    toast(recurringId && url.includes('all_recurring') ? '🔄 Fixo cancelado e futuros removidos!' : '🗑️ Removido!');
    renderTransactions();
  } catch(e) { toast(e.message, 'error'); }
}

// Modal de escolha com múltiplos botões
function showChoiceModal(title, message, options) {
  return new Promise(resolve => {
    const btns = options.map(o =>
      `<button class="_choice-btn" data-val="${o.val || o.value}"
         style="width:100%;padding:.8rem 1rem;margin-bottom:.5rem;border:none;border-radius:8px;
                cursor:pointer;font-weight:600;font-size:.9rem;color:#fff;background:${o.bg};
                text-align:left;transition:opacity .15s"
         onmouseover="this.style.opacity='.85'" onmouseout="this.style.opacity='1'">
        ${o.label}
      </button>`
    ).join('');

    $('modal-title').textContent = title;
    $('modal-body').innerHTML = `
      <div style="padding:.75rem 0 .25rem">
        <p style="color:var(--gray-700);margin-bottom:1.25rem;line-height:1.5">${message}</p>
        ${btns}
      </div>`;
    $('modal-overlay').classList.remove('hidden');

    // Bind button clicks
    $('modal-body').querySelectorAll('._choice-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $('modal-overlay').classList.add('hidden');
        resolve(btn.dataset.val);
      });
    });

    // Click outside = cancel
    $('modal-overlay').onclick = (e) => {
      if (e.target === $('modal-overlay')) {
        $('modal-overlay').classList.add('hidden');
        resolve('cancel');
      }
    };
  });
}

// ── Categories ────────────────────────────────────────────────
async function renderCategories() {
  const [limits, summary] = await Promise.all([
    api('GET', '/api/limits'),
    api('GET', `/api/summary?month=${currentMonth}`)
  ]);
  const limMap = {}; limits.forEach(l => limMap[l.category] = l.limit_amount);
  const spentMap = {}; summary.byCategory.forEach(b => spentMap[b.category] = b.total);

  $('main-content').innerHTML = `
    <div class="table-card" style="margin-bottom:1rem">
      <div class="table-header">
        <h3>Limites Mensais por Categoria</h3>
        <span style="font-size:.8rem;color:var(--gray-500)">Edite e pressione Enter ou clique em ✓</span>
      </div>
      ${CATEGORIES.map(cat => {
        const lim = limMap[cat] || 0;
        const spent = spentMap[cat] || 0;
        const pct = lim > 0 ? Math.min(spent / lim, 1) : 0;
        const over = lim > 0 && spent > lim;
        const warn = !over && lim > 0 && spent / lim >= 0.9;
        const barClass = over ? 'progress-red' : warn ? 'progress-orange' : 'progress-green';
        return `
          <div class="limit-row">
            <div class="limit-name">${cat}</div>
            <div class="limit-bar-wrap">
              <div class="limit-meta">
                <span>Gasto: <strong>${fmtBRL(spent)}</strong></span>
                <span>${lim > 0 ? fmtPct(spent/lim) + ' do limite' : 'sem limite'}</span>
              </div>
              <div class="progress-wrap"><div class="progress-bar ${barClass}" style="width:${pct*100}%"></div></div>
            </div>
            <div class="limit-input-wrap">
              <input class="limit-input" type="number" id="lim-${cat}" value="${lim}" min="0" step="10" onkeydown="if(event.key==='Enter')saveLimit('${cat}')">
              <button class="btn-icon" onclick="saveLimit('${cat}')" title="Salvar">✓</button>
            </div>
          </div>`;
      }).join('')}
    </div>`;
}

async function saveLimit(cat) {
  const val = parseFloat($(`lim-${cat}`).value);
  if (isNaN(val) || val < 0) return toast('Valor inválido', 'error');
  try { await api('PUT', '/api/limits', { category: cat, limit_amount: val }); toast(`Limite de ${cat} atualizado!`); }
  catch(e) { toast(e.message, 'error'); }
}

// ── Cards page ────────────────────────────────────────────────
async function renderCards() {
  const [pms, totals] = await Promise.all([
    api('GET', '/api/payment-methods'),
    api('GET', `/api/payment-methods/totals?month=${currentMonth}`)
  ]);
  paymentMethods = pms;

  const typeLabel = { credito: '💳 Cartão de Crédito', debito: '🏧 Cartão de Débito', pix: '⚡ PIX', dinheiro: '💵 Dinheiro' };

  const totalCards = totals.filter(t => t.type === 'credito' || t.type === 'debito');
  const grandTotal = totalCards.reduce((s, t) => s + t.total, 0);

  $('main-content').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;flex-wrap:wrap;gap:.5rem">
      <div>
        <h3 style="font-size:1rem;font-weight:700">Total em cartões — ${monthLabel(currentMonth)}</h3>
        <div style="font-size:1.5rem;font-weight:700;color:var(--red)">${fmtBRL(grandTotal)}</div>
      </div>
      <button class="btn-primary" onclick="openAddCard()">+ Novo Cartão/Conta</button>
    </div>

    ${totalCards.length === 0
      ? `<div class="empty-state card"><div class="empty-icon">💳</div><p>Nenhum cartão cadastrado ainda.</p><br><button class="btn-primary" onclick="openAddCard()">Cadastrar primeiro cartão</button></div>`
      : `<div class="cards-totals-grid">
        ${totals.map(pm => `
          <div class="card-total-card" style="border-top-color:${pm.color}">
            <div class="card-total-actions">
              <button class="btn-icon" onclick="openEditCard(${pm.id})">✏️</button>
              <button class="btn-icon" onclick="deleteCard(${pm.id})">🗑️</button>
            </div>
            <div class="card-total-name">${pm.name}</div>
            <div class="card-total-type">${typeLabel[pm.type]||pm.type}</div>
            <div class="card-total-amount" style="color:${pm.total>0?'var(--red)':'var(--gray-500)'}">${fmtBRL(pm.total)}</div>
            <div class="card-total-count">${pm.count} transaç${pm.count===1?'ão':'ões'} neste mês</div>
            <div id="card-hist-${pm.id}" class="deposit-history hidden"></div>
            <button style="background:none;border:none;color:var(--gray-500);font-size:.8rem;cursor:pointer;margin-top:.5rem" onclick="toggleCardDetails(${pm.id})">📋 Ver lançamentos</button>
          </div>`).join('')}
      </div>`}

    <div class="table-card" style="margin-top:1.5rem">
      <div class="table-header">
        <h3>Gerenciar Formas de Pagamento</h3>
      </div>
      ${pms.length === 0
        ? '<div class="empty-state"><div class="empty-icon">💳</div><p>Nenhuma forma cadastrada</p></div>'
        : `<div class="payment-list" style="padding:1rem">
          ${pms.map(pm => `
            <div class="payment-item">
              <div class="payment-item-left">
                <div class="payment-color-dot" style="background:${pm.color}"></div>
                <div>
                  <div class="payment-name">${pm.name}</div>
                  <div class="payment-type-label">${typeLabel[pm.type]||pm.type}</div>
                </div>
              </div>
              <div style="display:flex;gap:.25rem">
                <button class="btn-icon" onclick="openEditCard(${pm.id})">✏️</button>
                <button class="btn-icon btn-danger" onclick="deleteCard(${pm.id})">🗑️</button>
              </div>
            </div>`).join('')}
        </div>`}
    </div>`;
}

async function toggleCardDetails(id) {
  const el = $(`card-hist-${id}`);
  if (!el) return;
  if (!el.classList.contains('hidden')) { el.classList.add('hidden'); return; }
  const txs = await api('GET', `/api/transactions?month=${currentMonth}&payment_method_id=${id}`);
  el.innerHTML = txs.length === 0
    ? '<p style="color:var(--gray-500);font-size:.85rem;text-align:center;padding:.5rem">Sem lançamentos neste mês</p>'
    : txs.map(t => `
        <div class="deposit-row">
          <span class="dep-date">${fmtDate(t.date)}</span>
          <span class="dep-note">${t.description}</span>
          <span class="dep-amount" style="color:${t.type==='Receita'?'var(--green)':'var(--red)'}">${t.type==='Receita'?'+':'-'}${fmtBRL(t.amount)}</span>
        </div>`).join('');
  el.classList.remove('hidden');
}

function cardFormHTML(pm) {
  const d = pm || { type: 'credito', color: '#1565c8' };
  return `
    <div class="modal-form">
      <div class="field"><label>Nome do Cartão / Conta</label><input type="text" id="card-name" value="${d.name||''}" placeholder="Ex: Bradesco, Mercado Pago"></div>
      <div class="field">
        <label>Tipo</label>
        <select id="card-type">
          <option value="credito" ${d.type==='credito'?'selected':''}>💳 Cartão de Crédito</option>
          <option value="debito"  ${d.type==='debito'?'selected':''}>🏧 Cartão de Débito</option>
        </select>
      </div>
      <div class="field">
        <label>Cor de identificação</label>
        <div style="display:flex;gap:.75rem;align-items:center">
          <input type="color" id="card-color" value="${d.color||'#1565c8'}" style="width:48px;height:40px;border:none;border-radius:8px;cursor:pointer;padding:2px">
          <span style="font-size:.85rem;color:var(--gray-500)">Escolha uma cor para identificar o cartão</span>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="closeModal()">Cancelar</button>
        <button class="btn-primary" onclick="${pm?`saveEditCard(${pm.id})`:'saveNewCard()'}">${pm?'Salvar':'Cadastrar'}</button>
      </div>
    </div>`;
}

function openAddCard() { openModal('Novo Cartão / Conta', cardFormHTML(null)); }

function openEditCard(id) {
  const pm = paymentMethods.find(p => p.id === id);
  if (pm) openModal('Editar ' + pm.name, cardFormHTML(pm));
}

async function saveNewCard() {
  try {
    await api('POST', '/api/payment-methods', { name: $('card-name').value, type: $('card-type').value, color: $('card-color').value });
    paymentMethods = await api('GET', '/api/payment-methods');
    closeModal(); toast('Cartão cadastrado!'); renderCards();
  } catch(e) { toast(e.message, 'error'); }
}

async function saveEditCard(id) {
  try {
    await api('PUT', `/api/payment-methods/${id}`, { name: $('card-name').value, type: $('card-type').value, color: $('card-color').value });
    paymentMethods = await api('GET', '/api/payment-methods');
    closeModal(); toast('Atualizado!'); renderCards();
  } catch(e) { toast(e.message, 'error'); }
}

async function deleteCard(id) {
  if (!confirm('Remover este cartão? Os lançamentos não serão apagados.')) return;
  try {
    await api('DELETE', `/api/payment-methods/${id}`);
    paymentMethods = await api('GET', '/api/payment-methods');
    toast('Removido!');
    const active = document.querySelector('.nav-item.active')?.dataset.page;
    active === 'incomeSources' ? renderIncomeSources() : renderCards();
  } catch(e) { toast(e.message, 'error'); }
}

// ── Savings page ──────────────────────────────────────────────
async function renderIncomeSources() {
  const [pms, totals] = await Promise.all([
    api('GET', '/api/payment-methods'),
    api('GET', `/api/payment-methods/totals?month=${currentMonth}&kind=income`)
  ]);
  paymentMethods = pms;
  const sources = pms.filter(p => p.type === 'receita');
  const total = totals.reduce((s,t)=>s+parseFloat(t.total||0),0);
  $('main-content').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;flex-wrap:wrap;gap:.5rem">
      <div><h3 style="font-size:1rem;font-weight:700">Proventos — ${monthLabel(currentMonth)}</h3><div style="font-size:1.5rem;font-weight:700;color:var(--green)">${fmtBRL(total)}</div></div>
      <button class="btn-primary" onclick="openAddIncomeSource()">+ Nova Fonte</button>
    </div>
    ${sources.length === 0 ? `<div class="empty-state card"><div class="empty-icon">💼</div><p>Nenhuma fonte de receita cadastrada.</p><br><button class="btn-primary" onclick="openAddIncomeSource()">Cadastrar fonte</button></div>` : `<div class="cards-totals-grid">${totals.map(src => `
      <div class="card-total-card" style="border-top-color:${src.color}">
        <div class="card-total-actions"><button class="btn-icon" onclick="openEditIncomeSource(${src.id})">✏️</button><button class="btn-icon" onclick="deleteCard(${src.id})">🗑️</button></div>
        <div class="card-total-name">${src.name}</div><div class="card-total-type">Fonte de receita</div>
        <div class="card-total-amount" style="color:var(--green)">${fmtBRL(src.total)}</div>
        <div class="card-total-count">${src.count} lançamento${src.count===1?'':'s'} neste mês</div>
        <div id="income-hist-${src.id}" class="deposit-history hidden"></div>
        <button style="background:none;border:none;color:var(--gray-500);font-size:.8rem;cursor:pointer;margin-top:.5rem" onclick="toggleIncomeDetails(${src.id})">📋 Ver lançamentos</button>
      </div>`).join('')}</div>`}`;
}

function incomeSourceFormHTML(src) {
  const d = src || { color:'#2e7d32' };
  return `<div class="modal-form">
    <div class="field"><label>Nome da fonte</label><input type="text" id="income-name" value="${d.name||''}" placeholder="Ex: Salário, INSS, Aluguel"></div>
    <div class="field"><label>Cor</label><input type="color" id="income-color" value="${d.color||'#2e7d32'}" style="width:48px;height:40px;border:none;border-radius:8px;cursor:pointer;padding:2px"></div>
    <div class="modal-actions"><button class="btn-secondary" onclick="closeModal()">Cancelar</button><button class="btn-primary" onclick="${src?`saveEditIncomeSource(${src.id})`:'saveNewIncomeSource()'}">${src?'Salvar':'Cadastrar'}</button></div>
  </div>`;
}
function openAddIncomeSource() { openModal('Nova fonte de receita', incomeSourceFormHTML(null)); }
function openEditIncomeSource(id) { const src = paymentMethods.find(p => p.id === id); if (src) openModal('Editar fonte', incomeSourceFormHTML(src)); }
async function saveNewIncomeSource() { try { await api('POST','/api/payment-methods',{name:$('income-name').value,type:'receita',color:$('income-color').value}); closeModal(); toast('Fonte cadastrada!'); renderIncomeSources(); } catch(e) { toast(e.message,'error'); } }
async function saveEditIncomeSource(id) { try { await api('PUT',`/api/payment-methods/${id}`,{name:$('income-name').value,type:'receita',color:$('income-color').value}); closeModal(); toast('Fonte atualizada!'); renderIncomeSources(); } catch(e) { toast(e.message,'error'); } }
async function toggleIncomeDetails(id) {
  const el = $(`income-hist-${id}`); if (!el) return;
  if (!el.classList.contains('hidden')) { el.classList.add('hidden'); return; }
  const txs = await api('GET', `/api/transactions?month=${currentMonth}&payment_method_id=${id}`);
  el.innerHTML = txs.length === 0 ? '<p style="color:var(--gray-500);font-size:.85rem;text-align:center;padding:.5rem">Sem lançamentos neste mês</p>' : txs.map(t => `<div class="deposit-row"><span class="dep-date">${fmtDate(t.date)}</span><span class="dep-note">${t.description}</span><span class="dep-amount">+${fmtBRL(t.amount)}</span></div>`).join('');
  el.classList.remove('hidden');
}

let _historyAllTxs = [];

// ── Cobranças entre usuários ──────────────────────────────────
const chargeStatusLabel = status => ({
  pending:'Pendente', accepted:'Aceita', rejected:'Recusada', cancelled:'Cancelada', processing:'Processando'
}[status] || status);
const chargeStatusBadge = status => ({
  pending:'badge-orange', accepted:'badge-green', rejected:'badge-red', cancelled:'badge-red', processing:'badge-blue'
}[status] || 'badge-blue');

async function renderCharges() {
  $('main-content').innerHTML = '<div class="loading-page"><div class="spinner"></div></div>';
  try {
    const data = await api('GET','/api/charges');
    currentCharges = data;
    $('main-content').innerHTML = `
      <div class="charges-toolbar">
        <div><h3>Cobranças entre usuários</h3><p>Envie cobranças e classifique as que você receber.</p></div>
        <button class="btn-primary" onclick="openNewCharge()">+ Nova cobrança</button>
      </div>
      <div class="charges-grid">
        <div class="table-card">
          <div class="table-header"><h3>Recebidas</h3><span class="badge badge-orange">${data.incoming.filter(c=>c.status==='pending').length} pendentes</span></div>
          <div class="charge-list">${data.incoming.length ? data.incoming.map(incomingChargeHTML).join('') : chargeEmptyHTML('Nenhuma cobrança recebida.')}</div>
        </div>
        <div class="table-card">
          <div class="table-header"><h3>Enviadas</h3></div>
          <div class="charge-list">${data.outgoing.length ? data.outgoing.map(outgoingChargeHTML).join('') : chargeEmptyHTML('Nenhuma cobrança enviada.')}</div>
        </div>
      </div>`;
    updateChargeBadge();
  } catch(e) {
    $('main-content').innerHTML = `<div class="empty-state"><p>${escapeHtml(e.message)}</p></div>`;
  }
}

function chargeEmptyHTML(message) {
  return `<div class="empty-state charge-empty"><div class="empty-icon">💲</div><p>${message}</p></div>`;
}

function incomingChargeHTML(c) {
  return `<div class="charge-item">
    <div class="charge-item-top"><strong>${escapeHtml(c.description)}</strong><span class="badge ${chargeStatusBadge(c.status)}">${chargeStatusLabel(c.status)}</span></div>
    <div class="charge-amount">${fmtBRL(c.amount)}</div>
    <div class="charge-meta">De <strong>${escapeHtml(c.requester_name)}</strong> · ${escapeHtml(c.charge_type)} · vence ${fmtDate(c.due_date)}</div>
    ${c.status==='pending' ? `<div class="charge-actions"><button class="btn-secondary" onclick="rejectCharge(${c.id})">Recusar</button><button class="btn-primary" onclick="openAcceptCharge(${c.id})">Aceitar e classificar</button></div>` : ''}
  </div>`;
}

function outgoingChargeHTML(c) {
  return `<div class="charge-item">
    <div class="charge-item-top"><strong>${escapeHtml(c.description)}</strong><span class="badge ${chargeStatusBadge(c.status)}">${chargeStatusLabel(c.status)}</span></div>
    <div class="charge-amount">${fmtBRL(c.amount)}</div>
    <div class="charge-meta">Para <strong>${escapeHtml(c.recipient_name)}</strong> · ${escapeHtml(c.charge_type)} · vence ${fmtDate(c.due_date)}</div>
    ${c.status!=='cancelled' ? `<div class="charge-actions"><button class="btn-danger" onclick="cancelCharge(${c.id},'${c.status}')">Cancelar cobrança</button></div>` : ''}
  </div>`;
}

async function openNewCharge() {
  try {
    const users = await api('GET','/api/charge-users');
    openModal('Nova cobrança', `<div class="modal-form">
      <div class="field"><label>Cobrar de</label><select id="charge-recipient"><option value="">Selecione o usuário</option>${users.map(u=>`<option value="${u.id}">${escapeHtml(u.name)} · ${escapeHtml(u.email)}</option>`).join('')}</select></div>
      <div class="field"><label>Descrição da cobrança</label><input id="charge-description" maxlength="120" placeholder="Ex.: Parte do supermercado"></div>
      <div class="field"><label>Tipo da cobrança</label><input id="charge-type" maxlength="80" placeholder="Ex.: Divisão de conta, empréstimo, mensalidade"></div>
      <div class="row"><div class="field"><label>Valor (R$)</label><input id="charge-amount" type="number" min=".01" step=".01"></div><div class="field"><label>Vencimento</label><input id="charge-due-date" type="date" value="${new Date().toISOString().slice(0,10)}"></div></div>
      <div class="modal-actions"><button class="btn-secondary" onclick="closeModal()">Cancelar</button><button class="btn-primary" onclick="createCharge()">Enviar cobrança</button></div>
    </div>`);
  } catch(e) { toast(e.message,'error'); }
}

async function createCharge() {
  try {
    await api('POST','/api/charges',{recipient_id:$('charge-recipient').value,description:$('charge-description').value,charge_type:$('charge-type').value,amount:$('charge-amount').value,due_date:$('charge-due-date').value});
    closeModal(); toast('Cobrança enviada!'); renderCharges();
  } catch(e) { toast(e.message,'error'); }
}

function openAcceptCharge(id) {
  const charge = currentCharges.incoming.find(c=>c.id===id);
  if (!charge) return toast('Cobrança não encontrada','error');
  const {description,due_date:dueDate,amount} = charge;
  const cards = paymentMethods.filter(p=>p.type==='credito'||p.type==='debito');
  openModal('Aceitar e classificar cobrança', `<div class="modal-form">
    <div class="charge-accept-summary"><strong>${description}</strong><span>${fmtBRL(amount)}</span></div>
    <div class="field"><label>Categoria da despesa</label><select id="charge-category">${CATEGORIES.map(c=>`<option value="${c}" ${c==='Outros'?'selected':''}>${c}</option>`).join('')}</select></div>
    <div class="row"><div class="field"><label>Data da despesa</label><input id="charge-date" type="date" value="${dueDate}"></div><div class="field"><label>Competência</label><input id="charge-competence" type="month" value="${dueDate.slice(0,7)}"></div></div>
    <div class="field"><label>Forma de pagamento</label><select id="charge-payment"><option value="dinheiro">💵 Dinheiro</option><option value="pix">⚡ PIX</option>${cards.map(p=>`<option value="card-${p.id}">${p.type==='credito'?'💳':'🏧'} ${escapeHtml(p.name)}</option>`).join('')}<option value="debito">🏧 Débito (outro)</option></select></div>
    <div class="modal-actions"><button class="btn-secondary" onclick="closeModal()">Cancelar</button><button class="btn-primary" onclick="acceptCharge(${id})">Aceitar cobrança</button></div>
  </div>`);
}

async function acceptCharge(id) {
  const payment = parsePtypeValue($('charge-payment').value);
  try {
    await api('POST',`/api/charges/${id}/accept`,{category:$('charge-category').value,date:$('charge-date').value,competence_month:$('charge-competence').value,...payment});
    closeModal(); toast('Cobrança aceita e lançamentos criados!'); loadSidebarPanels(); renderCharges();
  } catch(e) { toast(e.message,'error'); }
}

async function rejectCharge(id) {
  try { await api('PATCH',`/api/charges/${id}/reject`,{}); toast('Cobrança recusada.'); renderCharges(); }
  catch(e) { toast(e.message,'error'); }
}

async function cancelCharge(id,status) {
  const message = status==='accepted'
    ? 'Cancelar esta cobrança? A despesa e a receita criadas no aceite também serão removidas.'
    : 'Cancelar esta cobrança para o outro usuário?';
  if (!confirm(message)) return;
  try {
    await api('PATCH',`/api/charges/${id}/cancel`,{});
    toast('Cobrança cancelada!');
    loadSidebarPanels();
    renderCharges();
  } catch(e) { toast(e.message,'error'); }
}

async function updateChargeBadge() {
  try {
    const data = await api('GET','/api/charges/pending-count');
    const badge = $('charge-badge');
    if (!badge) return;
    badge.textContent = data.total;
    badge.classList.toggle('hidden', !data.total);
  } catch { /* silencioso */ }
}

function startChargePolling() {
  if (chargePollInterval) return;
  updateChargeBadge();
  chargePollInterval = setInterval(updateChargeBadge,60000);
}

// ── Lista de mercado ─────────────────────────────────────────
async function renderShoppingList() {
  activeShoppingOwnerId = activeShoppingOwnerId || currentUser.id;
  $('main-content').innerHTML = `
    <div class="shopping-card">
      <div class="shopping-intro">
        <div>
          <h3 id="shopping-list-title">Lista de ${monthLabel(currentMonth)}</h3>
          <p>Adicione tudo o que precisar comprar neste mês.</p>
        </div>
        <div class="shopping-heading-actions">
          <select id="shopping-owner-select" class="shopping-owner-select" onchange="changeShoppingList(this.value)"></select>
          <button id="shopping-share-btn" class="btn-secondary" onclick="openShoppingShareManager()">Compartilhar</button>
          <div id="shopping-progress" class="shopping-progress">0 de 0 comprados</div>
        </div>
      </div>
      <form class="shopping-add-form" onsubmit="addShoppingItem(event)">
        <input id="shopping-name" type="text" placeholder="Ex.: Arroz, café, detergente..." maxlength="120" required>
        <input id="shopping-quantity" type="text" placeholder="Quantidade (opcional)" maxlength="40">
        <button class="btn-primary" type="submit">+ Adicionar</button>
      </form>
      <div id="shopping-list" class="shopping-list">
        <div class="loading-page"><div class="spinner"></div></div>
      </div>
      <div id="shopping-footer" class="shopping-footer hidden">
        <button class="btn-secondary" onclick="clearPurchasedShoppingItems()">Limpar comprados</button>
      </div>
    </div>`;

  try {
    shoppingLists = await api('GET', '/api/shopping-lists');
    if (!shoppingLists.some(list => Number(list.id) === Number(activeShoppingOwnerId))) activeShoppingOwnerId = currentUser.id;
    renderShoppingListSelector();
    await loadShoppingItems();
    $('shopping-name')?.focus();
  } catch(e) {
    $('shopping-list').innerHTML = `<div class="empty-state"><p>${escapeHtml(e.message)}</p></div>`;
  }
}

function renderShoppingListSelector() {
  const select = $('shopping-owner-select');
  if (!select) return;
  select.innerHTML = shoppingLists.map(list =>
    `<option value="${list.id}" ${Number(list.id) === Number(activeShoppingOwnerId) ? 'selected' : ''}>${list.is_owner ? 'Minha lista' : `Lista de ${escapeHtml(list.name)}`}</option>`
  ).join('');
  const active = shoppingLists.find(list => Number(list.id) === Number(activeShoppingOwnerId));
  $('shopping-list-title').textContent = `${active?.is_owner ? 'Minha lista' : `Lista de ${active?.name || ''}`} · ${monthLabel(currentMonth)}`;
  $('shopping-share-btn').classList.toggle('hidden', Number(activeShoppingOwnerId) !== Number(currentUser.id));
}

async function changeShoppingList(ownerId) {
  activeShoppingOwnerId = Number(ownerId);
  renderShoppingListSelector();
  await loadShoppingItems();
}

async function loadShoppingItems() {
  $('shopping-list').innerHTML = '<div class="loading-page"><div class="spinner"></div></div>';
  shoppingItems = await api('GET', `/api/shopping-items?month=${currentMonth}&owner_id=${activeShoppingOwnerId}`);
  renderShoppingItems();
}

function renderShoppingItems() {
  const list = $('shopping-list');
  if (!list) return;
  const purchased = shoppingItems.filter(item => item.purchased).length;
  $('shopping-progress').textContent = `${purchased} de ${shoppingItems.length} comprados`;
  $('shopping-footer').classList.toggle('hidden', purchased === 0);

  if (!shoppingItems.length) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">🛒</div><p>Sua lista deste mês está vazia.</p><p class="shopping-empty-hint">Adicione o primeiro item acima.</p></div>';
    return;
  }

  list.innerHTML = shoppingItems.map(item => `
    <div class="shopping-item${item.purchased ? ' purchased' : ''}">
      <label class="shopping-check">
        <input type="checkbox" ${item.purchased ? 'checked' : ''} onchange="toggleShoppingItem(${item.id}, this.checked)">
        <span></span>
      </label>
      <div class="shopping-item-info">
        <strong>${escapeHtml(item.name)}</strong>
        ${item.quantity ? `<small>${escapeHtml(item.quantity)}</small>` : ''}
      </div>
      <button class="btn-icon shopping-delete" onclick="deleteShoppingItem(${item.id})" title="Remover item">🗑️</button>
    </div>`).join('');
}

async function addShoppingItem(e) {
  e.preventDefault();
  const name = $('shopping-name').value.trim();
  const quantity = $('shopping-quantity').value.trim();
  if (!name) return;
  const button = e.target.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    const item = await api('POST', '/api/shopping-items', { month: currentMonth, owner_id: activeShoppingOwnerId, name, quantity });
    shoppingItems.push(item);
    renderShoppingItems();
    e.target.reset();
    $('shopping-name').focus();
  } catch(err) {
    toast(err.message || 'Erro ao adicionar item', 'error');
  } finally {
    button.disabled = false;
  }
}

async function toggleShoppingItem(id, purchased) {
  try {
    await api('PATCH', `/api/shopping-items/${id}`, { purchased });
    shoppingItems = shoppingItems.map(item => item.id === id ? { ...item, purchased: purchased ? 1 : 0 } : item);
    renderShoppingItems();
  } catch(err) {
    toast(err.message || 'Erro ao atualizar item', 'error');
    renderShoppingItems();
  }
}

async function deleteShoppingItem(id) {
  try {
    await api('DELETE', `/api/shopping-items/${id}`);
    shoppingItems = shoppingItems.filter(item => item.id !== id);
    renderShoppingItems();
  } catch(err) { toast(err.message || 'Erro ao remover item', 'error'); }
}

async function clearPurchasedShoppingItems() {
  try {
    await api('DELETE', `/api/shopping-items/completed?month=${currentMonth}&owner_id=${activeShoppingOwnerId}`);
    shoppingItems = shoppingItems.filter(item => !item.purchased);
    renderShoppingItems();
    toast('Itens comprados removidos!');
  } catch(err) { toast(err.message || 'Erro ao limpar itens', 'error'); }
}

async function openShoppingShareManager() {
  if (Number(activeShoppingOwnerId) !== Number(currentUser.id)) return;
  try {
    const users = await api('GET', '/api/shopping-share-candidates');
    openModal('Compartilhar lista de mercado', `
      <div class="modal-form">
        <p class="shopping-share-help">Escolha quem poderá adicionar, marcar e remover itens da sua lista em todos os meses.</p>
        <div class="shopping-share-list">
          ${users.length ? users.map(user => `
            <label class="shopping-share-user">
              <span><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(user.email)}</small></span>
              <input type="checkbox" ${user.shared ? 'checked' : ''} onchange="toggleShoppingShare(${user.id}, this.checked)">
            </label>`).join('') : '<p class="text-gray">Nenhum outro usuário cadastrado.</p>'}
        </div>
        <div class="modal-actions"><button class="btn-primary" onclick="closeModal()">Concluir</button></div>
      </div>`);
  } catch(e) { toast(e.message, 'error'); }
}

async function toggleShoppingShare(userId, shared) {
  try {
    await api('PUT', `/api/shopping-shares/${userId}`, { shared });
    toast(shared ? 'Lista compartilhada!' : 'Acesso removido!');
  } catch(e) {
    toast(e.message, 'error');
    openShoppingShareManager();
  }
}

async function renderHistory() {
  _historyPage = 1;
  _historyAllTxs = await api('GET', '/api/transactions');
  _historyAllTxs = [..._historyAllTxs].reverse(); // mais recentes primeiro

  $('main-content').innerHTML = `<div class="table-card" id="history-table-card">
    <div class="table-header">
      <h3>Histórico geral por data do lançamento</h3>
      <span id="history-page-info" style="font-size:.85rem;color:var(--gray-500)"></span>
    </div>
    <div id="history-table-wrap"></div>
  </div>`;

  renderHistoryTable();
}

function renderHistoryTable() {
  const total = _historyAllTxs.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (_historyPage > totalPages) _historyPage = totalPages;
  const txs = _historyAllTxs.slice((_historyPage - 1) * PAGE_SIZE, _historyPage * PAGE_SIZE);

  const info = $('history-page-info');
  if (info) info.textContent = `Página ${_historyPage} de ${totalPages} · ${total} registros`;

  const wrap = $('history-table-wrap');
  if (!wrap) return;

  if (total === 0) {
    wrap.innerHTML = '<div class="empty-state"><div class="empty-icon">🧾</div><p>Sem lançamentos</p></div>';
    return;
  }

  wrap.innerHTML = `
    <div style="overflow-x:auto"><table>
      <thead><tr><th>Data</th><th>Competência</th><th>Descrição</th><th>Categoria</th><th>Pagamento/Fonte</th><th>Tipo</th><th style="text-align:right">Valor</th><th></th></tr></thead>
      <tbody>
        ${txs.map(t => `<tr>
          <td style="white-space:nowrap">${fmtDate(t.date)}</td>
          <td>${monthLabel(t.effective_month || t.competence_month || t.date.slice(0,7))}</td>
          <td>${t.description}${t.installments>1?` <span class="inst-badge">${t.installment_number}/${t.installments}</span>`:''}${t.recurring_template_id?` <span class="fixed-badge">🔄 fixo</span>`:''}</td>
          <td><span class="badge badge-blue">${t.category}</span></td>
          <td>${pmBadgeHTML(t)}</td>
          <td><span class="badge ${t.type==='Receita'?'badge-green':'badge-red'}">${t.type}</span></td>
          <td style="text-align:right;font-weight:700;color:${t.type==='Receita'?'var(--green)':'var(--red)'}">${fmtBRL(t.amount)}</td>
          <td style="white-space:nowrap">
            <button class="btn-icon" onclick="openEditTransaction(${t.id})">✏️</button>
            <button class="btn-icon" onclick="deleteTransaction(${t.id},'${t.group_id||''}','${t.recurring_template_id||''}')">🗑️</button>
          </td>
        </tr>`).join('')}
      </tbody>
    </table></div>
    ${totalPages > 1 ? `<div class="pagination">
      <button onclick="changeHistoryPage(-1)" ${_historyPage<=1?'disabled':''}>‹ Anterior</button>
      <span class="page-info">Página ${_historyPage} de ${totalPages}</span>
      <button onclick="changeHistoryPage(1)" ${_historyPage>=totalPages?'disabled':''}>Próxima ›</button>
    </div>` : ''}
  `;
}

async function renderUsers() {
  const users = await api('GET','/api/users');
  $('main-content').innerHTML = `<div style="display:flex;justify-content:flex-end;margin-bottom:1rem"><button class="btn-primary" onclick="openAddUser()">+ Novo Usuário</button></div><div class="table-card"><div class="table-header"><h3>Gerenciador de usuários</h3></div><div style="overflow-x:auto"><table><thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Status</th><th></th></tr></thead><tbody>${users.map(u => `<tr><td><strong>${u.name}</strong></td><td>${u.email}</td><td>${u.is_admin?'Administrador':'Usuário'}</td><td>${!u.is_active?'<span class="badge badge-red">inativo</span>':u.must_change_password?'<span class="badge badge-orange">senha temporária</span>':'<span class="badge badge-green">ativo</span>'}</td><td style="white-space:nowrap"><button class="btn-secondary" onclick="resetUserPassword(${u.id})">Senha temporária</button>${u.id===currentUser.id?'':` <button class="btn-secondary" onclick="toggleUserAdmin(${u.id},${u.is_admin?0:1})">${u.is_admin?'Remover admin':'Tornar admin'}</button> <button class="${u.is_active?'btn-danger':'btn-secondary'}" onclick="toggleUserActive(${u.id},${u.is_active?0:1})">${u.is_active?'Inativar':'Reativar'}</button>`}</td></tr>`).join('')}</tbody></table></div></div>`;
}
function openAddUser() { openModal('Novo usuário', `<div class="modal-form"><div class="field"><label>Nome</label><input type="text" id="new-user-name"></div><div class="field"><label>E-mail</label><input type="email" id="new-user-email"></div><div class="fixed-check-row"><input type="checkbox" id="new-user-admin"><label for="new-user-admin">Administrador</label></div><div class="modal-actions"><button class="btn-secondary" onclick="closeModal()">Cancelar</button><button class="btn-primary" onclick="saveNewUser()">Criar com senha temporária</button></div></div>`); }
async function saveNewUser() { try { const r = await api('POST','/api/users',{name:$('new-user-name').value,email:$('new-user-email').value,is_admin:$('new-user-admin').checked}); closeModal(); openModal('Senha temporária criada', `<div class="modal-form"><p>Informe esta senha ao usuário:</p><div class="temp-password">${r.temp_password}</div><div class="modal-actions"><button class="btn-primary" onclick="closeModal();renderUsers()">OK</button></div></div>`); } catch(e) { toast(e.message,'error'); } }
async function resetUserPassword(id) { try { const r = await api('PUT',`/api/users/${id}/temp-password`,{}); openModal('Nova senha temporária', `<div class="modal-form"><p>Informe esta senha ao usuário:</p><div class="temp-password">${r.temp_password}</div><div class="modal-actions"><button class="btn-primary" onclick="closeModal();renderUsers()">OK</button></div></div>`); } catch(e) { toast(e.message,'error'); } }
async function toggleUserAdmin(id,is_admin) { try { await api('PUT',`/api/users/${id}/admin`,{is_admin}); toast('Perfil atualizado!'); renderUsers(); } catch(e) { toast(e.message,'error'); } }
async function toggleUserActive(id,is_active) { try { await api('PUT',`/api/users/${id}/active`,{is_active}); toast(is_active?'Usuário reativado!':'Usuário inativado!'); renderUsers(); } catch(e) { toast(e.message,'error'); } }

async function renderSavings() {
  savingsAccounts = await api('GET', '/api/savings');
  const grandTotal = savingsAccounts.reduce((s, a) => s + a.balance, 0);

  $('main-content').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;flex-wrap:wrap;gap:.5rem">
      <div>
        <h3 style="font-size:1rem;font-weight:700">Total acumulado em cofrinhos</h3>
        <div style="font-size:1.6rem;font-weight:700;color:var(--green)">${fmtBRL(grandTotal)}</div>
      </div>
      <button class="btn-primary" onclick="openAddSavings()">+ Novo Cofrinho</button>
    </div>

    ${savingsAccounts.length === 0
      ? `<div class="empty-state card"><div class="empty-icon">🏦</div><p>Nenhum cofrinho criado ainda.</p><br><button class="btn-primary" onclick="openAddSavings()">Criar primeiro cofrinho</button></div>`
      : `<div class="savings-grid">${savingsAccounts.map(a => savingsCard(a)).join('')}</div>`}
  `;
}

function savingsCard(a) {
  const pct = a.balance > 0 ? 100 : 0;
  return `
    <div class="savings-card" style="border-top-color:${a.color}">
      <div class="savings-card-top">
        <div>
          <div class="savings-name">${a.name}</div>
          <div class="savings-desc">${a.description || ''}</div>
        </div>
        <div class="savings-actions">
          <button class="btn-icon" onclick="openEditSavings(${a.id})">✏️</button>
          <button class="btn-icon" onclick="deleteSavings(${a.id})">🗑️</button>
        </div>
      </div>
      <div class="savings-balance" style="color:${a.color}">${fmtBRL(a.balance)}</div>
      <div class="savings-last">${a.last_deposit ? `Último depósito: ${fmtBRL(a.last_deposit.amount)} em ${fmtDate(a.last_deposit.date)}` : 'Nenhum depósito ainda'}</div>
      <button class="btn-deposit" onclick="openDeposit(${a.id},'${a.name}')">💰 Guardar dinheiro</button>
      <div id="hist-${a.id}" class="deposit-history hidden"></div>
      <button style="background:none;border:none;color:var(--gray-500);font-size:.8rem;cursor:pointer;margin-top:.5rem" onclick="toggleHistory(${a.id})">📋 Ver histórico</button>
    </div>`;
}

async function toggleHistory(id) {
  const el = $(`hist-${id}`);
  if (!el.classList.contains('hidden')) { el.classList.add('hidden'); return; }
  const deps = await api('GET', `/api/savings/${id}/deposits`);
  el.innerHTML = deps.length === 0
    ? '<p style="color:var(--gray-500);font-size:.85rem;text-align:center;padding:.5rem">Sem depósitos</p>'
    : deps.map(d => `
        <div class="deposit-row">
          <span class="dep-date">${fmtDate(d.date)}</span>
          <span class="dep-note">${d.note||'—'}</span>
          <span class="dep-amount">+${fmtBRL(d.amount)}</span>
          <button class="btn-icon" style="font-size:.85rem" onclick="deleteDeposit(${d.id},${id})">🗑️</button>
        </div>`).join('');
  el.classList.remove('hidden');
}

async function deleteDeposit(depId, accId) {
  if (!confirm('Remover este depósito?')) return;
  try { await api('DELETE', `/api/savings/deposits/${depId}`); toast('Removido!'); renderSavings(); }
  catch(e) { toast(e.message, 'error'); }
}

function savingsFormHTML(a) {
  const d = a || { color: '#1b5e20' };
  return `
    <div class="modal-form">
      <div class="field"><label>Nome do Cofrinho</label><input type="text" id="sav-name" value="${d.name||''}" placeholder="Ex: Previdência, Reserva de Emergência"></div>
      <div class="field"><label>Descrição (opcional)</label><input type="text" id="sav-desc" value="${d.description||''}" placeholder="Ex: Para a aposentadoria"></div>
      <div class="field">
        <label>Cor</label>
        <div style="display:flex;gap:.75rem;align-items:center">
          <input type="color" id="sav-color" value="${d.color||'#1b5e20'}" style="width:48px;height:40px;border:none;border-radius:8px;cursor:pointer;padding:2px">
          <span style="font-size:.85rem;color:var(--gray-500)">Cor de identificação do cofrinho</span>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="closeModal()">Cancelar</button>
        <button class="btn-primary" onclick="${a?`saveEditSavings(${a.id})`:'saveNewSavings()'}">${a?'Salvar':'Criar Cofrinho'}</button>
      </div>
    </div>`;
}

function openAddSavings() { openModal('Novo Cofrinho', savingsFormHTML(null)); }
function openEditSavings(id) {
  const a = savingsAccounts.find(x => x.id === id);
  if (a) openModal('Editar ' + a.name, savingsFormHTML(a));
}
async function saveNewSavings() {
  try {
    await api('POST', '/api/savings', { name: $('sav-name').value, description: $('sav-desc').value, color: $('sav-color').value });
    savingsAccounts = await api('GET', '/api/savings');
    closeModal(); toast('Cofrinho criado!'); renderSavings();
  } catch(e) { toast(e.message, 'error'); }
}
async function saveEditSavings(id) {
  try {
    await api('PUT', `/api/savings/${id}`, { name: $('sav-name').value, description: $('sav-desc').value, color: $('sav-color').value });
    savingsAccounts = await api('GET', '/api/savings');
    closeModal(); toast('Atualizado!'); renderSavings();
  } catch(e) { toast(e.message, 'error'); }
}
async function deleteSavings(id) {
  if (!confirm('Remover este cofrinho e todos os seus depósitos?')) return;
  try {
    await api('DELETE', `/api/savings/${id}`);
    savingsAccounts = await api('GET', '/api/savings');
    toast('Cofrinho removido!'); renderSavings();
  } catch(e) { toast(e.message, 'error'); }
}

function openDeposit(accId, accName) {
  openModal(`💰 Guardar em: ${accName}`, `
    <div class="modal-form">
      <div class="row">
        <div class="field"><label>Valor (R$)</label><input type="number" id="dep-amount" step="0.01" min="0.01" placeholder="0,00"></div>
        <div class="field"><label>Data</label><input type="date" id="dep-date" value="${new Date().toISOString().slice(0,10)}"></div>
      </div>
      <div class="field"><label>Observação (opcional)</label><input type="text" id="dep-note" placeholder="Ex: Depósito mensal"></div>
      <div class="fixed-check-row" style="margin-top:.25rem">
        <input type="checkbox" id="dep-create-tx" checked>
        <label for="dep-create-tx">Registrar também como despesa nos lançamentos</label>
      </div>
      <div class="field" id="dep-cat-field">
        <label>Categoria da despesa</label>
        <select id="dep-cat">
          ${CATEGORIES.map(c=>`<option value="${c}" ${c==='Outros'?'selected':''}>${c}</option>`).join('')}
        </select>
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="closeModal()">Cancelar</button>
        <button class="btn-primary" onclick="saveDeposit(${accId})">Guardar</button>
      </div>
    </div>`);
  $('dep-create-tx').addEventListener('change', () => {
    $('dep-cat-field').classList.toggle('hidden', !$('dep-create-tx').checked);
  });
}

async function saveDeposit(accId) {
  try {
    const createTx = $('dep-create-tx')?.checked;
    await api('POST', `/api/savings/${accId}/deposits`, {
      amount: $('dep-amount').value,
      date: $('dep-date').value,
      note: $('dep-note').value,
      create_transaction: createTx,
      category: $('dep-cat')?.value || 'Outros'
    });
    savingsAccounts = await api('GET', '/api/savings');
    closeModal();
    toast('💰 Dinheiro guardado!');
    renderSavings();
  } catch(e) { toast(e.message, 'error'); }
}

// Also expose openDeposit globally for the transactions page button
window.openDepositFromTransactions = async function() {
  savingsAccounts = await api('GET', '/api/savings').catch(() => []);
  if (savingsAccounts.length === 0) { toast('Crie um cofrinho primeiro!', 'error'); navigate('savings'); return; }
  const opts = savingsAccounts.map(a => `<option value="${a.id}">${a.name} (${fmtBRL(a.balance)})</option>`).join('');
  openModal('💰 Guardar Dinheiro', `
    <div class="modal-form">
      <div class="field"><label>Cofrinho</label><select id="dep-acc">${opts}</select></div>
      <div class="row">
        <div class="field"><label>Valor (R$)</label><input type="number" id="dep-amount" step="0.01" min="0.01" placeholder="0,00"></div>
        <div class="field"><label>Data</label><input type="date" id="dep-date" value="${new Date().toISOString().slice(0,10)}"></div>
      </div>
      <div class="field"><label>Observação</label><input type="text" id="dep-note" placeholder="Ex: Salário do mês"></div>
      <div class="fixed-check-row">
        <input type="checkbox" id="dep-create-tx" checked>
        <label for="dep-create-tx">Registrar também como despesa</label>
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="closeModal()">Cancelar</button>
        <button class="btn-primary" onclick="saveDeposit(document.getElementById('dep-acc').value)">Guardar</button>
      </div>
    </div>`);
};

// ── Goals ─────────────────────────────────────────────────────
let _allGoals = [];
async function renderGoals() {
  _allGoals = await api('GET', '/api/goals');
  const goals = _allGoals;

  const cards = goals.length === 0
    ? '<div class="empty-state"><div class="empty-icon">🎯</div><p>Nenhuma meta criada ainda.</p><br><button class="btn-primary" onclick="openAddGoal()">Criar primeira meta</button></div>'
    : `<div class="goals-grid">${goals.map(g => goalCard(g)).join('')}</div>`;

  $('main-content').innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:1rem">
      <button class="btn-primary" onclick="openAddGoal()">+ Nova Meta</button>
    </div>
    ${cards}`;
}

function goalCard(g) {
  const pct = g.target_amount > 0 ? Math.min(g.saved_amount / g.target_amount, 1) : 0;
  const barClass = pct >= 1 ? 'progress-green' : pct >= 0.5 ? 'progress-green' : 'progress-orange';
  const falta = Math.max(g.target_amount - g.saved_amount, 0);
  return `
    <div class="goal-card">
      <div class="goal-actions">
        <button class="btn-icon" onclick="openEditGoal(${g.id})">✏️</button>
        <button class="btn-icon" onclick="deleteGoal(${g.id})">🗑️</button>
      </div>
      <div class="goal-name">${g.name}</div>
      <div class="goal-desc">${g.description||''}</div>
      <div class="goal-amounts">
        <span>Guardado: <strong class="text-green">${fmtBRL(g.saved_amount)}</strong></span>
        <span>Meta: <strong>${fmtBRL(g.target_amount)}</strong></span>
      </div>
      <div class="progress-wrap" style="margin-bottom:.4rem">
        <div class="progress-bar ${barClass}" style="width:${pct*100}%"></div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:.8rem;color:var(--gray-500)">Falta: ${fmtBRL(falta)}</span>
        <span class="goal-pct">${fmtPct(pct)}</span>
      </div>
      ${g.deadline ? `<div class="goal-deadline">📅 Prazo: ${fmtDate(g.deadline)}</div>` : ''}
    </div>`;
}

function goalFormHTML(g) {
  const d = g || {};
  return `
    <div class="modal-form">
      <div class="field"><label>Nome da Meta</label><input type="text" id="g-name" value="${d.name||''}" placeholder="Ex: Viagem Europa"></div>
      <div class="field"><label>Descrição</label><input type="text" id="g-desc" value="${d.description||''}" placeholder="Opcional"></div>
      <div class="row">
        <div class="field"><label>Valor Alvo (R$)</label><input type="number" id="g-target" step="0.01" min="1" value="${d.target_amount||''}" placeholder="0,00"></div>
        <div class="field"><label>Já Guardado (R$)</label><input type="number" id="g-saved" step="0.01" min="0" value="${d.saved_amount||0}" placeholder="0,00"></div>
      </div>
      <div class="field"><label>Prazo (opcional)</label><input type="date" id="g-deadline" value="${d.deadline||''}"></div>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="closeModal()">Cancelar</button>
        <button class="btn-primary" onclick="${g?`saveEditGoal(${g.id})`:'saveNewGoal()'}">${g?'Salvar':'Criar Meta'}</button>
      </div>
    </div>`;
}

function openAddGoal() { openModal('Nova Meta', goalFormHTML(null)); }

async function openEditGoal(id) {
  const g = _allGoals.find(x => x.id === id) || (await api('GET', '/api/goals')).find(x => x.id === id);
  if (g) openModal('Editar Meta', goalFormHTML(g));
}

async function saveNewGoal() {
  try {
    await api('POST', '/api/goals', { name: $('g-name').value, description: $('g-desc').value, target_amount: $('g-target').value, saved_amount: $('g-saved').value, deadline: $('g-deadline').value||null });
    closeModal(); toast('Meta criada!'); renderGoals();
  } catch(e) { toast(e.message, 'error'); }
}

async function saveEditGoal(id) {
  try {
    await api('PUT', `/api/goals/${id}`, { name: $('g-name').value, description: $('g-desc').value, target_amount: $('g-target').value, saved_amount: $('g-saved').value, deadline: $('g-deadline').value||null });
    closeModal(); toast('Meta atualizada!'); renderGoals();
  } catch(e) { toast(e.message, 'error'); }
}

async function deleteGoal(id) {
  if (!confirm('Remover esta meta?')) return;
  try { await api('DELETE', `/api/goals/${id}`); toast('Meta removida!'); renderGoals(); }
  catch(e) { toast(e.message, 'error'); }
}

// ── Report ────────────────────────────────────────────────────
async function renderReport() {
  const data = await api('GET', `/api/summary?month=${currentMonth}`);
  const txs  = await api('GET', `/api/transactions?month=${currentMonth}`);
  const savingRate = data.income > 0 ? (data.balance / data.income) : 0;
  const limMap = {}; (data.limits||[]).forEach(l => limMap[l.category] = l.limit_amount);

  $('main-content').innerHTML = `
    <div class="report-actions">
      <button class="btn-primary btn-excel" onclick="exportExcel()">
        📊 Exportar Excel
      </button>
    </div>
    <div class="report-summary">
      <div class="card green-border"><div class="card-label">Receita</div><div class="card-value text-green">${fmtBRL(data.income)}</div></div>
      <div class="card red-border"><div class="card-label">Despesas</div><div class="card-value text-red">${fmtBRL(data.expense)}</div></div>
      <div class="card ${data.balance>=0?'green-border':'red-border'}"><div class="card-label">Saldo / Economia</div><div class="card-value ${data.balance>=0?'text-green':'text-red'}">${fmtBRL(data.balance)}</div></div>
    </div>

    <div class="table-card" style="margin-bottom:1rem">
      <div class="table-header"><h3>Análise por Categoria</h3></div>
      <div style="overflow-x:auto">
      <table>
        <thead><tr><th>Categoria</th><th>Limite</th><th>Gasto</th><th>% Gasto/Limite</th><th>Saldo Cat.</th><th>Status</th></tr></thead>
        <tbody>
          ${CATEGORIES.map(cat => {
            const lim = limMap[cat] || 0;
            const spent = data.byCategory.find(b=>b.category===cat)?.total || 0;
            const saldo = lim - spent;
            const pct = lim > 0 ? spent/lim : 0;
            const over = lim > 0 && spent > lim;
            const warn = !over && pct >= 0.9;
            const badge = over ? '<span class="badge badge-red">🚨 Excedido</span>' : warn ? '<span class="badge badge-orange">⚠️ Atenção</span>' : spent===0 ? '<span class="badge" style="background:var(--gray-100);color:var(--gray-500)">Sem gastos</span>' : '<span class="badge badge-green">✅ OK</span>';
            return `<tr>
              <td><strong>${cat}</strong></td>
              <td>${fmtBRL(lim)}</td>
              <td style="color:${spent>0?'var(--red)':'var(--gray-500)'}">${fmtBRL(spent)}</td>
              <td>${lim>0?fmtPct(pct):'—'}</td>
              <td style="color:${saldo>=0?'var(--green)':'var(--red)'}">${fmtBRL(saldo)}</td>
              <td>${badge}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      </div>
    </div>

    <div class="chart-card" style="margin-bottom:1rem">
      <h3>Distribuição de Gastos</h3>
      <div style="max-width:480px;margin:0 auto;height:280px"><canvas id="chart-report-pie"></canvas></div>
    </div>

    <div class="table-card">
      <div class="table-header"><h3>Todos os Lançamentos do Mês</h3><span style="font-size:.85rem;color:var(--gray-500)">${txs.length} registros</span></div>
      ${txs.length===0?'<div class="empty-state"><div class="empty-icon">📋</div><p>Sem lançamentos</p></div>':`
      <div style="overflow-x:auto"><table>
        <thead><tr><th>Data</th><th>Descrição</th><th>Categoria</th><th>Tipo</th><th style="text-align:right">Valor</th></tr></thead>
        <tbody>${txs.map(t=>`<tr>
          <td>${fmtDate(t.date)}</td>
          <td>${t.description}</td>
          <td><span class="badge badge-blue">${t.category}</span></td>
          <td><span class="badge ${t.type==='Receita'?'badge-green':'badge-red'}">${t.type}</span></td>
          <td style="text-align:right;font-weight:700;color:${t.type==='Receita'?'var(--green)':'var(--red)'}">${fmtBRL(t.amount)}</td>
        </tr>`).join('')}</tbody>
      </table></div>`}
    </div>`;

  if (data.byCategory.length > 0) {
    charts['report-pie'] = new Chart($('chart-report-pie'), {
      type: 'doughnut',
      data: {
        labels: data.byCategory.map(b => b.category),
        datasets: [{ data: data.byCategory.map(b => b.total), backgroundColor: CAT_COLORS, borderWidth: 2, borderColor: '#fff' }]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
    });
  }
}

// ── Export Excel ──────────────────────────────────────────────
async function exportExcel() {
  if (!window.XLSX) {
    toast('Biblioteca do Excel não carregou. Verifique a conexão e tente novamente.', 'error');
    return;
  }

  try {
    toast('Gerando planilha...', 'success');

    const allTxs = await api('GET', '/api/transactions');
    if (!allTxs.length) {
      toast('Nenhum lançamento para exportar.', 'error');
      return;
    }

    const byMonth = {};
    allTxs.forEach(t => {
      const m = t.effective_month || t.competence_month || t.date?.slice(0, 7) || 'Sem data';
      if (!byMonth[m]) byMonth[m] = [];
      byMonth[m].push(t);
    });

    const months = Object.keys(byMonth).sort();
    const wb = XLSX.utils.book_new();

    const GREEN_FILL = { fgColor: { rgb: '1B5E20' } };
    const LIGHT_GREEN = { fgColor: { rgb: 'E8F5E9' } };
    const LIGHT_RED = { fgColor: { rgb: 'FFEBEE' } };
    const ZEBRA = { fgColor: { rgb: 'FAFAFA' } };
    const headerStyle = {
      font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 11 },
      fill: GREEN_FILL,
      alignment: { horizontal: 'center' },
      border: { bottom: { style: 'thin', color: { rgb: 'CCCCCC' } } }
    };
    const titleStyle = { font: { bold: true, sz: 14, color: { rgb: '1B5E20' } } };
    const totalStyle = { font: { bold: true }, fill: LIGHT_GREEN };
    const currFmt = 'R$\\ #,##0.00;(R$\\ #,##0.00);"-"';
    const dateFmt = 'dd/mm/yyyy';
    const pctFmt = '0.0%';

    const applyCurrency = (ws, ref, style) => {
      if (!ws[ref]) return;
      ws[ref].t = 'n';
      ws[ref].z = currFmt;
      if (style) ws[ref].s = style;
    };
    const applyPercent = (ws, ref, style) => {
      if (!ws[ref]) return;
      ws[ref].t = 'n';
      ws[ref].z = pctFmt;
      if (style) ws[ref].s = style;
    };

    const monthTotals = months.map(m => {
      const txs = byMonth[m];
      const inc = txs.filter(t => t.type === 'Receita').reduce((s, t) => s + parseFloat(t.amount || 0), 0);
      const exp = txs.filter(t => t.type === 'Despesa').reduce((s, t) => s + parseFloat(t.amount || 0), 0);
      return { m, inc, exp, bal: inc - exp, rate: inc > 0 ? (inc - exp) / inc : 0, count: txs.length };
    });

    const summaryData = [
      ['RESUMO FINANCEIRO POR MÊS', '', '', '', '', ''],
      [''],
      ['Mês', 'Receitas', 'Despesas', 'Saldo', 'Taxa Poupança', 'Nº Lançamentos'],
      ...monthTotals.map(({ m, inc, exp, bal, rate, count }) => [monthLabel(m), inc, exp, bal, rate, count]),
      ['']
    ];
    const totInc = monthTotals.reduce((s, x) => s + x.inc, 0);
    const totExp = monthTotals.reduce((s, x) => s + x.exp, 0);
    summaryData.push(['TOTAL GERAL', totInc, totExp, totInc - totExp, totInc > 0 ? (totInc - totExp) / totInc : 0, allTxs.length]);

    const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);
    wsSummary['!cols'] = [{ wch: 20 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 16 }];
    wsSummary['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 5 } }];
    wsSummary['!autofilter'] = { ref: `A3:F${monthTotals.length + 3}` };
    if (wsSummary.A1) wsSummary.A1.s = titleStyle;
    ['A', 'B', 'C', 'D', 'E', 'F'].forEach(col => { if (wsSummary[`${col}3`]) wsSummary[`${col}3`].s = headerStyle; });
    for (let i = 0; i < monthTotals.length; i++) {
      const row = 4 + i;
      ['B', 'C', 'D'].forEach(col => applyCurrency(wsSummary, `${col}${row}`));
      applyPercent(wsSummary, `E${row}`);
    }
    const totalRow = monthTotals.length + 5;
    ['B', 'C', 'D'].forEach(col => applyCurrency(wsSummary, `${col}${totalRow}`));
    applyPercent(wsSummary, `E${totalRow}`);
    ['A', 'B', 'C', 'D', 'E', 'F'].forEach(col => { if (wsSummary[`${col}${totalRow}`]) wsSummary[`${col}${totalRow}`].s = totalStyle; });
    XLSX.utils.book_append_sheet(wb, wsSummary, 'Resumo Geral');

    const allRows = [];

    months.forEach(m => {
      const txs = byMonth[m].sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.id - b.id);
      const label = monthLabel(m);
      const headers = [
        'Data do Gasto', 'Mês de Pagamento', 'Descrição', 'Categoria',
        'Tipo', 'Forma de Pagamento', 'Parcela', 'Valor', 'Observação'
      ];
      const rows = txs.map(t => {
        const pmName = t.pm_name || (t.payment_type === 'dinheiro' ? 'Dinheiro' : t.payment_type === 'pix' ? 'PIX' : t.payment_type || 'Dinheiro');
        const parcela = Number(t.installments) > 1 ? `${t.installment_number}/${t.installments}` : '';
        const compMonth = t.competence_month ? monthLabel(t.competence_month) : monthLabel(m);
        const row = [
          t.date ? new Date(t.date + 'T12:00:00') : '',
          compMonth,
          t.description || '',
          t.category || '',
          t.type || '',
          pmName,
          parcela,
          parseFloat(t.amount || 0),
          t.note || ''
        ];
        allRows.push([label, ...row]);
        return row;
      });

      const inc = txs.filter(t => t.type === 'Receita').reduce((s, t) => s + parseFloat(t.amount || 0), 0);
      const exp = txs.filter(t => t.type === 'Despesa').reduce((s, t) => s + parseFloat(t.amount || 0), 0);
      const sheetData = [
        [`LANÇAMENTOS - ${label.toUpperCase()}`, '', '', '', '', '', '', '', ''],
        [''],
        headers,
        ...rows,
        [''],
        ['', '', '', '', '', '', 'RECEITA TOTAL:', inc, ''],
        ['', '', '', '', '', '', 'DESPESA TOTAL:', exp, ''],
        ['', '', '', '', '', '', 'SALDO:', inc - exp, ''],
        ['', '', '', '', '', '', 'TAXA POUPANÇA:', inc > 0 ? (inc - exp) / inc : 0, ''],
      ];

      const ws = XLSX.utils.aoa_to_sheet(sheetData, { dateNF: dateFmt });
      ws['!cols'] = [{ wch: 14 }, { wch: 16 }, { wch: 32 }, { wch: 16 }, { wch: 10 }, { wch: 18 }, { wch: 10 }, { wch: 14 }, { wch: 24 }];
      ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 8 } }];
      ws['!autofilter'] = { ref: `A3:I${rows.length + 3}` };
      ws['!freeze'] = { xSplit: 0, ySplit: 3 };
      if (ws.A1) ws.A1.s = titleStyle;
      ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'].forEach(col => { if (ws[`${col}3`]) ws[`${col}3`].s = headerStyle; });

      rows.forEach((row, i) => {
        const sheetRow = i + 4;
        const isReceita = row[4] === 'Receita';
        const fill = isReceita ? LIGHT_GREEN : (i % 2 === 0 ? null : ZEBRA);
        const baseStyle = fill ? { fill } : undefined;
        if (ws[`A${sheetRow}`]) { ws[`A${sheetRow}`].t = 'd'; ws[`A${sheetRow}`].z = dateFmt; ws[`A${sheetRow}`].s = { ...(baseStyle || {}), alignment: { horizontal: 'center' } }; }
        ['B', 'C', 'D', 'E', 'F', 'G', 'I'].forEach(col => { if (ws[`${col}${sheetRow}`] && baseStyle) ws[`${col}${sheetRow}`].s = baseStyle; });
        applyCurrency(ws, `H${sheetRow}`, {
          ...(baseStyle || {}),
          font: { bold: true, color: { rgb: isReceita ? '1B5E20' : 'C62828' } },
          alignment: { horizontal: 'right' }
        });
      });

      const totalStart = rows.length + 5;
      [
        [totalStart, 'Receita'],
        [totalStart + 1, 'Despesa'],
        [totalStart + 2, 'Saldo']
      ].forEach(([r, tipo]) => {
        if (ws[`G${r}`]) ws[`G${r}`].s = { font: { bold: true }, alignment: { horizontal: 'right' } };
        applyCurrency(ws, `H${r}`, { font: { bold: true, color: { rgb: tipo === 'Receita' ? '1B5E20' : tipo === 'Despesa' ? 'C62828' : (inc - exp >= 0 ? '1B5E20' : 'C62828') } } });
      });
      if (ws[`G${totalStart + 3}`]) ws[`G${totalStart + 3}`].s = { font: { bold: true }, alignment: { horizontal: 'right' } };
      applyPercent(ws, `H${totalStart + 3}`, { font: { bold: true } });

      const sheetName = label.replace(/[\\\/\?\*\[\]]/g, '').slice(0, 31);
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    });

    const detailHeaders = ['Mês', 'Data do Gasto', 'Mês de Pagamento', 'Descrição', 'Categoria', 'Tipo', 'Forma de Pagamento', 'Parcela', 'Valor', 'Observação'];
    const wsDetail = XLSX.utils.aoa_to_sheet([['TODOS OS LANÇAMENTOS', '', '', '', '', '', '', '', '', ''], [''], detailHeaders, ...allRows], { dateNF: dateFmt });
    wsDetail['!cols'] = [{ wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 32 }, { wch: 16 }, { wch: 10 }, { wch: 18 }, { wch: 10 }, { wch: 14 }, { wch: 24 }];
    wsDetail['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 9 } }];
    wsDetail['!autofilter'] = { ref: `A3:J${allRows.length + 3}` };
    wsDetail['!freeze'] = { xSplit: 0, ySplit: 3 };
    if (wsDetail.A1) wsDetail.A1.s = titleStyle;
    ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'].forEach(col => { if (wsDetail[`${col}3`]) wsDetail[`${col}3`].s = headerStyle; });
    allRows.forEach((row, i) => {
      const sheetRow = i + 4;
      if (wsDetail[`B${sheetRow}`]) { wsDetail[`B${sheetRow}`].t = 'd'; wsDetail[`B${sheetRow}`].z = dateFmt; }
      applyCurrency(wsDetail, `I${sheetRow}`);
      if (row[5] === 'Receita' && wsDetail[`I${sheetRow}`]) wsDetail[`I${sheetRow}`].s = { font: { bold: true, color: { rgb: '1B5E20' } }, fill: LIGHT_GREEN };
      if (row[5] === 'Despesa' && wsDetail[`I${sheetRow}`]) wsDetail[`I${sheetRow}`].s = { font: { bold: true, color: { rgb: 'C62828' } }, fill: LIGHT_RED };
    });
    XLSX.utils.book_append_sheet(wb, wsDetail, 'Todos Lancamentos');

    const now = new Date();
    const fileName = `Orcamento_${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}.xlsx`;
    XLSX.writeFile(wb, fileName);
    toast(`Planilha "${fileName}" baixada!`);
  } catch(e) {
    toast(e.message || 'Não foi possível exportar a planilha.', 'error');
  }
}

// ── Lembretes ─────────────────────────────────────────────────
async function loadReminders() {
  try {
    remindersList = await api('GET', '/api/reminders');
    updateReminderBadge();
    checkDueReminders();
  } catch { /* silencioso */ }
}

function updateReminderBadge() {
  const active = remindersList.filter(r => !r.done && !r.cancelled);
  const badge = $('reminder-badge');
  if (!badge) return;
  if (active.length > 0) {
    badge.textContent = active.length;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function checkDueReminders() {
  if (currentAlertReminder) return; // já tem alerta aberto
  const now = new Date();
  const due = remindersList.find(r => !r.done && !r.cancelled && new Date(r.remind_at) <= now);
  if (due) showReminderAlert(due);
}

function showReminderAlert(reminder) {
  currentAlertReminder = reminder;
  $('reminder-alert-title').textContent = reminder.title;
  $('reminder-alert-overlay').classList.remove('hidden');
}

async function reminderDone() {
  if (!currentAlertReminder) return;
  try {
    await api('PATCH', `/api/reminders/${currentAlertReminder.id}`, { done: true });
    remindersList = remindersList.map(r => r.id === currentAlertReminder.id ? { ...r, done: 1 } : r);
  } catch { toast('Erro ao atualizar lembrete', 'error'); }
  currentAlertReminder = null;
  $('reminder-alert-overlay').classList.add('hidden');
  updateReminderBadge();
  renderReminderList();
  // checar próximo lembrete vencido
  setTimeout(checkDueReminders, 500);
}

async function reminderCancel() {
  if (!currentAlertReminder) return;
  try {
    await api('PATCH', `/api/reminders/${currentAlertReminder.id}`, { cancelled: true });
    remindersList = remindersList.filter(r => r.id !== currentAlertReminder.id);
  } catch { toast('Erro ao cancelar lembrete', 'error'); }
  currentAlertReminder = null;
  $('reminder-alert-overlay').classList.add('hidden');
  updateReminderBadge();
  renderReminderList();
  setTimeout(checkDueReminders, 500);
}

function openReminderManager() {
  renderReminderList();
  $('reminder-manager-overlay').classList.remove('hidden');
  // preencher datetime-local com agora + 1h como padrão
  const dt = new Date(Date.now() + 3600000);
  const local = dt.toISOString().slice(0, 16);
  $('reminder-date-input').value = local;
  $('reminder-title-input').value = '';
  $('reminder-title-input').focus();
}

function closeReminderManager() {
  $('reminder-manager-overlay').classList.add('hidden');
}

function renderReminderList() {
  const el = $('reminder-list');
  if (!el) return;
  const active = remindersList.filter(r => !r.done && !r.cancelled);
  const done   = remindersList.filter(r =>  r.done && !r.cancelled);

  if (!active.length && !done.length) {
    el.innerHTML = '<p style="color:var(--gray-500);text-align:center;padding:1rem">Nenhum lembrete cadastrado.</p>';
    return;
  }

  const fmt = dt => {
    const d = new Date(dt);
    return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  };

  const makeItem = (r) => {
    const isDue = !r.done && new Date(r.remind_at) <= new Date();
    return `<div style="display:flex;align-items:center;gap:.5rem;padding:.6rem .75rem;border-radius:8px;background:${r.done ? 'var(--gray-100)' : isDue ? '#fff3e0' : 'var(--green-bg)'}">
      <span style="font-size:1.1rem">${r.done ? '✅' : isDue ? '⚠️' : '🔔'}</span>
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:.9rem;${r.done ? 'text-decoration:line-through;color:var(--gray-500)' : ''}">${r.title}</div>
        <div style="font-size:.78rem;color:var(--gray-500)">${fmt(r.remind_at)}</div>
      </div>
      ${!r.done ? `<button onclick="deleteReminder(${r.id})" title="Remover" style="background:none;border:none;cursor:pointer;color:var(--red);font-size:1rem;padding:.2rem">🗑️</button>` : ''}
    </div>`;
  };

  el.innerHTML = active.map(makeItem).join('') +
    (done.length ? `<div style="font-size:.78rem;color:var(--gray-500);margin-top:.75rem;margin-bottom:.25rem">Concluídos</div>` + done.map(makeItem).join('') : '');
}

async function createReminder(e) {
  e.preventDefault();
  const title    = $('reminder-title-input').value.trim();
  const remind_at = $('reminder-date-input').value;
  if (!title || !remind_at) return;
  try {
    const r = await api('POST', '/api/reminders', { title, remind_at });
    remindersList.push({ id: r.id, title, remind_at, done: 0, cancelled: 0 });
    updateReminderBadge();
    renderReminderList();
    $('reminder-title-input').value = '';
    toast('Lembrete criado!');
  } catch(err) { toast(err.message || 'Erro ao criar lembrete', 'error'); }
}

async function deleteReminder(id) {
  try {
    await api('DELETE', `/api/reminders/${id}`);
    remindersList = remindersList.filter(r => r.id !== id);
    updateReminderBadge();
    renderReminderList();
  } catch(err) { toast(err.message || 'Erro ao remover', 'error'); }
}

function startReminderPolling() {
  if (reminderPollInterval) return;
  loadReminders();
  reminderPollInterval = setInterval(loadReminders, 60000);
}

// ── Pug mood ─────────────────────────────────────────────────
function calcPugMood(income, expense, balance, limits, byCategory) {
  if (!income && !expense) return 'normal';
  const limMap = {};
  (limits || []).forEach(l => limMap[l.category] = l.limit_amount);
  const overLimit = (byCategory || []).some(b => (limMap[b.category]||0) > 0 && b.total > limMap[b.category]);
  const nearLimit = !overLimit && (byCategory || []).some(b => (limMap[b.category]||0) > 0 && b.total / limMap[b.category] >= 0.85);
  const rate = income > 0 ? balance / income : (balance >= 0 ? 0 : -1);
  if (balance < 0 && Math.abs(balance) > (income || expense) * 0.2) return 'desesperado';
  if (overLimit || balance < 0) return 'assustado';
  if (nearLimit || rate < 0.05) return 'preocupado';
  if (rate < 0.20) return 'normal';
  if (rate < 0.35) return 'feliz';
  return 'eufórico';
}

function pugSVG(mood) {
  // ── Palette ──
  const HEAD   = '#D4A870';
  const SHADOW = '#B8905A';
  const EAR    = '#6B4A35';
  const EAR_IN = '#9A7060';
  const MUZZLE = '#9A7A5A';
  const NOSE   = '#1A0800';
  const IRIS   = '#4A3020';
  const BROW   = '#7A5040';
  const MOUTH_S= '#3A2010';

  // ── Eyebrows ──
  const brows = {
    eufórico:   `<path d="M55,74 Q72,62 89,70" stroke="${BROW}" stroke-width="5" fill="none" stroke-linecap="round"/>
                 <path d="M111,70 Q128,62 145,74" stroke="${BROW}" stroke-width="5" fill="none" stroke-linecap="round"/>`,
    feliz:      `<path d="M57,78 Q72,67 89,73" stroke="${BROW}" stroke-width="4.5" fill="none" stroke-linecap="round"/>
                 <path d="M111,73 Q128,67 143,78" stroke="${BROW}" stroke-width="4.5" fill="none" stroke-linecap="round"/>`,
    normal:     `<path d="M59,80 Q72,75 89,78" stroke="${BROW}" stroke-width="4" fill="none" stroke-linecap="round"/>
                 <path d="M111,78 Q128,75 141,80" stroke="${BROW}" stroke-width="4" fill="none" stroke-linecap="round"/>`,
    preocupado: `<path d="M59,78 Q72,85 89,73" stroke="${BROW}" stroke-width="5" fill="none" stroke-linecap="round"/>
                 <path d="M111,73 Q128,85 141,78" stroke="${BROW}" stroke-width="5" fill="none" stroke-linecap="round"/>`,
    assustado:  `<path d="M55,75 Q72,69 89,75" stroke="${BROW}" stroke-width="5" fill="none" stroke-linecap="round"/>
                 <path d="M111,75 Q128,69 145,75" stroke="${BROW}" stroke-width="5" fill="none" stroke-linecap="round"/>`,
    desesperado:`<path d="M55,76 Q72,86 89,71" stroke="${BROW}" stroke-width="5.5" fill="none" stroke-linecap="round"/>
                 <path d="M111,71 Q128,86 145,76" stroke="${BROW}" stroke-width="5.5" fill="none" stroke-linecap="round"/>`,
  };

  // ── Pupils / eyes ──
  const er = mood === 'assustado' ? 22 : 19; // eye white radius
  const ir = er - 5;                          // iris radius

  const pupils = {
    eufórico:   `<circle cx="73" cy="95" r="8" fill="#0A0400"/><circle cx="127" cy="95" r="8" fill="#0A0400"/>`,
    feliz:      `<circle cx="73" cy="95" r="9" fill="#0A0400"/><circle cx="127" cy="95" r="9" fill="#0A0400"/>`,
    normal:     `<circle cx="73" cy="97" r="9" fill="#0A0400"/><circle cx="127" cy="97" r="9" fill="#0A0400"/>`,
    preocupado: `<circle cx="72" cy="98" r="9" fill="#0A0400"/><circle cx="128" cy="98" r="9" fill="#0A0400"/>`,
    assustado:  `<circle cx="73" cy="93" r="13" fill="#0A0400"/><circle cx="127" cy="93" r="13" fill="#0A0400"/>`,
    desesperado:`<line x1="62" y1="84" x2="84" y2="106" stroke="#0A0400" stroke-width="5.5" stroke-linecap="round"/>
                 <line x1="84" y1="84" x2="62" y2="106" stroke="#0A0400" stroke-width="5.5" stroke-linecap="round"/>
                 <line x1="116" y1="84" x2="138" y2="106" stroke="#0A0400" stroke-width="5.5" stroke-linecap="round"/>
                 <line x1="138" y1="84" x2="116" y2="106" stroke="#0A0400" stroke-width="5.5" stroke-linecap="round"/>`,
  };

  const highlights = mood === 'desesperado' ? '' :
    `<circle cx="80" cy="87" r="5" fill="white"/>
     <circle cx="134" cy="87" r="5" fill="white"/>
     <circle cx="84" cy="92" r="2.5" fill="white"/>
     <circle cx="138" cy="92" r="2.5" fill="white"/>`;

  // ── Mouth ──
  const mouths = {
    eufórico:   `<path d="M82,157 Q100,174 118,157" fill="#CC6644" stroke="${MOUTH_S}" stroke-width="3.5" stroke-linecap="round"/>
                 <ellipse cx="100" cy="167" rx="12" ry="9" fill="#FF8888"/>
                 <line x1="100" y1="158" x2="100" y2="176" stroke="#FF6666" stroke-width="2.5"/>`,
    feliz:      `<path d="M84,160 Q100,173 116,160" stroke="${MOUTH_S}" stroke-width="3.5" fill="none" stroke-linecap="round"/>`,
    normal:     `<path d="M88,163 Q100,166 112,163" stroke="${MOUTH_S}" stroke-width="3" fill="none" stroke-linecap="round"/>`,
    preocupado: `<path d="M86,168 Q100,158 114,168" stroke="${MOUTH_S}" stroke-width="3.5" fill="none" stroke-linecap="round"/>`,
    assustado:  `<ellipse cx="100" cy="162" rx="11" ry="9" fill="#1A0A00"/>`,
    desesperado:`<path d="M83,170 Q100,156 117,170" stroke="${MOUTH_S}" stroke-width="4.5" fill="none" stroke-linecap="round"/>`,
  };

  // ── Extras ──
  const extras = {
    eufórico:   `<circle cx="59" cy="112" r="15" fill="rgba(255,130,130,0.38)"/>
                 <circle cx="141" cy="112" r="15" fill="rgba(255,130,130,0.38)"/>
                 <text x="12" y="58" font-size="22">✨</text>
                 <text x="158" y="56" font-size="22">✨</text>
                 <text x="22" y="190" font-size="16">💚</text>
                 <text x="155" y="190" font-size="16">💚</text>`,
    feliz:      `<circle cx="59" cy="112" r="13" fill="rgba(255,150,150,0.33)"/>
                 <circle cx="141" cy="112" r="13" fill="rgba(255,150,150,0.33)"/>`,
    normal:     ``,
    preocupado: `<text x="156" y="80" font-size="22">💦</text>`,
    assustado:  `<text x="156" y="72" font-size="21">💦</text>
                 <text x="14" y="72" font-size="21">💦</text>
                 <text x="160" y="98" font-size="17">💦</text>`,
    desesperado:`<ellipse cx="57" cy="116" rx="5" ry="10" fill="#88BBDD" opacity="0.88"/>
                 <ellipse cx="143" cy="116" rx="5" ry="10" fill="#88BBDD" opacity="0.88"/>
                 <path d="M55,126 Q51,140 56,152" stroke="#88BBDD" stroke-width="4" fill="none" stroke-linecap="round"/>
                 <path d="M145,126 Q149,140 144,152" stroke="#88BBDD" stroke-width="4" fill="none" stroke-linecap="round"/>
                 <text x="155" y="70" font-size="20">😭</text>`,
  };

  return `<svg viewBox="0 0 200 215" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:180px;display:block;margin:0 auto">
  <style>
    .pb { animation: pugBob 3.2s ease-in-out infinite; transform-origin: 100px 115px; }
    @keyframes pugBob { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-5px)} }
    .pt { animation: pugTail 0.6s ease-in-out infinite alternate; transform-origin: 100px 200px; }
    @keyframes pugTail { 0%{transform:rotate(-8deg)} 100%{transform:rotate(8deg)} }
  </style>

  <g class="pb">
    <!-- Drop shadow -->
    <ellipse cx="100" cy="209" rx="56" ry="7" fill="rgba(0,0,0,0.11)"/>

    <!-- Ears (behind head) -->
    <ellipse cx="40" cy="77" rx="23" ry="31" fill="${EAR}"    transform="rotate(-15 40 77)"/>
    <ellipse cx="160" cy="77" rx="23" ry="31" fill="${EAR}"   transform="rotate(15 160 77)"/>
    <ellipse cx="40" cy="78" rx="13" ry="21" fill="${EAR_IN}" transform="rotate(-15 40 78)"/>
    <ellipse cx="160" cy="78" rx="13" ry="21" fill="${EAR_IN}" transform="rotate(15 160 78)"/>

    <!-- Head -->
    <ellipse cx="100" cy="114" rx="77" ry="81" fill="${HEAD}"/>
    <!-- Subtle top highlight -->
    <ellipse cx="100" cy="78" rx="48" ry="32" fill="rgba(255,230,180,0.22)"/>

    <!-- Forehead wrinkles -->
    <path d="M82,52 Q100,44 118,52" stroke="${SHADOW}" stroke-width="3"   fill="none" stroke-linecap="round"/>
    <path d="M79,63 Q100,55 121,63" stroke="${SHADOW}" stroke-width="2.5" fill="none" stroke-linecap="round"/>
    <path d="M77,73 Q100,66 123,73" stroke="${SHADOW}" stroke-width="2"   fill="none" stroke-linecap="round"/>

    <!-- Eyebrows -->
    ${brows[mood] || brows.normal}

    <!-- Eye whites -->
    <ellipse cx="73"  cy="94" rx="${er}" ry="${er}" fill="white"/>
    <ellipse cx="127" cy="94" rx="${er}" ry="${er}" fill="white"/>
    <!-- Irises -->
    <circle cx="73"  cy="94" r="${ir}" fill="${IRIS}"/>
    <circle cx="127" cy="94" r="${ir}" fill="${IRIS}"/>
    <!-- Pupils / expression -->
    ${pupils[mood] || pupils.normal}
    <!-- Highlights -->
    ${highlights}

    <!-- Muzzle area -->
    <ellipse cx="100" cy="150" rx="43" ry="30" fill="${MUZZLE}"/>
    <!-- Center crease -->
    <path d="M100,130 Q99,145 100,150" stroke="#7A5A3A" stroke-width="3" fill="none"/>
    <!-- Side creases -->
    <path d="M68,138 Q72,148 70,158" stroke="#8A6A4A" stroke-width="2" fill="none" stroke-linecap="round"/>
    <path d="M132,138 Q128,148 130,158" stroke="#8A6A4A" stroke-width="2" fill="none" stroke-linecap="round"/>

    <!-- Nose -->
    <rect x="86" y="130" width="28" height="16" rx="8" fill="${NOSE}"/>
    <!-- Nostril shine -->
    <ellipse cx="94" cy="134" rx="3.5" ry="2.5" fill="#3A2010" opacity="0.5"/>
    <ellipse cx="106" cy="134" rx="3.5" ry="2.5" fill="#3A2010" opacity="0.5"/>
    <ellipse cx="92"  cy="132" rx="2"   ry="1.5" fill="#6A4030" opacity="0.4"/>
    <ellipse cx="104" cy="132" rx="2"   ry="1.5" fill="#6A4030" opacity="0.4"/>

    <!-- Mouth -->
    ${mouths[mood] || mouths.normal}

    <!-- Chin fold -->
    <path d="M88,176 Q100,183 112,176" stroke="${SHADOW}" stroke-width="2.5" fill="none" stroke-linecap="round"/>

    <!-- Cheeks / tears / extras -->
    ${extras[mood] || ''}
  </g>
</svg>`;
}

// ── Init ──────────────────────────────────────────────────────
if (token && currentUser) {
  bootApp();
} else {
  $('auth-screen').classList.remove('hidden');
}
