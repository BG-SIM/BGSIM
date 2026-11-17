# 参与开发

感谢愿意一起把酒馆模拟器做得更像真的。这份文档说明怎么把项目跑起来、代码怎么组织、提交前跑哪些测试。

## 1. 环境

| 需要 | 说明 |
| --- | --- |
| Node.js ≥ 20 | 前端与脚本 |
| Windows x64 | 引擎运行时与桌面版目前只提供 Windows 构建；前端与联机中继本身跨平台 |
| Python 3.10（含 taverngym） | 规则引擎。仓库**不附带**运行时，见下 |

### 引擎运行时

`taverngym` 是编译好的 Rust 扩展，`engine/runtime/` 不入库。两种方式：

1. 把打包好的运行时放到 `engine/runtime/`（`python.exe` + `Lib/site-packages`）；
2. 用系统 Python：

   ```powershell
   # 需要 Python 3.10 x64 与 taverngym（可从 [AutoTavern](https://github.com/MCG-NJU/AutoTavern) 项目构建 wheel）
   $env:BGSIM_PYTHON='C:\Python310\python.exe'
   npm run server
   ```

`scripts/server.mjs` 优先读 `BGSIM_PYTHON`，否则用 `engine/runtime`。
`GET http://127.0.0.1:8787/api/health` 返回 200 且带 `game` 版本就说明引擎接上了。

## 2. 跑起来

```powershell
npm install
npm run start        # 引擎 :8787 + Vite :5173 + 本地联机中继 :8790
```

或者分开：

```powershell
npm run server       # 只起引擎（同时托管已构建的 dist/）
npm run dev          # 只起前端，/api 代理到 :8787
npm run relay        # 只起联机服务端
```

`?mode=single` 直接进牌桌，`?mode=net` 直接进联机大厅，`?edit=1` 打开 UI 布局编辑器。

## 3. 目录

```
engine/
  server.py        HTTP 桥：紧凑视图、动作、战斗回放、素材缓存、联机座位
  profiles.py      规则集 profile（机制开关 + 引擎 config）
  assets.py        本地美术包（CDN 缓存）
src/
  api.ts           /api 客户端
  store.ts         zustand 全局状态
  store/           小切片：net / drag / turnClock / peek / uiEditor / combatLog …
  components/      酒馆、卡牌、战斗、弹窗、图鉴、联机 HUD
  features/        ★ 受 profile 控制的机制模块（饰品类、黑暗之赐…）+ registry
  lib/             资源 URL、文案、布局、拖拽、音效
  styles.css       全部视觉
server/            联机中继（独立部署，只有 ws 一个依赖）
scripts/           引擎启动、冒烟/回归测试、截图脚本
docs/              打包与规则集文档、README 截图
```

## 4. 代码约定

- TypeScript 严格模式，`npm run build` 会先跑 `tsc -b`，不留类型错误。
- 样式集中在 `src/styles.css`，组件里只写布局用的内联尺寸/定位。
- UI 文案中文；代码注释解释“为什么”，不是“做了什么”。
- 尽量不加依赖。需要状态就用 `zustand` 切片，需要动画优先 CSS。
- 素材路径统一走 `src/lib/assets.ts`（本地包 / CDN 两种来源），不要在组件里拼 URL。

## 5. 机制轮换（重要）

酒馆每个版本会轮换机制。**不要删代码**，用规则集开关：

- 引擎侧开关与能力：`engine/profiles.py`
- 客户端模块：`src/features/*.tsx` + `src/features/registry.ts`
- 完整说明：[docs/RULESETS.md](docs/RULESETS.md)

新增一个机制：在 profile 里加 capability（默认 `true`）→ 在 `features/` 注册 feature（声明布局盒、pending 类型）→ 用 `vanilla` / `lab` 两个 profile 验证“关掉后整组消失、打开后完整回来”。

## 6. 测试

单机回归（117 项：拖拽、购买、出售、法术、队列、战斗、手牌扇形…）需要两个进程：

```powershell
# 1) 独立的测试引擎（不会碰 :8787 上正在玩的局）
node scripts/server.mjs --port 8799

# 2) 指向它的前端
$env:BGSIM_ENGINE='http://127.0.0.1:8799'; $env:BGSIM_PORT='5174'; npx vite

# 3) 跑
node scripts/feel-test.mjs http://localhost:5174 http://127.0.0.1:8799
```

规则集：

```powershell
npm run test:profiles        # 引擎层：profile 列表、capabilities、时空/饰品/黑赐开关
npm run test:profiles:ui     # UI 层：关掉的机制没有残留 DOM / 编辑器条目
```

联机（全部用临时端口和临时目录）：

```powershell
npm run relay:install
npm run test:net             # 锁步 + 引擎多座位 + 中继协议 + 8 人 e2e + 联机 UI
```

布局：

```powershell
node scripts/check-layout.mjs http://localhost:5174 http://127.0.0.1:8799
```

## 7. 提交

- 一个改动一个提交，信息用一句话说清“改了什么、为什么”（中文可以）。
- 不要提交 `data/`、`engine/runtime/`、`dist/`、`node_modules/`（都已在 `.gitignore`）。
- 改动 UI 的话，贴一张前后对比截图到 PR 里会很有帮助。
- 涉及规则/引擎行为的改动，请在 PR 描述里说明用哪个 profile、哪个测试验证过。

## 8. 素材与版权

卡牌插画、名称与描述的版权归 Blizzard Entertainment；卡框/图标来自社区项目；引擎来自 AutoTavern。
本项目是非官方粉丝作品。详见 [NOTICE](NOTICE)。提交素材前请确认你有权使用。

## 9. 打包桌面版

见 [docs/PACKAGING.md](docs/PACKAGING.md)（Tauri + NSIS，Windows）。
