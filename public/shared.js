/* 共享逻辑：主题（.dark class + DaisyUI data-theme 同步）、省份（localStorage）、分页、空状态。
   各页引入 shared.js 后，再写本页的 render 函数；省份切换时调用 window.onProvinceChange（各页定义）。 */
const KEY = { p92: '92号汽油', p95: '95号汽油', p98: '98号汽油', d0: '0号柴油' };
const FUEL_KEYS = ['p92', 'p95', 'p98', 'd0'];
const FUEL_CODE = { 92: 'p92', 95: 'p95', 98: 'p98', 0: 'd0' };
const PROVINCE_KEY = 'china-fuel-current-province';
const PAGE_SIZE = 10;
let CURRENT = '上海';

async function j(u) { const r = await fetch(u); return r.json(); }
function fmt(n) { return n == null ? '—' : n.toFixed(2); }
function fmtSigned(n, digits) {
  if (n == null) return '—';
  const d = digits == null ? 2 : digits;
  const v = n.toFixed(d);
  if (n > 0) return '+' + v;
  if (n < 0) return v;
  return '±' + Math.abs(n).toFixed(d);
}
function getCurrentProvince() {
  try { const v = localStorage.getItem(PROVINCE_KEY); if (v) return v; } catch (e) {}
  return '上海';
}
function applyTheme(dark) {
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch (e) {}
  const b = document.getElementById('themeBtn');
  if (b) b.textContent = dark ? '浅色' : '暗色';
}
function initTheme() {
  // <head> 内联脚本已做防闪烁；这里同步按钮文案与 data-theme
  const dark = document.documentElement.classList.contains('dark');
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  const b = document.getElementById('themeBtn');
  if (b) {
    b.textContent = dark ? '浅色' : '暗色';
    b.onclick = () => applyTheme(!document.documentElement.classList.contains('dark'));
  }
}
function markNavActive() {
  const path = location.pathname.replace(/\/$/, '') || '/';
  document.querySelectorAll('[data-nav]').forEach(a => {
    const href = a.getAttribute('href') || '';
    const norm = href.replace(/\/$/, '') || '/';
    const active = norm === path || (path === '/index.html' && norm === '/');
    a.classList.toggle('btn-active', active);
    a.classList.toggle('text-base-content', active);
    a.setAttribute('aria-current', active ? 'page' : '');
  });
}
function populateProvinceSelect(el, provinces) {
  if (!el || !provinces) return;
  el.innerHTML = provinces.map(p => `<option ${p === CURRENT ? 'selected' : ''}>${p}</option>`).join('');
}
function syncProvinceSelects() {
  document.querySelectorAll('select[data-province-select]').forEach(s => { s.value = CURRENT; });
  const tp = document.getElementById('topProvince');
  if (tp) tp.value = CURRENT;
}
function setCurrentProvince(p) {
  CURRENT = p;
  try { localStorage.setItem(PROVINCE_KEY, p); } catch (e) {}
  syncProvinceSelects();
  if (typeof window.onProvinceChange === 'function') window.onProvinceChange();
}
function initProvinceSwitcher(onChange) {
  const tp = document.getElementById('topProvince');
  if (tp) tp.onchange = () => setCurrentProvince(tp.value);
  if (onChange) window.onProvinceChange = onChange;
}
function initShared() {
  CURRENT = getCurrentProvince();
  initTheme();
  markNavActive();
}
function emptyState(title, note, tone) {
  // DaisyUI alert
  const cls = tone === 'warning' ? 'alert-warning' : 'alert-info';
  return `<div class="alert ${cls}"><span>${title}</span><span class="text-xs opacity-80">${note || ''}</span></div>`;
}
function renderPagination(total, page, elId, onPage) {
  const el = document.getElementById(elId);
  if (!el) return;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  let nums = '';
  for (let i = 1; i <= totalPages; i++) {
    nums += `<button data-p="${i}" class="btn join-item btn-sm ${i === page ? 'btn-active' : ''}">${i}</button>`;
  }
  el.innerHTML = `<span class="text-xs opacity-70">共 ${total} 条 · 第 ${page} / ${totalPages} 页</span>`
    + `<div class="join"><button data-p="prev" class="btn join-item btn-sm" ${page <= 1 ? 'disabled' : ''}>上一页</button>${nums}<button data-p="next" class="btn join-item btn-sm" ${page >= totalPages ? 'disabled' : ''}>下一页</button></div>`;
  el.querySelectorAll('button[data-p]').forEach(b => b.onclick = () => {
    const v = b.dataset.p;
    let np = page;
    if (v === 'prev') np = page - 1; else if (v === 'next') np = page + 1; else np = +v;
    onPage(np);
  });
}
function deltaBadge(delta) {
  // 每升变动徽标：下调绿 ↓、上调红 ↑、0 灰
  if (delta == null) return '<span class="badge">—</span>';
  if (delta > 0) return `<span class="badge badge-error badge-soft">↑ +${delta.toFixed(3)} 元/升</span>`;
  if (delta < 0) return `<span class="badge badge-success badge-soft">↓ ${delta.toFixed(3)} 元/升</span>`;
  return '<span class="badge badge-ghost">±0.000 元/升</span>';
}
function registerSW() {
  if ('serviceWorker' in navigator) { navigator.serviceWorker.register('/sw.js').catch(() => {}); }
}
