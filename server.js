'use strict';

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const express = require('express');
const sharp = require('sharp');
const exifReader = require('exif-reader');

const PORT = Number(process.env.PORT) || 3456;
const DATA_DIR = process.env.PHOTO_CLASSIFIER_DATA_DIR || path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const RATINGS_FILE = path.join(DATA_DIR, 'ratings.json');
const PROCESSED_FILE = path.join(DATA_DIR, 'processed.json');
const CACHE_DIR = process.env.PHOTO_CLASSIFIER_CACHE_DIR || path.join(os.tmpdir(), 'photo-classifier-cache');

const JPG_EXTS = new Set(['.jpg', '.jpeg']);
const RAW_EXTS = new Set(['.arw']);
const RAW_SUFFIX = '.arw';

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(CACHE_DIR, { recursive: true });

// ---------- 持久化 ----------
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

let config = Object.assign(
  { sourceDir: '', categoryBaseDir: '', categories: [], defaultCategory: '' },
  readJson(CONFIG_FILE, {})
);
/**
 * 评分（按源文件夹分组）：ratings[sourceDir][fileName(小写)] = 1..5
 * 旧版本为扁平结构 { fileName: n }，首次加载时归并到当时配置的源文件夹名下
 */
let ratings = readJson(RATINGS_FILE, {});
if (Object.values(ratings).some((v) => typeof v === 'number')) {
  const legacy = {};
  for (const [k, v] of Object.entries(ratings)) if (typeof v === 'number') legacy[k] = v;
  ratings = config.sourceDir ? { [config.sourceDir]: legacy } : {};
  writeJson(RATINGS_FILE, ratings);
}
function ratingsMap(src) {
  if (!ratings[src]) ratings[src] = {};
  return ratings[src];
}
function getRating(src, name) {
  return ratingsMap(src)[name.toLowerCase()] || 0;
}
/**
 * 已处理记录（按源文件夹分组），原文件始终保留在源文件夹中：
 * processed[sourceDir][fileName] = { action: 'copy'|'skip', category, copies: [absPath...], at }
 */
let processed = readJson(PROCESSED_FILE, {});
const undoStack = [];

const saveConfig = () => writeJson(CONFIG_FILE, config);
const saveRatings = () => writeJson(RATINGS_FILE, ratings);
const saveProcessed = () => writeJson(PROCESSED_FILE, processed);

// ---------- 工具函数 ----------
function expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return path.resolve(p);
}

function safeName(name) {
  if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw httpError(400, '非法文件名');
  }
  return name;
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** 拷贝文件（保留原文件），目标已存在则报错，不覆盖 */
async function copyFile(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  if (await exists(to)) throw httpError(409, `目标已存在同名文件: ${to}`);
  await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
  // 保留原始修改时间
  try {
    const st = await fsp.stat(from);
    await fsp.utimes(to, st.atime, st.mtime);
  } catch { /* ignore */ }
}

/** 找到与 jpg 同名的 RAW 文件（大小写不敏感） */
async function findRaw(dir, jpgName) {
  const base = path.parse(jpgName).name;
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return null;
  }
  const hit = entries.find(
    (f) => RAW_EXTS.has(path.extname(f).toLowerCase()) && path.parse(f).name.toLowerCase() === base.toLowerCase()
  );
  return hit ? path.join(dir, hit) : null;
}

function categoryDirs(cat) {
  return { jpgDir: cat.dir, rawDir: cat.dir + RAW_SUFFIX };
}

function requireSource() {
  if (!config.sourceDir) throw httpError(400, '请先指定照片文件夹');
  return config.sourceDir;
}

function processedMap() {
  const src = requireSource();
  if (!processed[src]) processed[src] = {};
  return processed[src];
}

/** 拷贝 jpg + raw 到分类文件夹，原文件保留 */
async function copyPair(jpgName, cat) {
  const src = requireSource();
  const from = path.join(src, jpgName);
  if (!(await exists(from))) throw httpError(404, '照片不存在: ' + jpgName);
  const rawFrom = await findRaw(src, jpgName);
  const { jpgDir, rawDir } = categoryDirs(cat);

  const to = path.join(jpgDir, jpgName);
  await copyFile(from, to);
  let rawTo = null;
  if (rawFrom) {
    rawTo = path.join(rawDir, path.basename(rawFrom));
    try {
      await copyFile(rawFrom, rawTo);
    } catch (e) {
      await fsp.unlink(to).catch(() => {});
      throw e;
    }
  }
  const copies = [to, rawTo].filter(Boolean);
  const rec = { action: 'copy', category: cat.name, copies, at: Date.now() };
  const pm = processedMap();
  const prev = pm[jpgName] || null;
  pm[jpgName] = rec;
  saveProcessed();
  undoStack.push({ label: `拷贝到「${cat.name}」`, jpgName, src, rec, prev });
  if (undoStack.length > 200) undoStack.shift();
  return { to, rawTo, hasRaw: !!rawFrom };
}

// ---------- 图像处理 ----------
function cacheKey(filePath, stat, w) {
  return crypto.createHash('md5').update(`${filePath}|${stat.mtimeMs}|${stat.size}|${w}`).digest('hex');
}

// 限制同时进行的图像解码数，避免首屏几十张 24MP 原图同时解码把 CPU/内存打满
const MAX_DECODE = Math.max(2, Math.min(4, os.cpus().length - 1));
let decoding = 0;
const decodeQueue = [];
function withDecodeSlot(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      decoding++;
      fn().then(resolve, reject).finally(() => {
        decoding--;
        const next = decodeQueue.shift();
        if (next) next();
      });
    };
    decoding < MAX_DECODE ? run() : decodeQueue.push(run);
  });
}

const inflight = new Map(); // cacheFile -> Promise，避免同一张图并发重复生成

async function getResized(filePath, w) {
  const stat = await fsp.stat(filePath);
  const key = cacheKey(filePath, stat, w);
  const cacheFile = path.join(CACHE_DIR, key + '.jpg');
  if (await exists(cacheFile)) return cacheFile;
  if (inflight.has(cacheFile)) return inflight.get(cacheFile);
  const job = withDecodeSlot(async () => {
    const tmp = cacheFile + '.' + process.pid + '.tmp';
    // 小尺寸缩略图优先用大图缓存作为源，避免重复解码原图
    let src = filePath;
    if (w <= 400) {
      const bigKey = path.join(CACHE_DIR, cacheKey(filePath, stat, 1800) + '.jpg');
      if (await exists(bigKey)) src = bigKey;
    }
    // sharp 对 JPEG 自动 shrink-on-load（按 1/2 1/4 1/8 解码），缩略图几乎不需要完整解码
    await sharp(src, { failOn: 'none', sequentialRead: true })
      .rotate()
      .resize({ width: w, height: w, fit: 'inside', withoutEnlargement: true, kernel: w <= 400 ? 'lanczos2' : 'lanczos3' })
      .jpeg({ quality: w > 600 ? 86 : 75, mozjpeg: w > 600 })
      .toFile(tmp);
    await fsp.rename(tmp, cacheFile);
    return cacheFile;
  }).finally(() => inflight.delete(cacheFile));
  inflight.set(cacheFile, job);
  return job;
}

/** 直方图：R/G/B/亮度 各 256 bins，并给出曝光统计（基于 1800px 预览缓存计算，避免重复解码原图） */
async function computeHistogram(filePath) {
  let src = filePath;
  try { src = await getResized(filePath, 1800); } catch { /* 回退原图 */ }
  const { data, info } = await sharp(src, { failOn: 'none', sequentialRead: true })
    .rotate()
    .resize({ width: 400, fit: 'inside' })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });

  const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256), l = new Uint32Array(256);
  const n = info.width * info.height;
  let sum = 0, clipLow = 0, clipHigh = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const R = data[i], G = data[i + 1], B = data[i + 2];
    r[R]++; g[G]++; b[B]++;
    const L = Math.round(0.2126 * R + 0.7152 * G + 0.0722 * B);
    l[L]++;
    sum += L;
    if (L <= 2) clipLow++;
    if (L >= 253) clipHigh++;
  }
  const mean = sum / n;
  let acc = 0, median = 0;
  for (let i = 0; i < 256; i++) {
    acc += l[i];
    if (acc >= n / 2) { median = i; break; }
  }
  let verdict = '曝光正常';
  if (clipHigh / n > 0.04) verdict = '高光溢出较多';
  else if (clipLow / n > 0.08) verdict = '暗部死黑较多';
  else if (mean < 70) verdict = '偏暗';
  else if (mean > 185) verdict = '偏亮';

  return {
    r: Array.from(r), g: Array.from(g), b: Array.from(b), l: Array.from(l),
    stats: {
      mean: +mean.toFixed(1),
      median,
      clipLowPct: +((clipLow / n) * 100).toFixed(2),
      clipHighPct: +((clipHigh / n) * 100).toFixed(2),
      verdict,
    },
  };
}

// ---------- EXIF ----------
const ENUM = {
  ExposureProgram: { 0: '未定义', 1: '手动 M', 2: '程序自动 P', 3: '光圈优先 A', 4: '快门优先 S', 5: '创意程序', 6: '动作程序', 7: '人像模式', 8: '风景模式' },
  MeteringMode: { 0: '未知', 1: '平均', 2: '中央重点', 3: '点测光', 4: '多点', 5: '多区域评价', 6: '局部', 255: '其他' },
  WhiteBalance: { 0: '自动', 1: '手动' },
  ExposureMode: { 0: '自动曝光', 1: '手动曝光', 2: '自动包围' },
  SceneCaptureType: { 0: '标准', 1: '风景', 2: '人像', 3: '夜景' },
  Contrast: { 0: '标准', 1: '柔和', 2: '强烈' },
  Saturation: { 0: '标准', 1: '低', 2: '高' },
  Sharpness: { 0: '标准', 1: '柔和', 2: '锐利' },
  ColorSpace: { 1: 'sRGB', 2: 'Adobe RGB', 65535: '未校准' },
  LightSource: { 0: '未知', 1: '日光', 2: '荧光灯', 3: '钨丝灯', 4: '闪光灯', 9: '晴天', 10: '阴天', 11: '阴影', 17: '标准光 A', 18: '标准光 B', 19: '标准光 C', 20: 'D55', 21: 'D65', 22: 'D75' },
};
const pick = (table, v) => (v == null ? null : table[v] ?? String(v));

function fmtExposure(t) {
  if (!t) return null;
  if (t >= 1) return `${+t.toFixed(1)}s`;
  return `1/${Math.round(1 / t)}s`;
}
function fmtFlash(v) {
  if (v == null) return null;
  const fired = v & 1;
  const modeBits = (v >> 3) & 3;
  const mode = modeBits === 2 ? '强制关闭' : modeBits === 1 ? '强制开启' : modeBits === 3 ? '自动' : '';
  const redEye = v & 64 ? '，防红眼' : '';
  return `${fired ? '已闪光' : '未闪光'}${mode ? `（${mode}）` : ''}${redEye}`;
}
function fmtGps(gps) {
  if (!gps || !gps.GPSLatitude || !gps.GPSLongitude) return null;
  const toDec = (arr, ref) => {
    const [d = 0, m = 0, s = 0] = arr;
    const v = d + m / 60 + s / 3600;
    return ref === 'S' || ref === 'W' ? -v : v;
  };
  const lat = toDec(gps.GPSLatitude, gps.GPSLatitudeRef);
  const lng = toDec(gps.GPSLongitude, gps.GPSLongitudeRef);
  const alt = gps.GPSAltitude != null ? `${gps.GPSAltitudeRef === 1 ? '-' : ''}${Math.round(gps.GPSAltitude)}m` : null;
  return { lat: +lat.toFixed(6), lng: +lng.toFixed(6), alt, mapUrl: `https://maps.apple.com/?ll=${lat},${lng}&q=${lat},${lng}` };
}
function fmtBytes(n) {
  if (n == null) return null;
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}
function aspect(w, h) {
  if (!w || !h) return null;
  const r = w / h;
  const known = [[3 / 2, '3:2'], [2 / 3, '2:3'], [4 / 3, '4:3'], [3 / 4, '3:4'], [16 / 9, '16:9'], [9 / 16, '9:16'], [1, '1:1'], [65 / 24, '65:24']];
  const hit = known.find(([v]) => Math.abs(v - r) < 0.01);
  return hit ? hit[1] : r.toFixed(2);
}

async function readExif(filePath) {
  const out = {};
  try {
    const st = await fsp.stat(filePath);
    out.fileSize = fmtBytes(st.size);
    out.fileMtime = st.mtime.toLocaleString('zh-CN');
    const meta = await sharp(filePath, { failOn: 'none' }).metadata();
    out.width = meta.width;
    out.height = meta.height;
    out.megapixels = meta.width && meta.height ? `${((meta.width * meta.height) / 1e6).toFixed(1)} MP` : null;
    out.aspect = aspect(meta.width, meta.height);
    out.orientation = meta.orientation || null;
    out.dpi = meta.density || null;
    out.hasIcc = !!meta.icc;
    out.chromaSubsampling = meta.chromaSubsampling || null;
    if (!meta.exif) return out;

    const ex = exifReader(meta.exif);
    const img = ex.Image || {};
    const ph = ex.Photo || {};
    const gps = ex.GPSInfo || {};

    out.camera = [img.Make, img.Model].filter(Boolean).join(' ').trim() || null;
    out.lens = ph.LensModel || null;
    out.lensMake = ph.LensMake || null;
    out.software = img.Software || null;
    out.artist = img.Artist || null;
    out.copyright = img.Copyright || null;
    out.bodySerial = ph.BodySerialNumber || null;
    out.lensSerial = ph.LensSerialNumber || null;

    out.exposure = fmtExposure(ph.ExposureTime);
    out.aperture = ph.FNumber ? `f/${ph.FNumber}` : null;
    out.iso = ph.ISOSpeedRatings || ph.PhotographicSensitivity || null;
    out.focal = ph.FocalLength ? `${ph.FocalLength}mm` : null;
    out.focal35 = ph.FocalLengthIn35mmFilm ? `${ph.FocalLengthIn35mmFilm}mm` : null;
    out.ev = typeof ph.ExposureBiasValue === 'number' ? `${ph.ExposureBiasValue >= 0 ? '+' : ''}${ph.ExposureBiasValue.toFixed(1)} EV` : null;
    out.maxAperture = ph.MaxApertureValue ? `f/${Math.pow(2, ph.MaxApertureValue / 2).toFixed(1)}` : null;
    out.exposureProgram = pick(ENUM.ExposureProgram, ph.ExposureProgram);
    out.exposureMode = pick(ENUM.ExposureMode, ph.ExposureMode);
    out.metering = pick(ENUM.MeteringMode, ph.MeteringMode);
    out.whiteBalance = pick(ENUM.WhiteBalance, ph.WhiteBalance);
    out.lightSource = pick(ENUM.LightSource, ph.LightSource);
    out.flash = fmtFlash(ph.Flash);
    out.sceneType = pick(ENUM.SceneCaptureType, ph.SceneCaptureType);
    out.contrast = pick(ENUM.Contrast, ph.Contrast);
    out.saturation = pick(ENUM.Saturation, ph.Saturation);
    out.sharpness = pick(ENUM.Sharpness, ph.Sharpness);
    out.digitalZoom = ph.DigitalZoomRatio && ph.DigitalZoomRatio !== 1 ? `${ph.DigitalZoomRatio}x` : null;
    out.colorSpace = pick(ENUM.ColorSpace, ph.ColorSpace);
    out.brightness = typeof ph.BrightnessValue === 'number' ? `${ph.BrightnessValue.toFixed(2)} EV` : null;
    out.subjectDistance = ph.SubjectDistance ? `${ph.SubjectDistance}m` : null;

    const dt = ph.DateTimeOriginal || img.DateTime;
    out.datetime = dt ? new Date(dt).toLocaleString('zh-CN') : null;
    out.timezone = ph.OffsetTimeOriginal || null;
    out.subsec = ph.SubSecTimeOriginal || null;
    out.gps = fmtGps(gps);
    out.rating = img.Rating ?? null;
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

// ---------- 系统文件夹选择 ----------
/** Electron 环境下由主进程注入原生 dialog 实现；否则回退到 osascript */
let folderPicker = null;
function setFolderPicker(fn) { folderPicker = fn; }

async function pickFolder(prompt, defaultDir) {
  if (folderPicker) return folderPicker(prompt, defaultDir);
  if (process.platform !== 'darwin') throw httpError(501, '当前仅支持 macOS 原生文件夹选择，请手动输入路径');
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const def = defaultDir && fs.existsSync(defaultDir) ? ` default location POSIX file "${esc(defaultDir)}"` : '';
  const script = [
    'with timeout of 3600 seconds',
    `  set theFolder to choose folder with prompt "${esc(prompt)}"${def}`,
    'end timeout',
    'return POSIX path of theFolder',
  ].join('\n');
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: 60 * 60 * 1000 }, (err, stdout, stderr) => {
      if (err) {
        if (err.killed || err.signal || /-128|User canceled|用户已取消/i.test(stderr || err.message)) return resolve(null);
        return reject(httpError(500, '打开文件夹选择框失败: ' + (stderr || err.message).trim()));
      }
      resolve(stdout.trim().replace(/\/$/, '') || null);
    });
  });
}

// ---------- 路由 ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

app.post('/api/pick-folder', wrap(async (req, res) => {
  const which = ['base', 'category'].includes(req.body.which) ? req.body.which : 'source';
  const prompts = { source: '选择要筛选的照片文件夹', base: '选择分类文件夹的默认创建位置', category: '选择此分类文件夹的创建位置' };
  const dir = await pickFolder(prompts[which], which === 'source' ? config.sourceDir : config.categoryBaseDir || config.sourceDir);
  res.json({ dir });
}));

app.get('/api/config', (req, res) => {
  res.json({ ...config, canUndo: undoStack.length > 0, home: os.homedir() });
});

app.post('/api/config/source', wrap(async (req, res) => {
  const dir = expandHome(String(req.body.sourceDir || '').trim());
  if (!dir || !(await exists(dir))) throw httpError(400, '文件夹不存在: ' + dir);
  const st = await fsp.stat(dir);
  if (!st.isDirectory()) throw httpError(400, '不是文件夹: ' + dir);
  config.sourceDir = dir;
  if (!config.categoryBaseDir) config.categoryBaseDir = dir;
  saveConfig();
  res.json(config);
}));

app.post('/api/config/category-base', wrap(async (req, res) => {
  const dir = expandHome(String(req.body.categoryBaseDir || '').trim());
  if (!dir) throw httpError(400, '请输入路径');
  await fsp.mkdir(dir, { recursive: true });
  config.categoryBaseDir = dir;
  saveConfig();
  res.json(config);
}));

/** 新建分类：在 baseDir（可选，默认分类根目录）下创建 <name> 与 <name>.arw */
app.post('/api/categories', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name || /[\/\\:*?"<>|]/.test(name)) throw httpError(400, '分类名不能为空且不能包含 / \\ : * ? " < > |');
  if (config.categories.some((c) => c.name === name)) throw httpError(409, '分类已存在');
  const base = req.body.baseDir ? expandHome(String(req.body.baseDir).trim()) : config.categoryBaseDir || requireSource();
  const dir = path.join(base, name);
  const { jpgDir, rawDir } = categoryDirs({ dir });
  await fsp.mkdir(jpgDir, { recursive: true });
  await fsp.mkdir(rawDir, { recursive: true });
  config.categories.push({ name, dir, color: req.body.color || null });
  if (!config.defaultCategory) config.defaultCategory = name;
  saveConfig();
  res.json(config);
}));

app.delete('/api/categories/:name', (req, res) => {
  config.categories = config.categories.filter((c) => c.name !== req.params.name);
  if (config.defaultCategory === req.params.name) config.defaultCategory = config.categories[0]?.name || '';
  saveConfig();
  res.json(config);
});

app.post('/api/categories/default', (req, res) => {
  const name = String(req.body.name || '');
  if (name && !config.categories.some((c) => c.name === name)) return res.status(404).json({ error: '分类不存在' });
  config.defaultCategory = name;
  saveConfig();
  res.json(config);
});

/** 照片列表（默认只返回未处理的；all=1 返回全部并带处理状态） */
app.get('/api/photos', wrap(async (req, res) => {
  const src = requireSource();
  const showAll = req.query.all === '1';
  const pm = processedMap();
  const entries = await fsp.readdir(src, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile());
  const rawSet = new Set(
    files.filter((e) => RAW_EXTS.has(path.extname(e.name).toLowerCase())).map((e) => path.parse(e.name).name.toLowerCase())
  );
  const photos = [];
  let total = 0, done = 0;
  for (const e of files) {
    if (!JPG_EXTS.has(path.extname(e.name).toLowerCase())) continue;
    total++;
    const rec = pm[e.name] || null;
    if (rec) done++;
    if (rec && !showAll) continue;
    const st = await fsp.stat(path.join(src, e.name));
    photos.push({
      name: e.name,
      size: st.size,
      mtime: st.mtimeMs,
      hasRaw: rawSet.has(path.parse(e.name).name.toLowerCase()),
      rating: getRating(src, e.name),
      processed: rec ? { action: rec.action, category: rec.category || null } : null,
    });
  }
  photos.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  res.json({ sourceDir: src, photos, total, done });
}));

app.get('/api/image', wrap(async (req, res) => {
  const name = safeName(req.query.name);
  const w = Math.min(Math.max(parseInt(req.query.w, 10) || 1800, 64), 4000);
  const file = path.join(requireSource(), name);
  if (!(await exists(file))) throw httpError(404, '照片不存在');
  const out = await getResized(file, w);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(out);
}));

/** 原图（用于放大查看） */
app.get('/api/original', wrap(async (req, res) => {
  const name = safeName(req.query.name);
  const file = path.join(requireSource(), name);
  if (!(await exists(file))) throw httpError(404, '照片不存在');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(file);
}));

app.get('/api/info', wrap(async (req, res) => {
  const name = safeName(req.query.name);
  const file = path.join(requireSource(), name);
  if (!(await exists(file))) throw httpError(404, '照片不存在');
  const [exif, histogram, raw] = await Promise.all([readExif(file), computeHistogram(file), findRaw(requireSource(), name)]);
  res.json({
    name, exif, histogram,
    rawName: raw ? path.basename(raw) : null,
    rating: getRating(requireSource(), name),
    processed: processedMap()[name] || null,
  });
}));

app.post('/api/rate', (req, res) => {
  const name = safeName(req.body.name);
  const src = requireSource();
  const r = Math.max(0, Math.min(5, parseInt(req.body.rating, 10) || 0));
  const k = name.toLowerCase();
  const m = ratingsMap(src);
  if (r === 0) delete m[k];
  else m[k] = r;
  saveRatings();
  res.json({ name, rating: r });
});

/** 拷贝到分类（原文件保留） */
app.post('/api/move', wrap(async (req, res) => {
  const name = safeName(req.body.name);
  const cat = config.categories.find((c) => c.name === req.body.category);
  if (!cat) throw httpError(404, '分类不存在');
  const r = await copyPair(name, cat);
  res.json({ ok: true, ...r });
}));

/** 跳过 = 仅标记，不动任何文件 */
app.post('/api/skip', wrap(async (req, res) => {
  const name = safeName(req.body.name);
  const src = requireSource();
  if (!(await exists(path.join(src, name)))) throw httpError(404, '照片不存在: ' + name);
  const pm = processedMap();
  const prev = pm[name] || null;
  const rec = { action: 'skip', copies: [], at: Date.now() };
  pm[name] = rec;
  saveProcessed();
  undoStack.push({ label: '跳过', jpgName: name, src, rec, prev });
  if (undoStack.length > 200) undoStack.shift();
  res.json({ ok: true });
}));

/** 撤销：删除刚拷贝出的副本、恢复之前的处理状态 */
app.post('/api/undo', wrap(async (req, res) => {
  const op = undoStack.pop();
  if (!op) throw httpError(400, '没有可撤销的操作');
  for (const f of op.rec.copies || []) await fsp.unlink(f).catch(() => {});
  if (!processed[op.src]) processed[op.src] = {};
  if (op.prev) processed[op.src][op.jpgName] = op.prev;
  else delete processed[op.src][op.jpgName];
  saveProcessed();
  res.json({ ok: true, restored: op.jpgName, label: op.label });
}));

/** 重置当前文件夹的处理记录（不删除任何文件） */
app.post('/api/reset-progress', (req, res) => {
  const src = requireSource();
  processed[src] = {};
  saveProcessed();
  undoStack.length = 0;
  res.json({ ok: true });
});

app.get('/api/history', (req, res) => {
  res.json(undoStack.slice(-20).reverse().map(({ label, jpgName, rec }) => ({ label, jpgName, at: rec.at })));
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || String(err) });
});

/** 启动 HTTP 服务；port=0 表示随机端口。返回 { port, server } */
function start(port = PORT) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      console.log(`PhotoClassifier 已启动: http://127.0.0.1:${actual}`);
      console.log(`配置文件: ${CONFIG_FILE}`);
      resolve({ port: actual, server });
    });
    server.on('error', reject);
  });
}

module.exports = { start, setFolderPicker, DATA_DIR, CACHE_DIR };

if (require.main === module) {
  start().catch((e) => { console.error(e); process.exit(1); });
}
