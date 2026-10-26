# TRIP 作为中国旅行登山小程序底座的评估

评估仓库：`itskovacs/trip`

评估提交：`856b1edfe81a735fce4b544c2e16a6518cebf164`（2026-10-02）

## 结论

TRIP 的 MIT 代码可以商业使用、修改和发行，但“整仓库直接 Fork 作为最终产品底座”并不是当前项目的最高效方案。

更合适的做法是：

> **复用 TRIP 的旅行领域后端模型和可迁移的 API 设计，保留 PostgreSQL/PostGIS 的产品底座；重新实现微信小程序前端、微信登录、中国地图服务、媒体处理、挑战系统、PACK 社区和商业模块。**

如果只做自托管的 Web/PWA 行程管理，TRIP 整体底座会明显更快；如果目标是中国旅行、登山点亮、PACK、竞赛和商业闭环，整仓库 Fork 的改造量会抵消大部分收益。

## TRIP 能直接节省的工作

TRIP 后端已经提供 FastAPI + SQLModel + Alembic 的完整服务结构，当前仓库约有 115 个 API 路由，包含：

- 用户名密码、JWT 刷新、TOTP、OIDC 登录；
- POI、分类、图片、访问状态和 GPX；
- 多日行程、行程日、行程项目、预订和费用平衡；
- 行程成员邀请、接受和退出；
- 行程分享令牌、日历订阅和公开读取；
- 图片、附件、备份导入导出；
- packing list、checklist、地图搜索、地理编码和路线能力；
- Docker 镜像与单容器部署方式。

其中 `Place`、`Trip`、`TripDay`、`TripItem`、`TripMember`、`TripShare`、`Image`、`TripAttachment` 等实体，适合作为“地点/行程/媒体/协作”的领域参考或局部移植来源。

## 会增加成本的部分

| 领域 | TRIP 当前实现 | 对本项目的影响 |
|---|---|---|
| 前端 | Angular 21 PWA + Leaflet + PrimeNG | 微信小程序不能直接复用 Angular 页面和组件，页面层基本需要重写 |
| 技术栈 | Python 3.12 + FastAPI/SQLModel，当前 MVP 是 Node.js/Express | 直接接入会形成双运行时；团队若不长期维护 Python，升级和排障成本会上升 |
| 数据库 | SQLite 文件、WAL、Alembic | 商业化多用户场景需 PostgreSQL/PostGIS；迁移 ORM、索引、并发和迁移脚本 |
| 文件 | 本地 `storage/assets` 和 `storage/attachments` | 需要对象存储、CDN、视频转码、缩略图、断点上传、内容审核和权限 URL |
| 登录 | 用户名密码、JWT、OIDC、TOTP | 需要微信 `code2Session`、openid/unionid、手机号绑定、风控和账号合并 |
| 地图 | OSM/Photon/Google、自定义瓦片 URL | 需要替换为高德/腾讯/百度或合规自建服务，并处理 GCJ-02/WGS-84、轨迹和爬山路线数据 |
| 社区 | 行程协作者和只读分享 | 没有关注、点赞、评论、动态流、PACK 活动、队伍管理和举报审核 |
| 挑战 | 没有积分、勋章、排行榜和挑战规则 | 100cims 的挑战模型仍需独立实现，包含签到证据、反作弊和赛季结算 |
| 商业 | 没有订单、支付、商家、优惠券和分佣 | 需要单独的商业域和微信支付/退款/对账流程 |

因此，TRIP 最适合作为“行程管理服务”的起点，而不是整个小程序的产品底座。

## 许可证与外部服务

- TRIP 根仓库 `license.txt` 为 MIT。复制或发行代码时保留版权声明和 MIT 许可文本即可。
- `src/package-lock.json` 当前记录约 607 个 npm 包，主要是 MIT、ISC、Apache-2.0、BSD；需要保留的特殊条目包括 `lightningcss` 的 MPL-2.0、`caniuse-lite` 的 CC-BY-4.0、PrimeNG 的随包许可证，以及 `open-location-code-typescript` 的许可证信息缺失/需单独核实。
- Python 运行时依赖整体为宽松许可证为主，但发布前仍应按锁定版本生成完整 SBOM/NOTICE，不能只凭根仓库 MIT 结论覆盖依赖。
- OSM 瓦片、Photon、路由服务、Google API 和地图数据有各自的服务条款、调用限制和归属要求；这些不是 TRIP 的 MIT 许可范围。中国商业部署必须重新核对地图测绘、瓦片调用、坐标和备案合规。

## 推荐落地路径

### 方案 A：推荐

保留当前 `xingji-shanhe` 的 Node.js + PostgreSQL/PostGIS + Docker 结构，把 TRIP 的领域模型转成独立模块：

1. `places`：城市、景区、山峰、路线和轨迹点；
2. `trips`：行程、行程日、行程项目、媒体引用；
3. `members`：PACK 成员、角色和邀请；
4. `shares`：公开分享和权限令牌；
5. `media`：照片、视频、封面、缩略图和对象存储；
6. 在这些模块旁边新增 `challenges`、`achievements`、`leaderboards`、`feeds`、`orders`。

这样能保留 PostgreSQL/PostGIS、多用户扩展和中国地图适配能力，同时吸收 TRIP 已验证的数据关系和 API 边界。

### 方案 B：有条件采用

以 TRIP FastAPI 后端为起点，先替换 SQLite 为 PostgreSQL，再替换认证、对象存储和地图服务。仅当团队已经确定使用 Python/FastAPI，并愿意维护 TRIP 的迁移分支时采用。预计仍需重写大部分产品 API 和权限规则。

### 方案 C：不推荐

直接部署 TRIP Docker 镜像，再在 Angular 前端上叠加挑战和商业功能。它适合内部旅行规划工具或快速验证 Web 版，不适合目标微信小程序。

## 最终判断

**答案是“局部使用更高效，整仓库作为最终底座不一定更高效”。**

本项目建议采用：

> `xingji-shanhe` 的 PostgreSQL/PostGIS 基础设施 + TRIP 的地点/行程/协作/媒体领域模型 + 100cims 的挑战规则参考 + MappedLove 的故事/媒体交互参考 + 自研微信小程序与商业闭环。

