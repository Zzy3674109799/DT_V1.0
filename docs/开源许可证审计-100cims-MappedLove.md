# 100cims / MappedLove 开源许可证审计

审计时间：2026-10-18

目的：判断是否把两个项目的代码直接混入“行迹山河”商业产品，还是只参考产品设计和领域模型。

## 结论

当前项目采用**自研底座**。不直接 Fork TRIP、100cims 或 MappedLove；先参考它们的产品结构和数据模型，再用自己的中国地图、微信小程序和后端实现。

- **100cims**：不建议当前直接复制代码。仓库根目录没有统一 `LICENSE`；`packages/app` 标注 MIT，但 `packages/api` 是 private，不能据此推断整个仓库都可按 MIT 商用。
- **MappedLove**：根仓库和 `package.json` 标注 MIT，代码层面可以复制，但项目强依赖 Cloudflare/NuxtHub/Paddle/Cloudflare Images，且包含 CC-BY、MPL、LGPL 等依赖和图标资源。更适合参考媒体、故事和地图交互，按需复制独立 MIT 代码并保留声明。
- **第三方依赖**：两者都没有发现 GPL-only 或 AGPL-only 的生产依赖；存在需要保留通知或单独核对的 LGPL、MPL、CC-BY、双许可证和 Unlicense 包。

这不是法律意见。正式商业发行前，应把锁文件、NOTICE、字体、图标、地图数据和服务条款交给法务复核。

## 100cims

仓库：<https://github.com/jvidalv/100cims>

审计提交：`f92fb794f008a67fde9368573d42535e5aa5eef6`（2026-10-06）

仓库结构：

- `packages/app/LICENSE`：MIT，移动 App 包声明 MIT；
- 根仓库未发现统一 `LICENSE`；
- `packages/api/package.json`：private，未声明可继承的仓库许可证；
- `yarn.lock`：Yarn 1 工作区锁文件。

Yarn `licenses list` 共识别 1330 个包（包含开发依赖）：

- MIT 1107；Apache-2.0 90；ISC 54；BSD-2-Clause 22；BSD-3-Clause 19；
- BlueOak-1.0.0 10；Unlicense 4；MPL-2.0 3；Apache-2.0 AND LGPL-3.0-or-later 1；
- CC-BY-4.0 1；`BSD-3-Clause OR GPL-2.0` 1；2 个 workspace/private 包显示 UNKNOWN。

需要登记的代表性依赖：

- `sharp` 的平台包：Apache-2.0 AND LGPL-3.0-or-later；
- `postgres`：Unlicense；
- `node-forge`：BSD-3-Clause OR GPL-2.0，使用 BSD 条款即可避免 GPL 路径；
- `caniuse-lite`：CC-BY-4.0；
- `lightningcss`、`axe-core`：MPL-2.0；
- Expo/React Native/Mapbox 相关直接依赖主要是 MIT 或 Apache-2.0。

判断：100cims 的**挑战、山峰、积分、排行榜领域设计非常值得参考**。在根仓库许可证澄清前，先不直接复制 `packages/api` 和完整 App 代码；可以根据公开产品行为重新实现，或只复制已经明确 MIT 的独立 App 文件，并保留原版权声明。

## MappedLove

仓库：<https://github.com/Yizack/mappedlove>

审计提交：`c9f7ae92ec50c44448e22a7e2f996758928a25bc`（2026-10-16）

仓库和 `package.json` 都声明 MIT。生产依赖使用 `pnpm licenses list --prod --json` 审计，识别到 18 类许可证，主要包括：

- MIT 734；Apache-2.0 37；ISC 34；BSD-2-Clause 14；BSD-3-Clause 12；
- BlueOak-1.0.0 11；CC0-1.0 4；MPL-2.0 2；CC-BY-4.0 2；
- Apache-2.0 AND LGPL-3.0-or-later 1；`BSD-3-Clause OR GPL-2.0` 1。

需要登记的代表性依赖和资源：

- `@iconify-json/solar`：CC-BY-4.0；
- `@twemoji/api`：MIT AND CC-BY-4.0；
- `caniuse-lite`：CC-BY-4.0；
- `lightningcss`：MPL-2.0；
- `sharp` 平台包：Apache-2.0 AND LGPL-3.0-or-later；
- `node-forge`：BSD-3-Clause OR GPL-2.0；
- 项目还依赖 Cloudflare Workers/NuxtHub、Cloudflare Images、Paddle、MailChannels 等外部服务，商业使用要分别遵守服务条款。

判断：MappedLove 的**地图故事、媒体、公开分享和共同编辑交互可以借鉴或按需复制 MIT 代码**。不建议整仓库照搬，因为 Cloudflare 数据层、Paddle 订阅、图片服务和中国地图需求都需要重写；图标、字体、图片等非代码资产要单独登记来源和许可。

## 对“行迹山河”的最终策略

1. 保留当前 `xingji-shanhe` 自研底座，不直接使用 TRIP 代码。
2. 参考 100cims 的 `Mountain / Challenge / Score / Ranking / Pack` 领域模型，重新实现中国版本。
3. 参考 MappedLove 的 `Place / Story / Media / Visibility` 交互，使用自有 UI 和媒体服务。
4. 选用自己的依赖版本，生成并提交 `THIRD_PARTY_NOTICES.md`；对 CC-BY、MPL、LGPL 和双许可证包保留对应声明。
5. 地图、定位、对象存储、支付和消息服务使用中国供应商，许可证审计与服务条款审计分开进行。

在 100cims 根仓库许可证得到作者明确说明前，不把它作为可直接 Fork 的商业代码底座。
