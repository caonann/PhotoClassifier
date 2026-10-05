// 生成接近真实相机尺寸的测试照片（默认 6000x4000，每张约 2-4MB），用于性能测试
// 用法：node scripts/make-big-samples.js <目录> [数量]
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const dir = process.argv[2] || '/tmp/photo_big';
const count = parseInt(process.argv[3], 10) || 60;
fs.mkdirSync(dir, { recursive: true });

(async () => {
  const W = 6000, H = 4000;
  for (let i = 1; i <= count; i++) {
    const name = `DSC${String(i).padStart(5, '0')}`;
    const hue = (i * 37) % 360;
    const portrait = i % 5 === 0;
    const svg = `<svg width="${portrait ? H : W}" height="${portrait ? W : H}">
      <defs><radialGradient id="g"><stop offset="0" stop-color="hsl(${hue},70%,70%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},60%,20%)"/></radialGradient></defs>
      <rect width="100%" height="100%" fill="url(#g)"/>
      ${Array.from({ length: 40 }, (_, k) => `<circle cx="${(k * 997) % (portrait ? H : W)}" cy="${(k * 613) % (portrait ? W : H)}" r="${80 + (k * 53) % 400}" fill="hsl(${(hue + k * 17) % 360},80%,${30 + (k % 5) * 10}%)" opacity="0.6"/>`).join('')}
      <text x="200" y="${(portrait ? W : H) - 300}" font-size="400" fill="#fff" font-family="sans-serif">${name}</text></svg>`;
    await sharp(Buffer.from(svg)).jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
      .withExif({ IFD0: { Make: 'SONY', Model: 'ILCE-7M4' }, IFD2: { ExposureTime: '1/250', FNumber: '2.8', ISOSpeedRatings: '400', FocalLength: '35', DateTimeOriginal: `2026:10:01 ${String(10 + (i % 10)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00` } })
      .toFile(path.join(dir, name + '.JPG'));
    fs.writeFileSync(path.join(dir, name + '.ARW'), Buffer.alloc(4096, 1));
    if (i % 10 === 0) console.log(`${i}/${count}`);
  }
  const total = fs.readdirSync(dir).filter((f) => f.endsWith('.JPG')).reduce((s, f) => s + fs.statSync(path.join(dir, f)).size, 0);
  console.log(`完成：${count} 张，JPG 总计 ${(total / 1024 / 1024).toFixed(0)} MB，目录 ${dir}`);
})();
