// 生成应用图标：build/icon.png (1024x1024) 与 build/icon.icns (macOS)
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const buildDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(buildDir, { recursive: true });

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2b3140"/>
      <stop offset="1" stop-color="#121417"/>
    </linearGradient>
    <linearGradient id="lens" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#79a6ff"/>
      <stop offset="1" stop-color="#2f5fd1"/>
    </linearGradient>
  </defs>
  <rect x="64" y="64" width="896" height="896" rx="200" fill="url(#bg)"/>
  <rect x="180" y="330" width="664" height="440" rx="70" fill="#1b1e23" stroke="#3a4150" stroke-width="14"/>
  <rect x="380" y="250" width="264" height="120" rx="40" fill="#1b1e23" stroke="#3a4150" stroke-width="14"/>
  <circle cx="512" cy="550" r="170" fill="url(#lens)"/>
  <circle cx="512" cy="550" r="110" fill="#0b0c0e"/>
  <circle cx="470" cy="505" r="34" fill="#ffffff" opacity="0.55"/>
  <rect x="690" y="400" width="80" height="44" rx="12" fill="#f5b301"/>
  <path d="M250 820 L290 860 L370 780" stroke="#7ee787" stroke-width="40" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

(async () => {
  const png = path.join(buildDir, 'icon.png');
  await sharp(Buffer.from(svg)).png().toFile(png);
  console.log('生成', png);

  if (process.platform === 'darwin') {
    const iconset = path.join(buildDir, 'icon.iconset');
    fs.rmSync(iconset, { recursive: true, force: true });
    fs.mkdirSync(iconset);
    const sizes = [16, 32, 64, 128, 256, 512, 1024];
    for (const s of sizes) {
      await sharp(png).resize(s, s).png().toFile(path.join(iconset, `icon_${s}x${s}.png`));
      if (s <= 512) await sharp(png).resize(s * 2, s * 2).png().toFile(path.join(iconset, `icon_${s}x${s}@2x.png`));
    }
    execSync(`iconutil -c icns "${iconset}" -o "${path.join(buildDir, 'icon.icns')}"`);
    fs.rmSync(iconset, { recursive: true, force: true });
    console.log('生成', path.join(buildDir, 'icon.icns'));
  }
})();
