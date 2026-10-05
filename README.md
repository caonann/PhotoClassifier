# PhotoClassifier · 旅游照片筛选客户端

本地运行的照片筛选工具（Node.js + Express + sharp），用于快速把上千张旅拍 JPG 分到自定义文件夹，并把同名 ARW 一起带走。

## 启动

```bash
git clone git@github.com:caonann/PhotoClassifier.git
```

### 方式一：桌面应用（推荐）

```bash
cd PhotoClassifier
./build.sh install     # 打包并安装到 /Applications/PhotoClassifier.app
```

之后在启动台 / 聚焦搜索里打开「PhotoClassifier」即可，像普通应用一样使用。其他打包模式：

| 命令 | 产物 |
|---|---|
| `./build.sh` 或 `./build.sh dmg` | `dist/PhotoClassifier-x.y.z-arm64.dmg` + `.zip`，可分发给其他 Apple Silicon Mac |
| `./build.sh dir` | 仅 `dist/mac-arm64/PhotoClassifier.app`，最快，用于本机验证 |
| `./build.sh universal` | Intel + Apple Silicon 通用 DMG |
| `npm run app` | 不打包，直接以开发模式启动 Electron 窗口 |

应用未经 Apple 开发者签名，首次打开若提示「无法验证开发者」，右键 `.app` 选「打开」，或执行 `xattr -dr com.apple.quarantine "/Applications/PhotoClassifier.app"`（`install` 模式已自动处理）。

桌面应用的数据保存在 `~/Library/Application Support/PhotoClassifier/`（`data/` 为配置、评分、处理进度，`cache/` 为缩略图缓存），可通过菜单「PhotoClassifier → 打开数据目录」快速定位，菜单里也有「清空缩略图缓存」。

### 方式二：浏览器模式

```bash
cd PhotoClassifier
npm install          # 首次
npm start            # 默认 http://127.0.0.1:3456
# 自定义端口：PORT=4000 npm start
```

浏览器打开 `http://127.0.0.1:3456`。此模式数据保存在项目的 `data/` 目录，与桌面应用相互独立。

## 使用流程

1. 顶部点「📁 选择文件夹」弹出 Finder 选择照片文件夹（选中后自动加载），也可以手动输入路径（支持 `~`）后点「加载」。列表中只展示 JPG，同名 ARW 不显示但会随 JPG 一起拷贝。
2. 点右上角「设置」创建分类：输入分类名，可点「📁 选择位置」为这个分类单独指定创建位置（留空则使用上面的默认位置）。会自动建立两个文件夹：`名称/` 与 `名称.arw/`。第一个创建的分类自动成为默认分类。
3. 在主界面浏览照片，点底部分类按钮（或按快捷键）即把当前 JPG 拷贝到 `名称/`，同名 ARW 拷贝到 `名称.arw/`，然后自动跳到下一张。**原照片始终保留在源文件夹，不会被移动或删除。**
4. 「跳过」只在本地记录里打个标记，不动任何文件。
5. 已处理的照片默认从列表中隐藏，勾选顶部「显示已处理」可回看并可重新分类；设置里可「重置处理记录」从头再筛一遍。
6. 双击大图、按 `+`、或点「🔍 放大」进入原图查看器：触控板捏合或 ⌘+滚轮以鼠标为中心缩放、双指滑动或拖拽平移、`1:1` 看实际像素、`0` 适应窗口、`Esc` 退出，查看器内 `←/→` 可直接切换上一张/下一张。
7. 右侧面板显示 RGB + 亮度直方图、曝光诊断、分组的 EXIF 信息（拍摄参数 / 器材 / 时间与位置 / 图像 / 文件，GPS 可点开地图）；底部星星可以打 1-5 分。
8. 点底部「⌖ 对焦区域」或按 `A`，大图上会叠加绿色对焦框，标出相机当时实际对焦的位置（读取 Sony MakerNote 的 FocusLocation / FocusFrameSize；非 Sony 机型退回标准 EXIF SubjectArea）。有框尺寸时画矩形，只有坐标时画圆点；若坐标恰在画面正中心会以橙色虚线提示「可能为默认值」（Sony 取不到对焦位置时会写中心点）。开关状态会记住，右侧「拍摄参数」里也会列出对焦像素坐标。
9. 顶部「★ 按星级导出」可以把评分落在某个范围内（如「4★ 以上」「仅 5★」「1-2★」或自定义从 N 星到 M 星）的照片一次性额外拷贝到一个分类：可以选已有分类，也可以直接新建一个。弹窗里会实时统计匹配张数与各星级分布。这是「额外拷贝」，默认不改变照片原有的处理记录；勾选「同时标记为已处理」则会把它们标记为拷贝到该分类。目标里已有同名文件的照片会跳过不覆盖，整批操作可用 `Z` 一次撤销。

## 快捷键

| 键 | 作用 |
|---|---|
| ← / → | 上一张 / 下一张 |
| Enter / Space | 拷贝到默认分类 |
| Q W E R T Y U I O | 拷贝到第 1-9 个分类 |
| X / Delete / Backspace | 跳过 |
| 1-5 / 0 | 评分 / 清除评分 |
| Z | 撤销上一次拷贝或跳过（会删除刚拷出的副本） |
| A | 显示 / 隐藏对焦区域 |
| + / 双击 | 放大查看；查看器内 + − 0 1 Esc |
| F | 全屏看图 |

## 数据与缓存

浏览器模式在项目 `data/` 下，桌面应用在 `~/Library/Application Support/PhotoClassifier/data/` 下：

- `config.json`：源文件夹、分类列表、默认分类。
- `ratings.json`：评分，按源文件夹分组记录，不同文件夹的同名照片互不影响。
- `processed.json`：每个源文件夹的处理记录（哪些已拷贝到哪、哪些跳过）。
- 缩略图 / 预览缓存：浏览器模式在系统临时目录 `photo-classifier-cache/`，桌面应用在 `~/Library/Application Support/PhotoClassifier/cache/`，可随时删除。
- 测试数据：`node scripts/make-samples.js /tmp/photo_test` 生成 5 张带 EXIF 的示例照片。

## 说明

- 只扫描源文件夹第一层的 `.jpg/.jpeg`，ARW 匹配不区分大小写。
- 拷贝保留原文件修改时间；目标位置已有同名文件时拒绝并提示，不会覆盖。
- 撤销记录保存在内存中，重启服务后清空；处理记录持久化，重启后继续上次进度。
