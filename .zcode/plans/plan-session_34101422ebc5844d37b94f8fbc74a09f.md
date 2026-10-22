# OpenHome3D 改造为养成游戏：金币经济 + 家具解锁 + 储物箱

## 经济模型总览（规则先行）

- **钱包 `coins`**：持久化、随保存保留，永不进入撤销栈（避免「领取后撤销→金币凭空消失」）。初始 800。
- **每件摆放付费**：手动添加/换模/复制一件家具按模型价格扣费；首次付费的模型永久加入**图鉴 `unlocked`**（收藏目录）。删除/撤销/重置**不退款**（游戏惯例，UI 在花费前明示价格）。
- **价格**：按类型分档（BUILT-IN 五折、上传模型免费）——BEDS 400 / KITCHEN 350 / BATHROOM 300 / SEATING 250 / TABLES 200 / STORAGE 180 / LIGHTING 120 / OTHER 100 / DECOR 60。
- **图鉴与自动生成**：`addRoom`/`reshuffle`/`rebuild`/模板等自动布局**免费**，但只从图鉴选模型（初始图鉴 = 18 个内建参数化模型 + 用户上传；旧存档按「已摆放∪已收纳」推导补全）。解锁越多，自动布置越丰富——这就是成长线。
- **房间收费**：`addRoom` 与 `setRoomRect` 扩大面积按 10 金币/m² 计费；缩小/删除不退款；`newRoom`（新建方案）/`newHome`（模板）免费且**保留钱包、图鉴、储物箱**（养成进度跨方案持久）。
- **挂机收入**：每分钟产出 = 2×房间数 + 1×当前摆放的**不同模型种数**（去重防止复制/换一换刷收入），离线累计上限 12 小时。
- **每日签到**：当日首次领取 100 + 连签加成（每连续 1 天 +20，上限 200），断签重置。
- **储物箱 `storage`**：收起家具（免费，保留实例与位置）→ 可随时摆回原房间（房间已删则回落活动房间），跨「新建方案」保留。

## 新增文件

1. **`src/state/economy.ts`** — 纯函数与常量，零 store 依赖：价格表、`modelPrice(def)`、`roomAreaCost(rect)`、`expansionCost(oldRect,newRect)`（缩小为 0）、`incomePerMinute(home, furniture)`、`accruedIncome(rate, elapsedMs)`（含 12h 上限）、`dailyReward(streak)`、`isYesterdayKey/localDayKey(now)`、`ownedModelIds({unlocked, furniture, storage, uploads})`（图鉴 = 显式 unlocked ∪ 摆放 ∪ 收纳 ∪ BUILT-IN ∪ 上传，旧存档免迁移自愈）。
2. **`src/ui/CoinWallet.tsx`** — TopBar 金币胶囊 + 弹出面板（仿 `display-pop` 模式）：余额、每分钟产出、挂机可领（含上限进度）、今日签到状态，一个「领取」按钮同时收挂机与签到。`setInterval` 30s 刷新显示。
3. **`src/ui/modals/StorageBox.tsx`** — 储物箱弹窗（uiStore 新 kind `'storage'`）：卡片网格（缩略图、名称、原房间名、「摆放」按钮）+ 空状态文案。缩略图复用 ModelBrowser 的 ParamThumb/GlbThumb（从 ModelBrowser.tsx 导出）。

## Store 改动（`src/state/store.ts`）

- HGState 新字段：`coins`、`unlocked: string[]`、`storage: FurnitureInstance[]`、`lastCollectAt: number`、`lastDailyDay: string | null`、`dailyStreak: number`；全部加入 `Persisted` 与 `partialize`（store.ts:266-281, 1057-1072）。**版本保持 2 不动**：zustand merge 会为缺失字段取初始默认值，无需 migrate。
- **`EDIT_KEYS`/`SNAPSHOT_KEYS` 增加 `'storage'`**（store.ts:283-287）：收起/摆回随家具数组一起入撤销栈、对称恢复。coins/unlocked/收入时间戳**不进**快照。
- 付费动作改造（不足时 `set structureNotice`（双语）并 no-op，成功时同一 patch 扣费；提示 toast 由 UI 层负责，store 不 import uiStore）：
  - `addFurniture`（store.ts:866）：价格 > coins → 拒绝；否则扣费、placement 照旧、`unlocked ∪= modelId`。
  - `duplicateFurniture`（store.ts:900）、`swapModel`（store.ts:923，按目标模型价）：同样扣费。
  - `addRoom`（store.ts:581）：按新房间面积扣费；`setRoomRect`（store.ts:433）：增加面积扣费，缩小免费。
- `layoutForRoom`（store.ts:151-170）：`models: allModels()` → `models: allModels().filter(m => owned.includes(m.id))`，参数类型扩为携带 `unlocked/furniture/storage/uploads`；生成器纯函数性不变（过滤集作为输入）。
- 新动作：
  - `storeFurniture(id)`：furniture → storage（实例原样保留），清 selectedId；走 `set`（自动入栈）。
  - `placeFromStorage(id, roomId?)`：storage → furniture，目标房间 = 指定 ∥ 原房间（不存在回落 activeRoom/rooms[0]），位置复用 addFurniture 的 clamp/findArchitecturalPosition 逻辑。
  - `collectIncome(now?)`：`rawSet`（不入栈）累加挂机收入并重置 `lastCollectAt`。
  - `claimDaily(now?)`：`rawSet`，断签/连签计算，置 `lastDailyDay`。
- `importHome`/`importProject`/完整工程恢复：导入家具的 modelId 并入 `unlocked`（带着家当搬进来，不重复收费）。
- `removeUpload`（store.ts:1036）：同步清掉 storage 中该模型实例（现在只清 furniture）。
- `newRoom/newHome`：不动 coins/unlocked/storage。

## UI 改动

- **TopBar**（src/ui/TopBar.tsx cam-bar 右端、AI 按钮旁）：`<CoinWallet />`，金币为内联 SVG 图标 + 金额，有待领时显示 `+N` 徽标。
- **ModelBrowser**（src/ui/modals/ModelBrowser.tsx）：卡片显示价格角标（🪙N，图鉴内模型加 ✓标记）；点击价格 > 0 的卡片改为弹底部确认条「花费 N 摆放/更换？」（余额不足显示差额并禁用），确认后调 action + toast；价格 0（上传件）维持直接摆放。swap 模式同逻辑。
- **HomeTab**（src/ui/HomeTab.tsx:509）：「+ 添加房间」按钮显示预计费用，余额不足禁用；**RoomTab**（src/ui/Sidebar.tsx:82-91）宽深输入下方显示「扩展至 W×D 需 N 金币」提示（store 仍兜底拒绝）。
- **Sidebar 家具区**（Sidebar.tsx:184-186）：新增「储物箱 Storage (N)」GhostButton 打开 storage 弹窗；uiStore `ActiveModal` 增加 `{kind:'storage'}`，Modals.tsx 加分支。
- **StatusBar sel-pill**（src/ui/StatusBar.tsx:119-146）：删除按钮前新增「收起」图标按钮 → `storeFurniture`。
- 文案遵循中英双语惯例，金币相关文案集中在使用处内联。

## 测试与验证

- `scripts/test-editor-state.mjs` 追加经济断言：付费摆放扣费并解锁、余额不足拒绝、addRoom/setRoomRect 计费、storage 收/摆与撤销对称、生成只用图鉴模型、collectIncome/claimDaily 数值；如现有用例因扣费耗尽金币，在用例开头 `setState` 补充金币。
- 检查 `scripts/test-interactions.mjs` 是否经过模型库添加流程，如被确认条挡住则同步适配（先 `__store.setState` 补金币）。
- 验证命令：`npm run build` → `npm run check`（含 smoke、smoke:editor、smoke:ai、smoke:architecture）；随后起 dev server 跑 `npm run smoke:interactions`、`smoke:ui`、`audit:ui`（UI 改动范围）。
- 文档：README 增加玩法一节；AGENTS.md 补充经济不变量（金币不进撤销栈、生成仅用图鉴、导入并入图鉴）。

## 已知取舍

- 撤销不退款：撤销会移除家具但不返还金币（金币不进快照是防止签到/领取被回滚的必要取舍），UI 价格前置确认缓解。
- 自动生成免费但限于图鉴：刷不了收入（收入按不同模型种数计），且是「解锁→布置更丰富」的成长循环本身。
- 导入工程可白得图鉴：单机游戏，接受，换取状态一致性。