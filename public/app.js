'use strict';

const $ = (id) => document.getElementById(id);
const CAT_KEYS = ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o'];
const PALETTE = ['#4f8cff', '#7ee787', '#f5b301', '#ff7b72', '#d2a8ff', '#79c0ff', '#ffa657', '#56d4dd', '#f778ba'];

const state = {
  config: null,
  photos: [],
  index: 0,
  total: 0,
  done: 0,
  busy: false,
  infoAbort: null,
  lastHistogram: null,
  // 过滤：'pending' 未处理 | 'all' 全部 | 'done' 全部已处理 | 'skip' 已跳过 | 'cat:<名称>' 某个分类
  filter: localStorage.getItem('photoClassifier.filter') || 'pending',
  allPhotos: [],   // 服务端返回的完整列表（含处理状态），过滤后得到 state.photos
  counts: { skip: 0, categories: {} },
  focus: null,
  showFocus: localStorage.getItem('photoClassifier.showFocus') !== '0',
};

// ---------- 通用 ----------
async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), 2200);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const current = () => state.photos[state.index];
const imgUrl = (name, w) => `/api/image?name=${encodeURIComponent(name)}&w=${w}`;

// ---------- 配置 / 分类 ----------
async function loadConfig() {
  state.config = await api('/api/config');
  $('sourceInput').value = state.config.sourceDir || '';
  $('baseDirInput').value = state.config.categoryBaseDir || '';
  $('undoBtn').disabled = !state.config.canUndo;
  renderCategories();
}

function renderCategories() {
  const cats = state.config.categories || [];
  const box = $('categoryButtons');
  box.innerHTML = '';
  if (!cats.length) box.innerHTML = '<span style="color:var(--muted);font-size:12px;white-space:nowrap;align-self:center">还没有分类，点右上角「设置」创建</span>';
  cats.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'catbtn' + (c.name === state.config.defaultCategory ? ' default' : '');
    b.innerHTML = `<span class="dot" style="background:${c.color || PALETTE[i % PALETTE.length]}"></span>${esc(c.name)}` +
      (CAT_KEYS[i] ? `<span class="key">${CAT_KEYS[i].toUpperCase()}</span>` : '');
    b.title = `拷贝到 ${c.dir}` + (c.name === state.config.defaultCategory ? '（默认，Enter）' : '');
    b.onclick = () => copyTo(c.name);
    box.appendChild(b);
  });

  const list = $('catList');
  list.innerHTML = '';
  cats.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'catitem';
    const isDef = c.name === state.config.defaultCategory;
    row.innerHTML = `<span class="name">${esc(c.name)}</span>
      <span class="path">${esc(c.dir)}<br>${esc(c.dir)}.arw</span>
      ${isDef ? '<span class="tag">默认</span>' : '<button type="button" class="btn setdef">设为默认</button>'}
      <button type="button" class="btn del">移除</button>`;
    row.querySelector('.setdef')?.addEventListener('click', async () => {
      state.config = await api('/api/categories/default', { method: 'POST', body: { name: c.name } });
      renderCategories();
    });
    row.querySelector('.del').addEventListener('click', async () => {
      if (!confirm(`从列表移除分类「${c.name}」？（不会删除磁盘上的文件夹）`)) return;
      state.config = await api(`/api/categories/${encodeURIComponent(c.name)}`, { method: 'DELETE' });
      renderCategories();
    });
    list.appendChild(row);
  });
  if (state.total) renderFilterOptions();
}

// ---------- 照片列表 / 过滤 ----------
const isPending = (f) => f === 'pending';
function matchFilter(p, f) {
  if (f === 'all') return true;
  if (f === 'pending') return !p.processed;
  if (f === 'done') return !!p.processed;
  if (f === 'skip') return p.processed?.action === 'skip';
  if (f.startsWith('cat:')) return p.processed?.action === 'copy' && p.processed.category === f.slice(4);
  return true;
}

function renderFilterOptions() {
  const sel = $('filterSel');
  const c = state.counts || { skip: 0, categories: {} };
  const pending = state.total - state.done;
  const cats = state.config?.categories || [];
  // 配置里已删除、但历史记录里仍有的分类也列出来，方便回看
  const extra = Object.keys(c.categories).filter((n) => !cats.some((x) => x.name === n));
  const opts = [
    ['pending', `未处理 (${pending})`],
    ['all', `全部 (${state.total})`],
    ['done', `已处理 (${state.done})`],
    ['skip', `已跳过 (${c.skip})`],
    ...cats.map((x) => [`cat:${x.name}`, `→ ${x.name} (${c.categories[x.name] || 0})`]),
    ...extra.map((n) => [`cat:${n}`, `→ ${n} (${c.categories[n]})（已移除）`]),
  ];
  sel.innerHTML = opts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
  if (!opts.some(([v]) => v === state.filter)) state.filter = 'pending';
  sel.value = state.filter;
}

function applyFilter(keepIndex = true) {
  const prevName = current()?.name;
  state.photos = state.allPhotos.filter((p) => matchFilter(p, state.filter));
  let idx = keepIndex ? state.photos.findIndex((p) => p.name === prevName) : 0;
  if (idx < 0) idx = Math.min(state.index, state.photos.length - 1);
  state.index = Math.max(0, idx);
  renderFilterOptions();
  renderFilmstrip();
  showCurrent();
}

function setFilter(f) {
  state.filter = f;
  localStorage.setItem('photoClassifier.filter', f);
  applyFilter(true);
}

async function loadPhotos(keepIndex = false) {
  try {
    const data = await api('/api/photos?all=1');
    state.allPhotos = data.photos;
    state.total = data.total;
    state.done = data.done;
    state.counts = data.counts || { skip: 0, categories: {} };
    applyFilter(keepIndex);
  } catch (e) {
    toast(e.message, true);
  }
}

function thumbStatusHtml(p) {
  if (!p.processed) return '';
  return p.processed.action === 'skip'
    ? '<span class="status skip">已跳过</span>'
    : `<span class="status copy">→ ${esc(p.processed.category)}</span>`;
}

// ---------- 缩略图栏（虚拟滚动：只渲染可视区附近的项） ----------
const strip = {
  cols: 1, cell: 0, rowH: 0, gap: 6, pad: 6, first: -1, last: -1, raf: 0,
  nodes: new Map(), // index -> element
};

function stripLayout() {
  const el = $('filmstrip');
  const w = el.clientWidth - strip.pad * 2;
  const minCell = w < 260 ? w : 120;
  strip.cols = Math.max(1, Math.floor((w + strip.gap) / (minCell + strip.gap)));
  strip.cell = (w - strip.gap * (strip.cols - 1)) / strip.cols;
  strip.rowH = strip.cell * 0.75 + strip.gap; // 4:3
}

function thumbNode(i) {
  const p = state.photos[i];
  const d = document.createElement('div');
  d.className = 'thumb' + (i === state.index ? ' active' : '') + (p.processed ? ' processed' : '');
  d.dataset.i = i;
  const img = document.createElement('img');
  img.alt = '';
  img.decoding = 'async';
  img.loading = 'lazy';
  img.onload = () => img.classList.add('loaded');
  img.src = imgUrl(p.name, 240);
  d.appendChild(img);
  if (p.rating) d.insertAdjacentHTML('beforeend', `<span class="rating">${'★'.repeat(p.rating)}</span>`);
  d.insertAdjacentHTML('beforeend', thumbStatusHtml(p));
  d.onclick = () => { state.index = i; showCurrent(); };
  return d;
}

function placeNode(d, i) {
  const r = Math.floor(i / strip.cols), c = i % strip.cols;
  d.style.transform = `translate(${strip.pad + c * (strip.cell + strip.gap)}px, ${strip.pad + r * strip.rowH}px)`;
  d.style.width = strip.cell + 'px';
  d.style.height = strip.cell * 0.75 + 'px';
}

function renderStripWindow() {
  strip.raf = 0;
  const el = $('filmstrip');
  const n = state.photos.length;
  if (!n) return;
  const rows = Math.ceil(n / strip.cols);
  el.firstElementChild.style.height = (strip.pad * 2 + rows * strip.rowH - strip.gap) + 'px';

  const overscan = 3;
  const r0 = Math.max(0, Math.floor((el.scrollTop - strip.pad) / strip.rowH) - overscan);
  const r1 = Math.min(rows - 1, Math.ceil((el.scrollTop + el.clientHeight - strip.pad) / strip.rowH) + overscan);
  const first = r0 * strip.cols, last = Math.min(n - 1, (r1 + 1) * strip.cols - 1);

  for (const [i, d] of strip.nodes) {
    if (i < first || i > last) { d.remove(); strip.nodes.delete(i); }
  }
  for (let i = first; i <= last; i++) {
    let d = strip.nodes.get(i);
    if (!d) { d = thumbNode(i); strip.nodes.set(i, d); el.firstElementChild.appendChild(d); }
    placeNode(d, i);
  }
  strip.first = first; strip.last = last;
}

function scheduleStrip() {
  if (!strip.raf) strip.raf = requestAnimationFrame(renderStripWindow);
}

function renderFilmstrip() {
  const el = $('filmstrip');
  strip.nodes.clear();
  el.innerHTML = '';
  if (!state.photos.length) {
    let msg = '文件夹中没有 JPG 照片';
    if (state.total) msg = isPending(state.filter) ? '全部照片已处理完 🎉<br><br>顶部「显示」可切换查看已处理的照片' : '当前过滤条件下没有照片';
    el.innerHTML = `<div class="empty">${msg}</div>`;
    return;
  }
  const spacer = document.createElement('div');
  spacer.className = 'strip-spacer';
  el.appendChild(spacer);
  stripLayout();
  renderStripWindow();
}

/** 单张状态变化后只刷新该项，不重建整个列表 */
function refreshThumb(i) {
  const d = strip.nodes.get(i);
  if (!d) return;
  const fresh = thumbNode(i);
  placeNode(fresh, i);
  d.replaceWith(fresh);
  strip.nodes.set(i, fresh);
}

function updateFilmstripActive() {
  for (const [i, d] of strip.nodes) d.classList.toggle('active', i === state.index);
  const el = $('filmstrip');
  if (!state.photos.length || !strip.rowH) return;
  const r = Math.floor(state.index / strip.cols);
  const top = strip.pad + r * strip.rowH, bottom = top + strip.rowH;
  if (top < el.scrollTop) el.scrollTop = top - strip.pad;
  else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight + strip.pad;
  scheduleStrip();
}

$('filmstrip').addEventListener('scroll', scheduleStrip, { passive: true });
new ResizeObserver(() => {
  if (!state.photos.length) return;
  stripLayout();
  for (const d of strip.nodes.values()) d.remove();
  strip.nodes.clear();
  renderStripWindow();
}).observe($('filmstrip'));

function updateProgress() {
  const remain = state.total - state.done;
  $('progressText').textContent = state.total ? `已处理 ${state.done} / ${state.total}，剩余 ${remain}` : '未加载';
  $('progressBar').style.width = state.total ? `${(state.done / state.total) * 100}%` : '0';
}

// ---------- 当前照片 ----------
function showCurrent() {
  const p = current();
  const stage = $('stage');
  const img = $('mainImg');
  updateProgress();
  const status = $('overlayStatus');
  if (!p) {
    stage.classList.add('empty');
    $('overlayName').textContent = '';
    status.className = 'overlay-status';
    renderStars(0);
    state.focus = null;
    renderFocus();
    $('exifGroups').innerHTML = '';
    $('exposure').innerHTML = '';
    drawHistogram(null);
    return;
  }
  stage.classList.remove('empty');
  state.focus = null;
  renderFocus();
  setMainImage(p);
  $('overlayName').textContent = `${p.name}  (${state.index + 1}/${state.photos.length})`;
  if (p.processed) {
    status.className = 'overlay-status ' + p.processed.action;
    status.textContent = p.processed.action === 'skip' ? '已跳过' : `已拷贝到「${p.processed.category}」`;
  } else status.className = 'overlay-status';
  renderStars(p.rating);
  updateFilmstripActive();
  loadInfo(p.name);
  // 预取前后两张，翻页时直接命中已解码的位图
  for (const d of [1, -1]) {
    const n = state.photos[state.index + d];
    if (n) loadDecoded(imgUrl(n.name, state.mainW)).catch(() => {});
  }
}

// ---------- 主视图大图 ----------
// 按舞台实际物理像素（CSS 尺寸 × devicePixelRatio）请求大图，按 512 分档避免缓存碎片
const MAIN_STEP = 512, MAIN_MAX = 5120;
function mainTargetWidth() {
  const st = $('stage');
  const dpr = window.devicePixelRatio || 1;
  const px = Math.max(st.clientWidth, st.clientHeight, 600) * dpr;
  return Math.min(MAIN_MAX, Math.ceil(px / MAIN_STEP) * MAIN_STEP);
}

/** 已解码大图的 LRU：持有 Image 引用让解码后的位图常驻内存，decode() 在后台线程完成，不阻塞主线程 */
const decodedCache = new Map(); // url -> { img, ready, promise }
function loadDecoded(url) {
  let ent = decodedCache.get(url);
  if (ent) { decodedCache.delete(url); decodedCache.set(url, ent); return ent.promise; }
  const im = new Image();
  im.decoding = 'async';
  im.src = url;
  ent = { img: im, ready: false, promise: null };
  ent.promise = im.decode().then(() => { ent.ready = true; return im; });
  ent.promise.catch(() => decodedCache.delete(url));
  decodedCache.set(url, ent);
  while (decodedCache.size > 5) decodedCache.delete(decodedCache.keys().next().value);
  return ent.promise;
}
function isDecoded(url) { const e = decodedCache.get(url); return !!(e && e.ready); }

let mainToken = 0;
function setMainImage(p) {
  const img = $('mainImg');
  const w = mainTargetWidth();
  const url = imgUrl(p.name, w);
  state.mainW = w;
  state.mainUrl = url;
  const token = ++mainToken;
  img.onload = () => { img.classList.remove('loading'); renderFocus(); };
  if (isDecoded(url)) { img.src = url; return; }
  // 大图还没好：先用缩略图垫底（通常已在浏览器缓存里，瞬间显示），翻页手感不受大图生成速度影响
  img.classList.remove('loading');
  img.src = imgUrl(p.name, 240);
  loadDecoded(url).then(() => {
    if (token === mainToken) img.src = url;
  }).catch(() => {
    if (token === mainToken) img.classList.add('loading');
  });
}

// 窗口变大 / 进入全屏 / 拖动缩略图栏后，如果需要更高分辨率就补一张，变小则不动
new ResizeObserver(() => maybeUpgradeMain()).observe($('stage'));
let mainResizeTimer = 0;
function maybeUpgradeMain() {
  clearTimeout(mainResizeTimer);
  mainResizeTimer = setTimeout(() => {
    const p = current();
    if (p && mainTargetWidth() > (state.mainW || 0)) setMainImage(p);
  }, 250);
}

async function loadInfo(name) {
  state.infoAbort?.abort();
  const ac = new AbortController();
  state.infoAbort = ac;
  try {
    const res = await fetch(`/api/info?name=${encodeURIComponent(name)}`, { signal: ac.signal });
    const info = await res.json();
    if (ac.signal.aborted || current()?.name !== name) return;
    state.lastHistogram = info.histogram;
    state.focus = info.exif?.focus || null;
    renderFocus();
    drawHistogram(info.histogram);
    renderExposure(info.histogram.stats);
    renderExif(info.exif);
  } catch (e) {
    if (e.name !== 'AbortError') console.warn(e);
  }
}

// ---------- EXIF 分组渲染 ----------
const EXIF_GROUPS = [
  { title: '拍摄参数', open: true, rows: (ex) => [
    ['快门', ex.exposure], ['光圈', ex.aperture], ['ISO', ex.iso],
    ['焦距', ex.focal35 && ex.focal35 !== ex.focal ? `${ex.focal}（等效 ${ex.focal35}）` : ex.focal],
    ['曝光补偿', ex.ev], ['曝光模式', ex.exposureProgram], ['测光', ex.metering], ['白平衡', ex.whiteBalance],
    ['闪光灯', ex.flash], ['亮度值', ex.brightness], ['对焦距离', ex.subjectDistance], ['数码变焦', ex.digitalZoom],
    ['对焦位置', ex.focus ? { html: `<span class="focus-info"><b>⌖</b> (${ex.focus.px.x}, ${ex.focus.px.y})${ex.focus.px.w ? ` · 框 ${ex.focus.px.w}×${ex.focus.px.h}` : ''}${ex.focus.maybeDefault ? ' <span class="warn">（居中，可能为默认值）</span>' : ''}</span>` } : null],
  ] },
  { title: '器材', open: true, rows: (ex) => [
    ['相机', ex.camera], ['镜头', ex.lens], ['镜头最大光圈', ex.maxAperture], ['机身序列号', ex.bodySerial], ['镜头序列号', ex.lensSerial], ['软件', ex.software],
  ] },
  { title: '时间与位置', open: true, rows: (ex) => [
    ['拍摄时间', ex.datetime ? `${ex.datetime}${ex.timezone ? ` (${ex.timezone})` : ''}` : null],
    ['GPS', ex.gps ? { html: `<a href="${ex.gps.mapUrl}" target="_blank" rel="noopener">${ex.gps.lat}, ${ex.gps.lng}</a>${ex.gps.alt ? ` · 海拔 ${ex.gps.alt}` : ''}` } : null],
  ] },
  { title: '图像', open: false, rows: (ex) => [
    ['尺寸', ex.width ? `${ex.width} × ${ex.height}` : null], ['像素', ex.megapixels], ['画幅比例', ex.aspect],
    ['色彩空间', ex.colorSpace], ['ICC 配置', ex.hasIcc ? '已嵌入' : null], ['场景模式', ex.sceneType],
    ['对比度 / 饱和度 / 锐度', [ex.contrast, ex.saturation, ex.sharpness].some(Boolean) ? [ex.contrast, ex.saturation, ex.sharpness].map((v) => v || '-').join(' / ') : null],
    ['相机内评分', ex.rating != null && ex.rating !== 0 ? '★'.repeat(ex.rating) : null],
  ] },
  { title: '文件', open: false, rows: (ex) => [
    ['文件大小', ex.fileSize], ['修改时间', ex.fileMtime], ['作者', ex.artist], ['版权', ex.copyright],
  ] },
];

function renderExif(ex = {}) {
  const box = $('exifGroups');
  box.innerHTML = '';
  let any = false;
  for (const g of EXIF_GROUPS) {
    const rows = g.rows(ex).filter(([, v]) => v != null && v !== '');
    if (!rows.length) continue;
    any = true;
    const d = document.createElement('details');
    d.className = 'exif-group';
    d.open = g.open;
    d.innerHTML = `<summary>${g.title}<span class="cnt">${rows.length}</span></summary>
      <dl class="exif">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v && v.html ? v.html : esc(v)}</dd>`).join('')}</dl>`;
    box.appendChild(d);
  }
  if (!any) box.innerHTML = '<h3>拍摄信息</h3><div class="exif-empty">无 EXIF 信息</div>';
}

function renderExposure(s) {
  const warn = s.verdict !== '曝光正常';
  $('exposure').innerHTML = `
    <div class="verdict ${warn ? 'warn' : 'ok'}">${s.verdict}</div>
    <span>平均亮度 <b>${s.mean}</b></span><span>中位亮度 <b>${s.median}</b></span>
    <span>高光溢出 <b>${s.clipHighPct}%</b></span><span>暗部死黑 <b>${s.clipLowPct}%</b></span>`;
}

// ---------- 直方图 ----------
function drawHistogram(h) {
  const cv = $('histCanvas');
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = '#2a2f36';
  for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo((W / 4) * i, 0); ctx.lineTo((W / 4) * i, H); ctx.stroke(); }
  if (!h) return;
  const showL = $('chkL').checked, showRGB = $('chkRGB').checked;
  const arrays = [];
  if (showRGB) arrays.push(h.r, h.g, h.b);
  if (showL) arrays.push(h.l);
  let max = 1;
  for (const a of arrays) {
    const sorted = [...a].sort((x, y) => x - y);
    max = Math.max(max, sorted[Math.floor(sorted.length * 0.995)]);
  }
  const plot = (arr, color, fill) => {
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let i = 0; i < 256; i++) ctx.lineTo((i / 255) * W, H - Math.min(1, arr[i] / max) * (H - 4));
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke();
  };
  ctx.globalCompositeOperation = 'lighter';
  if (showRGB) {
    plot(h.r, 'rgba(255,80,80,.9)', 'rgba(255,60,60,.28)');
    plot(h.g, 'rgba(80,255,80,.9)', 'rgba(60,255,60,.28)');
    plot(h.b, 'rgba(90,140,255,.9)', 'rgba(70,120,255,.28)');
  }
  ctx.globalCompositeOperation = 'source-over';
  if (showL) plot(h.l, 'rgba(230,230,230,.95)', 'rgba(220,220,220,.18)');
  if (h.stats.clipHighPct > 1) { ctx.fillStyle = 'rgba(255,120,0,.8)'; ctx.fillRect(W - 4, 0, 4, H); }
  if (h.stats.clipLowPct > 3) { ctx.fillStyle = 'rgba(120,120,255,.8)'; ctx.fillRect(0, 0, 4, H); }
}
$('chkL').onchange = $('chkRGB').onchange = () => drawHistogram(state.lastHistogram);

// ---------- 对焦区域 ----------
/** 把归一化的对焦框映射到大图实际显示区域（object-fit: contain 的内容矩形） */
function renderFocus() {
  const layer = $('focusLayer');
  const box = $('focusBox');
  const img = $('mainImg');
  const f = state.focus;
  $('focusBtn').classList.toggle('active', state.showFocus);
  if (!f || !state.showFocus || !img.naturalWidth || !img.complete || $('stage').classList.contains('empty')) {
    layer.hidden = true;
    return;
  }
  // 计算 contain 后图片内容在 stage 内的矩形
  const cw = img.clientWidth, ch = img.clientHeight;
  const ratio = Math.min(cw / img.naturalWidth, ch / img.naturalHeight);
  const dw = img.naturalWidth * ratio, dh = img.naturalHeight * ratio;
  const left = img.offsetLeft + (cw - dw) / 2, top = img.offsetTop + (ch - dh) / 2;
  layer.style.left = left + 'px';
  layer.style.top = top + 'px';
  layer.style.width = dw + 'px';
  layer.style.height = dh + 'px';
  layer.hidden = false;

  box.className = 'focus-box ' + (f.type === 'frame' ? 'frame' : 'point') + (f.maybeDefault ? ' default' : '');
  box.style.left = f.cx * 100 + '%';
  box.style.top = f.cy * 100 + '%';
  if (f.type === 'frame') {
    box.style.width = Math.max(12, f.w * dw) + 'px';
    box.style.height = Math.max(12, f.h * dh) + 'px';
  } else {
    box.style.width = box.style.height = '';
  }
  box.title = focusDescription(f);
}
function focusDescription(f) {
  if (!f) return '';
  const p = f.px;
  let s = `对焦${f.type === 'frame' ? '框' : '点'} (${p.x}, ${p.y})`;
  if (p.w) s += `，${p.w}×${p.h} px`;
  s += ` / 图像 ${p.imgW}×${p.imgH}，来源：${f.source}`;
  if (f.maybeDefault) s += '。位置恰在正中心，可能是相机未记录到对焦位置时的默认值';
  return s;
}
function toggleFocus(force) {
  state.showFocus = typeof force === 'boolean' ? force : !state.showFocus;
  localStorage.setItem('photoClassifier.showFocus', state.showFocus ? '1' : '0');
  renderFocus();
  if (state.showFocus && current() && !state.focus) toast('这张照片没有记录对焦位置信息');
}
$('focusBtn').onclick = () => toggleFocus();
new ResizeObserver(() => renderFocus()).observe($('stage'));

// ---------- 评分 ----------
function renderStars(v) {
  document.querySelectorAll('#stars span').forEach((s) => s.classList.toggle('on', Number(s.dataset.v) <= v));
}
async function rate(v) {
  const p = current();
  if (!p) return;
  if (p.rating === v) v = 0;
  const r = await api('/api/rate', { method: 'POST', body: { name: p.name, rating: v } });
  p.rating = r.rating;
  renderStars(p.rating);
  refreshThumb(state.index);
}
$('stars').addEventListener('click', (e) => { if (e.target.dataset.v) rate(Number(e.target.dataset.v)); });

// ---------- 拷贝 / 跳过 / 撤销 ----------
async function doAction(url, body, msgFn) {
  const p = current();
  if (!p || state.busy) return;
  state.busy = true;
  try {
    const r = await api(url, { method: 'POST', body: { name: p.name, ...body } });
    toast(msgFn(p, r));
    const prev = p.processed;
    if (!prev) state.done++;
    else if (prev.action === 'skip') state.counts.skip--;
    else if (prev.category) state.counts.categories[prev.category] = Math.max(0, (state.counts.categories[prev.category] || 1) - 1);
    p.processed = { action: body.category ? 'copy' : 'skip', category: body.category || null };
    if (p.processed.action === 'skip') state.counts.skip++;
    else state.counts.categories[p.processed.category] = (state.counts.categories[p.processed.category] || 0) + 1;
    if (matchFilter(p, state.filter)) {
      if (state.index < state.photos.length - 1) state.index++;
    } else {
      state.photos.splice(state.index, 1);
      if (state.index >= state.photos.length) state.index = Math.max(0, state.photos.length - 1);
    }
    renderFilterOptions();
    renderFilmstrip();
    showCurrent();
    $('undoBtn').disabled = false;
  } catch (e) {
    toast(e.message, true);
  } finally {
    state.busy = false;
  }
}
const copyTo = (category) => doAction('/api/move', { category }, (p, r) => `${p.name} 已拷贝到「${category}」${r.hasRaw ? '（含 ARW）' : ''}`);
const skip = () => doAction('/api/skip', {}, (p) => `${p.name} 已跳过（文件保留在原处）`);

async function undo() {
  if (state.busy) return;
  state.busy = true;
  try {
    const r = await api('/api/undo', { method: 'POST' });
    toast(`已撤销：${r.restored} ${r.label}`);
    await loadPhotos(true);
    const i = state.photos.findIndex((p) => p.name === r.restored);
    if (i >= 0) { state.index = i; showCurrent(); }
    const cfg = await api('/api/config');
    $('undoBtn').disabled = !cfg.canUndo;
  } catch (e) {
    toast(e.message, true);
  } finally {
    state.busy = false;
  }
}

function go(delta) {
  if (!state.photos.length) return;
  state.index = (state.index + delta + state.photos.length) % state.photos.length;
  showCurrent();
}

// ---------- 放大查看器 ----------
const zoom = {
  open: false, scale: 1, min: 0.1, max: 8, x: 0, y: 0, natW: 0, natH: 0, dragging: false, lastX: 0, lastY: 0,
  token: 0, previewUrl: '', previewW: 0, fullUrl: '', fullImg: null, idleTimer: 0,
};

/** 当前倍率下屏幕所需像素不超过预览图时，显示预览图（已按屏幕尺寸高质量缩放），否则显示原图 */
function zoomPickSource() {
  if (!zoom.fullImg) return;
  const dpr = window.devicePixelRatio || 1;
  const usePreview = zoom.previewW && zoom.scale * dpr * zoom.natW <= zoom.previewW * 1.02;
  const want = usePreview ? zoom.previewUrl : zoom.fullUrl;
  const img = $('zoomImg');
  if (img.getAttribute('src') !== want) img.src = want;
}
function zoomApply() {
  const img = $('zoomImg');
  img.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;
  $('zoomLevel').textContent = `${Math.round(zoom.scale * 100)}%`;
  // 交互期间提升为合成层，拖拽/缩放只走 GPU；停下 150ms 后取消，让浏览器按最终倍率高质量重绘
  img.classList.add('moving');
  clearTimeout(zoom.idleTimer);
  zoom.idleTimer = setTimeout(() => img.classList.remove('moving'), 150);
  zoomPickSource();
}
function zoomSetSize() {
  const img = $('zoomImg');
  img.style.width = zoom.natW + 'px';
  img.style.height = zoom.natH + 'px';
}
function zoomFit() {
  const c = $('zoomCanvas');
  if (!zoom.natW) return;
  zoom.scale = Math.min(c.clientWidth / zoom.natW, c.clientHeight / zoom.natH, 1);
  zoom.min = Math.min(zoom.scale, 0.1);
  zoom.x = (c.clientWidth - zoom.natW * zoom.scale) / 2;
  zoom.y = (c.clientHeight - zoom.natH * zoom.scale) / 2;
  zoomApply();
}
/** 以 (cx, cy) 画布坐标为中心缩放到 s */
function zoomTo(s, cx, cy) {
  const c = $('zoomCanvas');
  if (cx == null) { cx = c.clientWidth / 2; cy = c.clientHeight / 2; }
  s = Math.max(zoom.min, Math.min(zoom.max, s));
  const k = s / zoom.scale;
  zoom.x = cx - (cx - zoom.x) * k;
  zoom.y = cy - (cy - zoom.y) * k;
  zoom.scale = s;
  zoomApply();
}
function openZoom(e) {
  const p = current();
  if (!p) return;
  const token = ++zoom.token;
  zoom.open = true;
  const img = $('zoomImg');
  $('zoomer').hidden = false;
  $('zoomLoading').hidden = false;
  zoom.previewUrl = state.mainUrl || imgUrl(p.name, mainTargetWidth());
  zoom.previewW = 0;
  zoom.fullUrl = `/api/original?name=${encodeURIComponent(p.name)}`;
  zoom.fullImg = null;
  zoom.natW = zoom.natH = 0;
  img.onload = null;
  // 1) 先用主视图的大图占位（通常已解码在内存中，瞬间可见）
  loadDecoded(zoom.previewUrl).then((pv) => {
    if (token !== zoom.token) return;
    zoom.previewW = pv.naturalWidth;
    if (zoom.fullImg) { zoomPickSource(); return; }
    zoom.natW = pv.naturalWidth; zoom.natH = pv.naturalHeight;
    zoomSetSize();
    img.src = zoom.previewUrl;
    zoomFit();
  }).catch(() => {});
  // 2) 后台线程解码原图，完成后再接管，不阻塞交互
  const full = new Image();
  full.decoding = 'async';
  full.src = zoom.fullUrl;
  full.decode().then(() => {
    if (token !== zoom.token || !zoom.open) return;
    const ratio = zoom.natW ? full.naturalWidth / zoom.natW : 0;
    zoom.fullImg = full;
    zoom.natW = full.naturalWidth; zoom.natH = full.naturalHeight;
    zoomSetSize();
    $('zoomLoading').hidden = true;
    if (e && e.clientX != null) {
      // 双击时直接放到 1:1 并居中到点击位置
      const c = $('zoomCanvas');
      const mi = $('mainImg');
      const box = mi.getBoundingClientRect();
      const k = Math.min(box.width / mi.naturalWidth, box.height / mi.naturalHeight);
      const dw = mi.naturalWidth * k, dh = mi.naturalHeight * k;
      const left = box.left + (box.width - dw) / 2, top = box.top + (box.height - dh) / 2;
      const rx = Math.min(1, Math.max(0, (e.clientX - left) / dw)), ry = Math.min(1, Math.max(0, (e.clientY - top) / dh));
      zoom.scale = 1;
      zoom.min = Math.min(0.1, Math.min(c.clientWidth / zoom.natW, c.clientHeight / zoom.natH));
      zoom.x = c.clientWidth / 2 - rx * zoom.natW;
      zoom.y = c.clientHeight / 2 - ry * zoom.natH;
      zoomApply();
    } else if (ratio) {
      // 保持视觉大小不变
      zoom.scale = zoom.scale / ratio;
      zoom.min = Math.min(0.1, zoom.scale);
      zoomApply();
    } else {
      zoomFit();
    }
  }).catch(() => {
    if (token === zoom.token) $('zoomLoading').textContent = '原图加载失败';
  });
}
function closeZoom() {
  zoom.open = false;
  zoom.token++;
  zoom.natW = zoom.natH = 0;
  zoom.fullImg = null;
  $('zoomer').hidden = true;
  $('zoomLoading').textContent = '正在加载原图…';
  const img = $('zoomImg');
  img.onload = null;
  img.removeAttribute('src');
}
$('zoomBtn').onclick = () => openZoom();
$('mainImg').addEventListener('dblclick', openZoom);
$('zoomClose').onclick = closeZoom;
$('zoomIn').onclick = () => zoomTo(zoom.scale * 1.25);
$('zoomOut').onclick = () => zoomTo(zoom.scale / 1.25);
$('zoomFit').onclick = zoomFit;
$('zoom100').onclick = () => zoomTo(1);
$('zoomCanvas').addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = e.currentTarget.getBoundingClientRect();
  // 触控板捏合（浏览器会带 ctrlKey）或按住 ⌘/Ctrl 滚轮 → 缩放；限制单次步进避免跳跃
  if (e.ctrlKey || e.metaKey) {
    const delta = Math.max(-30, Math.min(30, e.deltaY));
    const factor = Math.exp(-delta * 0.01);
    zoomTo(zoom.scale * factor, e.clientX - rect.left, e.clientY - rect.top);
    return;
  }
  // 普通滚轮 / 双指滑动 → 平移画面
  zoom.x -= e.deltaX;
  zoom.y -= e.deltaY;
  zoomApply();
}, { passive: false });
$('zoomCanvas').addEventListener('pointerdown', (e) => {
  zoom.dragging = true; zoom.lastX = e.clientX; zoom.lastY = e.clientY;
  e.currentTarget.classList.add('dragging');
  e.currentTarget.setPointerCapture(e.pointerId);
});
$('zoomCanvas').addEventListener('pointermove', (e) => {
  if (!zoom.dragging) return;
  zoom.x += e.clientX - zoom.lastX; zoom.y += e.clientY - zoom.lastY;
  zoom.lastX = e.clientX; zoom.lastY = e.clientY;
  zoomApply();
});
const endDrag = (e) => { zoom.dragging = false; e.currentTarget.classList.remove('dragging'); };
$('zoomCanvas').addEventListener('pointerup', endDrag);
$('zoomCanvas').addEventListener('pointercancel', endDrag);
$('zoomCanvas').addEventListener('dblclick', (e) => {
  const rect = e.currentTarget.getBoundingClientRect();
  if (zoom.scale < 0.99) zoomTo(1, e.clientX - rect.left, e.clientY - rect.top);
  else zoomFit();
});

// ---------- 文件夹选择 ----------
async function pickFolder(which, btn) {
  if (btn) btn.disabled = true;
  try {
    const r = await api('/api/pick-folder', { method: 'POST', body: { which } });
    return r.dir;
  } catch (e) {
    toast(e.message, true);
    return null;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------- 事件绑定 ----------
$('loadBtn').onclick = async () => {
  try {
    state.config = await api('/api/config/source', { method: 'POST', body: { sourceDir: $('sourceInput').value } });
    $('baseDirInput').value = state.config.categoryBaseDir || '';
    await loadPhotos(false);
    toast(`已加载，${state.total} 张照片，待处理 ${state.total - state.done} 张`);
  } catch (e) { toast(e.message, true); }
};
$('sourceInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('loadBtn').click(); });
$('pickSourceBtn').onclick = async () => {
  toast('请在弹出的 Finder 窗口中选择文件夹');
  const dir = await pickFolder('source', $('pickSourceBtn'));
  if (!dir) return;
  $('sourceInput').value = dir;
  $('loadBtn').click();
};
$('pickBaseBtn').onclick = async () => {
  const dir = await pickFolder('base', $('pickBaseBtn'));
  if (!dir) return;
  $('baseDirInput').value = dir;
  $('saveBaseBtn').click();
};
$('pickCatDirBtn').onclick = async () => {
  const dir = await pickFolder('category', $('pickCatDirBtn'));
  if (dir) $('newCatDirInput').value = dir;
};
$('refreshBtn').onclick = () => loadPhotos(true);
$('filterSel').onchange = (e) => { setFilter(e.target.value); e.target.blur(); };
$('prevBtn').onclick = () => go(-1);
$('nextBtn').onclick = () => go(1);
$('skipBtn').onclick = skip;
$('undoBtn').onclick = undo;
$('settingsBtn').onclick = () => {
  const dirInput = $('newCatDirInput');
  if (!dirInput.value) dirInput.value = localStorage.getItem('photoClassifier.lastCatDir') || '';
  $('settingsDlg').showModal();
};

$('saveBaseBtn').onclick = async () => {
  try {
    state.config = await api('/api/config/category-base', { method: 'POST', body: { categoryBaseDir: $('baseDirInput').value } });
    toast('已保存分类默认创建位置');
  } catch (e) { toast(e.message, true); }
};
$('addCatBtn').onclick = async () => {
  const name = $('newCatInput').value.trim();
  if (!name) { toast('请输入分类名', true); return; }
  const baseDir = $('newCatDirInput').value.trim() || undefined;
  try {
    const i = state.config.categories.length;
    state.config = await api('/api/categories', { method: 'POST', body: { name, baseDir, color: PALETTE[i % PALETTE.length] } });
    // 保留创建位置，方便在同一目录下连续创建多个分类；只清空分类名并聚焦
    if (baseDir) localStorage.setItem('photoClassifier.lastCatDir', baseDir);
    $('newCatInput').value = '';
    $('newCatInput').focus();
    renderCategories();
    const cat = state.config.categories.find((c) => c.name === name);
    toast(`已创建 ${cat.dir} 及 ${cat.dir}.arw`);
  } catch (e) { toast(e.message, true); }
};
$('newCatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('addCatBtn').click(); } });
$('resetProgressBtn').onclick = async () => {
  if (!confirm('重置当前文件夹的处理记录？\n所有照片会重新显示为待处理，已拷贝出去的文件不受影响。')) return;
  await api('/api/reset-progress', { method: 'POST' });
  $('settingsDlg').close();
  await loadPhotos(false);
  toast('处理记录已重置');
};

// ---------- 按星级导出 ----------
const NEW_CAT = '__new__';
const exp = { min: 4, max: 5, previewTimer: 0 };

function renderStarPick(el, v) {
  el.querySelectorAll('span[data-v]').forEach((s) => s.classList.toggle('on', Number(s.dataset.v) <= v));
}
function renderExportRange() {
  renderStarPick($('minStarPick'), exp.min);
  renderStarPick($('maxStarPick'), exp.max);
  document.querySelectorAll('.star-presets .btn').forEach((b) => {
    b.classList.toggle('primary', Number(b.dataset.min) === exp.min && Number(b.dataset.max) === exp.max);
  });
  scheduleExportPreview();
}
function setExportRange(min, max) {
  exp.min = Math.max(1, Math.min(5, min));
  exp.max = Math.max(1, Math.min(5, max));
  if (exp.min > exp.max) [exp.min, exp.max] = [exp.max, exp.min];
  renderExportRange();
}
function scheduleExportPreview() {
  clearTimeout(exp.previewTimer);
  exp.previewTimer = setTimeout(loadExportPreview, 120);
}
async function loadExportPreview() {
  const box = $('exportPreview');
  try {
    const r = await api(`/api/export-by-stars/preview?minStars=${exp.min}&maxStars=${exp.max}`);
    if (!r.count) {
      box.className = 'export-preview none';
      box.textContent = `没有评分在 ${exp.min}★ 到 ${exp.max}★ 之间的照片`;
      $('exportRunBtn').disabled = true;
      return;
    }
    box.className = 'export-preview';
    const dist = [];
    for (let s = exp.max; s >= exp.min; s--) if (r.byStars[s]) dist.push(`<b>${'★'.repeat(s)}</b> ${r.byStars[s]} 张`);
    box.innerHTML = `共匹配 <b>${r.count}</b> 张照片（${exp.min === exp.max ? `${exp.min}★` : `${exp.min}★ 到 ${exp.max}★`}）<br>` +
      `<span class="dist">${dist.join('　')}</span>`;
    $('exportRunBtn').disabled = false;
  } catch (e) {
    box.className = 'export-preview none';
    box.textContent = e.message;
    $('exportRunBtn').disabled = true;
  }
}
function renderExportCatSelect() {
  const sel = $('exportCatSelect');
  const prev = sel.value;
  sel.innerHTML = '';
  const optNew = document.createElement('option');
  optNew.value = NEW_CAT;
  optNew.textContent = '＋ 新建一个分类…';
  sel.appendChild(optNew);
  (state.config.categories || []).forEach((c) => {
    const o = document.createElement('option');
    o.value = c.name;
    o.textContent = `${c.name}  (${c.dir})`;
    sel.appendChild(o);
  });
  sel.value = [...sel.options].some((o) => o.value === prev) ? prev : NEW_CAT;
  toggleExportNewCatRows();
}
function toggleExportNewCatRows() {
  const isNew = $('exportCatSelect').value === NEW_CAT;
  $('exportNewCatRow').hidden = !isNew;
  $('exportNewCatDirRow').hidden = !isNew;
}
function openExportDialog() {
  if (!state.config?.sourceDir) { toast('请先加载照片文件夹', true); return; }
  renderExportCatSelect();
  const dirInput = $('exportNewCatDirInput');
  if (!dirInput.value) dirInput.value = localStorage.getItem('photoClassifier.lastCatDir') || '';
  if (!$('exportNewCatInput').value) $('exportNewCatInput').value = suggestExportName();
  renderExportRange();
  $('exportDlg').showModal();
}
function suggestExportName() {
  if (exp.min === exp.max) return `精选 ${exp.min}星`;
  if (exp.max === 5) return `精选 ${exp.min}星以上`;
  return `精选 ${exp.min}-${exp.max}星`;
}
async function runExport() {
  const btn = $('exportRunBtn');
  const sel = $('exportCatSelect').value;
  const body = { minStars: exp.min, maxStars: exp.max, markProcessed: $('exportMarkChk').checked };
  if (sel === NEW_CAT) {
    const name = $('exportNewCatInput').value.trim();
    if (!name) { toast('请输入新分类名', true); $('exportNewCatInput').focus(); return; }
    const baseDir = $('exportNewCatDirInput').value.trim() || undefined;
    body.newCategory = { name, baseDir, color: PALETTE[state.config.categories.length % PALETTE.length] };
    if (baseDir) localStorage.setItem('photoClassifier.lastCatDir', baseDir);
  } else body.category = sel;

  btn.disabled = true;
  btn.textContent = '正在拷贝…';
  try {
    const r = await api('/api/export-by-stars', { method: 'POST', body });
    state.config = r.config;
    renderCategories();
    $('exportDlg').close();
    $('exportNewCatInput').value = '';
    const parts = [`已把 ${r.copied} 张照片拷贝到「${r.category.name}」`];
    if (r.withRaw) parts.push(`含 ${r.withRaw} 个 ARW`);
    if (r.skipped.length) parts.push(`${r.skipped.length} 张因目标已存在同名文件而跳过`);
    if (r.failed.length) parts.push(`${r.failed.length} 张失败`);
    toast(parts.join('，'), r.failed.length > 0);
    if (r.failed.length) console.warn('导出失败明细', r.failed);
    $('undoBtn').disabled = false;
    if (body.markProcessed) await loadPhotos(true);
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '开始拷贝';
  }
}
$('exportStarsBtn').onclick = openExportDialog;
$('exportRunBtn').onclick = runExport;
$('exportCatSelect').onchange = toggleExportNewCatRows;
$('exportPickDirBtn').onclick = async () => {
  const dir = await pickFolder('category', $('exportPickDirBtn'));
  if (dir) $('exportNewCatDirInput').value = dir;
};
$('minStarPick').addEventListener('click', (e) => {
  if (!e.target.dataset.v) return;
  const v = Number(e.target.dataset.v);
  setExportRange(v, Math.max(v, exp.max));
});
$('maxStarPick').addEventListener('click', (e) => {
  if (!e.target.dataset.v) return;
  const v = Number(e.target.dataset.v);
  setExportRange(Math.min(v, exp.min), v);
});
document.querySelectorAll('.star-presets .btn').forEach((b) => {
  b.addEventListener('click', () => {
    setExportRange(Number(b.dataset.min), Number(b.dataset.max));
    if ($('exportCatSelect').value === NEW_CAT) $('exportNewCatInput').value = suggestExportName();
  });
});
$('exportNewCatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runExport(); } });

document.addEventListener('keydown', (e) => {
  if ($('settingsDlg').open || $('exportDlg').open) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  const k = e.key.toLowerCase();
  if (zoom.open) {
    if (k === 'escape') closeZoom();
    else if (k === '+' || k === '=') zoomTo(zoom.scale * 1.25);
    else if (k === '-' || k === '_') zoomTo(zoom.scale / 1.25);
    else if (k === '0') zoomFit();
    else if (k === '1') zoomTo(1);
    else if (k === 'arrowleft' || k === 'arrowright') { closeZoom(); go(k === 'arrowleft' ? -1 : 1); openZoom(); }
    e.preventDefault();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (k === 'arrowleft') { e.preventDefault(); go(-1); }
  else if (k === 'arrowright') { e.preventDefault(); go(1); }
  else if (k === 'enter' || k === ' ') {
    e.preventDefault();
    if (state.config.defaultCategory) copyTo(state.config.defaultCategory);
    else toast('尚未设置默认分类', true);
  }
  else if (k === 'x' || k === 'delete' || k === 'backspace') { e.preventDefault(); skip(); }
  else if (k === 'z') undo();
  else if (k === 'a') toggleFocus();
  else if (k === '+' || k === '=') openZoom();
  else if (k === 'f') { const st = $('stage'); document.fullscreenElement ? document.exitFullscreen() : st.requestFullscreen(); }
  else if (/^[0-5]$/.test(k)) rate(Number(k));
  else {
    const ci = CAT_KEYS.indexOf(k);
    if (ci >= 0 && state.config.categories[ci]) copyTo(state.config.categories[ci].name);
  }
});

window.addEventListener('resize', () => {
  drawHistogram(state.lastHistogram);
  renderFocus();
  if (zoom.open) zoomApply();
  applyStripWidth(parseInt(getComputedStyle(document.documentElement).getPropertyValue('--strip-w'), 10) || STRIP_DEFAULT);
});

// ---------- 缩略图栏宽度拖拽 ----------
const STRIP_KEY = 'photoClassifier.stripWidth';
const STRIP_DEFAULT = 150, STRIP_MIN = 90;
function applyStripWidth(w) {
  const max = Math.max(STRIP_MIN, window.innerWidth - 320 - 480); // 给大图至少留 480px
  w = Math.round(Math.max(STRIP_MIN, Math.min(max, w)));
  document.documentElement.style.setProperty('--strip-w', w + 'px');
  return w;
}
(() => {
  const saved = parseInt(new URLSearchParams(location.search).get('strip') || localStorage.getItem(STRIP_KEY), 10);
  applyStripWidth(saved || STRIP_DEFAULT);
  const rs = $('stripResizer');
  let startX = 0, startW = 0;
  rs.addEventListener('pointerdown', (e) => {
    startX = e.clientX;
    startW = $('filmstrip').getBoundingClientRect().width;
    rs.classList.add('active');
    document.body.classList.add('resizing');
    rs.setPointerCapture(e.pointerId);
  });
  rs.addEventListener('pointermove', (e) => {
    if (!rs.classList.contains('active')) return;
    applyStripWidth(startW + (e.clientX - startX));
  });
  const stop = () => {
    if (!rs.classList.contains('active')) return;
    rs.classList.remove('active');
    document.body.classList.remove('resizing');
    localStorage.setItem(STRIP_KEY, String(Math.round($('filmstrip').getBoundingClientRect().width)));
    updateFilmstripActive();
  };
  rs.addEventListener('pointerup', stop);
  rs.addEventListener('pointercancel', stop);
  rs.addEventListener('dblclick', () => {
    applyStripWidth(STRIP_DEFAULT);
    localStorage.setItem(STRIP_KEY, String(STRIP_DEFAULT));
  });
})();

// ---------- 启动 ----------
if (/Electron/i.test(navigator.userAgent)) document.body.classList.add('electron');
(async () => {
  await loadConfig();
  if (state.config.sourceDir) await loadPhotos(false);
})();
