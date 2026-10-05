#!/usr/bin/env bash
# PhotoClassifier 一键打包脚本（macOS）
# 用法：
#   ./build.sh            打包 arm64 DMG + ZIP 到 dist/
#   ./build.sh dir        只生成 dist/mac-arm64/PhotoClassifier.app（快速验证）
#   ./build.sh universal  打包 Intel + Apple Silicon 通用包
#   ./build.sh install    打包后把 .app 复制到 /Applications
set -euo pipefail
cd "$(dirname "$0")"

MODE="${1:-dmg}"

# Electron 与 sharp 预编译二进制走国内镜像，避免下载失败；若有代理可自行去掉
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"
export npm_config_sharp_binary_host="${npm_config_sharp_binary_host:-https://npmmirror.com/mirrors/sharp}"
export npm_config_sharp_libvips_binary_host="${npm_config_sharp_libvips_binary_host:-https://npmmirror.com/mirrors/sharp-libvips}"
# 未签名应用，跳过 notarize / 签名流程
export CSC_IDENTITY_AUTO_DISCOVERY=false

echo "▶ 检查依赖"
command -v node >/dev/null || { echo "未找到 node，请先安装 Node.js 18+"; exit 1; }
if [ ! -d node_modules/electron ] || [ ! -d node_modules/electron-builder ]; then
  echo "▶ 安装依赖（首次较慢，需要下载 Electron 约 100MB）"
  npm install
fi

echo "▶ 生成图标"
node scripts/make-icon.js

case "$MODE" in
  dir)
    echo "▶ 打包目录版（不生成 DMG）"
    npx electron-builder --mac --dir
    ;;
  universal)
    echo "▶ 打包 Universal DMG"
    npx electron-builder --mac --universal
    ;;
  install)
    echo "▶ 打包并安装到 /Applications"
    npx electron-builder --mac --dir
    APP="dist/mac-arm64/PhotoClassifier.app"
    [ -d "$APP" ] || APP="dist/mac/PhotoClassifier.app"
    rm -rf "/Applications/PhotoClassifier.app"
    cp -R "$APP" /Applications/
    xattr -dr com.apple.quarantine "/Applications/PhotoClassifier.app" 2>/dev/null || true
    echo "✅ 已安装到 /Applications/PhotoClassifier.app"
    ;;
  dmg|*)
    echo "▶ 打包 DMG + ZIP"
    npx electron-builder --mac
    ;;
esac

echo
echo "✅ 完成，产物位于 dist/："
ls -1 dist | grep -Ev '^(builder-|\.icon)' || true
echo
echo "提示：应用未经 Apple 签名，首次打开若提示「无法验证开发者」，"
echo "      请右键 .app → 打开，或执行： xattr -dr com.apple.quarantine \"/Applications/PhotoClassifier.app\""
