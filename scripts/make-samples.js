// 生成一批测试照片（jpg + 同名 arw 占位文件，带 EXIF），用于本地验证
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const dir = process.argv[2] || path.join(__dirname, 'sample_photos');
fs.mkdirSync(dir, { recursive: true });

(async () => {
  const specs = [
    { name: 'DSC00001', bg: { r: 30, g: 60, b: 120 } },
    { name: 'DSC00002', bg: { r: 240, g: 240, b: 230 } },
    { name: 'DSC00003', bg: { r: 10, g: 10, b: 12 } },
    { name: 'DSC00004', bg: { r: 120, g: 160, b: 90 } },
    { name: 'DSC00005', bg: { r: 200, g: 120, b: 60 } },
  ];
  for (const s of specs) {
    const svg = `<svg width="1600" height="1067"><rect width="100%" height="100%" fill="rgb(${s.bg.r},${s.bg.g},${s.bg.b})"/>
      <circle cx="800" cy="500" r="260" fill="rgba(255,255,255,0.35)"/>
      <text x="60" y="1000" font-size="90" fill="#fff" font-family="sans-serif">${s.name}</text></svg>`;
    await sharp(Buffer.from(svg))
      .jpeg({ quality: 85 })
      .withExif({
        IFD0: { Make: 'SONY', Model: 'ILCE-7M4', Software: 'ILCE-7M4 v2.00', Artist: 'Test', DateTime: '2026:10:01 10:20:30' },
        IFD2: {
          DateTimeOriginal: '2026:10:01 10:20:30', OffsetTimeOriginal: '+09:00',
          ExposureTime: '1/250', FNumber: '2.8', ISOSpeedRatings: '400', FocalLength: '35', FocalLengthIn35mmFilm: '35',
          ExposureBiasValue: '-0.3', ExposureProgram: '3', MeteringMode: '5', WhiteBalance: '0', Flash: '16',
          LensModel: 'FE 35mm F1.4 GM', LensMake: 'SONY', ColorSpace: '1', SceneCaptureType: '0',
        },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '35/1 41/1 2235/100', GPSLongitudeRef: 'E', GPSLongitude: '139/1 41/1 3012/100', GPSAltitude: '40/1' },
      })
      .toFile(path.join(dir, s.name + '.JPG'));
    if (s.name !== 'DSC00004') fs.writeFileSync(path.join(dir, s.name + '.ARW'), Buffer.alloc(1024, 1));
  }
  console.log('测试照片已生成到', dir);
})();
