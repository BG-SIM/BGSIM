# 规则集（Ruleset）与机制轮换

酒馆每个版本会轮换机制（饰品、黑暗之赐、畸变、时空扭曲……）。这里的约定是：**机制轮换只关开关，不删代码**。

## 三层各管一段

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 引擎 config | `engine/profiles.py` 的 `config` | 真正把机制关掉（`timewarp_enabled=false`、把 `lesser/greater_trinket_turn` 推过 `max_turns`、`dark_gift_unlock_turn` 推高） |
| server 投影 | `engine/server.py` | 视图里带上 `profile` 与 `caps`；关掉的机制不再产生对应的 pending/字段 |
| 客户端 | `src/features/registry.ts` | feature 只在对应 capability 不为 `false` 时挂载（自己管布局盒、弹窗、按钮、资产） |

三处判断都来自同一个 profile，所以不会出现“UI 藏了、引擎还在发”。

## 现有 profile

| id | 用途 | 开 | 关 |
| --- | --- | --- | --- |
| `shipping` | 当前正式版本（默认） | 饰品、黑赐、畸变、任务 | 时空扭曲 |
| `lab` | 测试用：全部机制打开 | 全部 | — |
| `vanilla` | 测试用：轮换后的基础版本 | 畸变、任务 | 饰品、黑暗之赐、时空扭曲 |

## 接口

- `GET /api/profiles` → `{ profiles: [{id, label, capabilities}], default }`
- `POST /api/new { seed, profile }` → 用某个 profile 开局
- `/api/state` 的 `game` 里带 `profile` 和 `caps`

## 加一个机制 / 轮换掉一个机制

1. **加**：在 `engine/profiles.py` 里给 `shipping` 的 `capabilities` 加上键（默认 `true`），需要的话补 `config`；客户端在 `src/features/registry.ts` 注册 feature（`capability` 用同一个键），并声明它拥有的布局盒、pending 类型。
2. **轮换掉**：把 `shipping` 里对应 capability 改成 `false`，并在 `config` 里关掉引擎侧开关；如果该机制还有专属卡牌，把它加进 `excluded_cards`（避免玩家拿到引用已关闭机制的卡）。不删任何 feature 代码。
3. **恢复**：把 capability 改回 `true`、恢复 config 即可——`lab` profile 就是用来证明这一点的。

## 已经搬运的 feature
- **饰品**（`src/features/trinkets.tsx`）：两个饰品环（`trinketGreater`/`trinketLesser`）、`trinket` 弹窗、悬浮面板里的饰品图标、布局编辑器里的两个盒子，全部受 `capability: 'trinkets'` 控制。`vanilla` profile 下整组消失，而且引擎侧也不会再发 `trinket` pending。

## 测试

```
npm run test:profiles          # 需要引擎在 8787
node scripts/profile-test.mjs http://127.0.0.1:8799
npm run test:profiles:ui       # 需要 app 在 5174、引擎在 8799
```

它验证：

- `/api/profiles` 列出的 profile 与默认值；
- 视图里带 `profile` + `caps`；
- `shipping` 不会开出时空扭曲酒馆；
- `lab` 真的能在第 6 回合打开时空扭曲（引擎层）；
- `vanilla` 的饰品从头到尾不会出现。

> 注意：时空扭曲 mechanic 在引擎里仍然存在，只是 `timewarp_enabled=false`；轮换验证就是靠 `lab` 把它重新打开。若将来引擎真的删掉了该机制，`lab` 的那条断言会失败，届时把 feature 标记为 removed 即可，`vanilla`/`shipping` 路径不受影响。
