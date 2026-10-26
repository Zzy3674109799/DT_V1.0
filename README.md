# 行迹山河 MVP

中国旅行登山点亮小程序的 Web 原型，当前包含地图点亮、山峰/景区记录、挑战进度、PACK 展示、排行榜入口和记录写入接口。

## 启动

```powershell
cd D:\codex\项目管理\xingji-shanhe
docker compose up -d --build
```

访问：<http://localhost:8099>

## 服务

- App：`localhost:8099`
- 健康检查：`http://localhost:8099/api/health`
- 仪表盘数据：`http://localhost:8099/api/dashboard`
- 新增记录：`POST /api/v1/visits`
- 开发登录：`POST /api/v1/auth/dev-login`
- 当前用户：`GET /api/v1/auth/me`
- 行程：`/api/v1/trips`
- 行程日/项目：`/api/v1/trips/:tripId/days`、`/api/v1/trips/:tripId/days/:dayId/items`
- 媒体上传：`POST /api/v1/media/presign`、`PUT /api/v1/media/upload/:token`；兼容登记：`POST /api/v1/media/register`
- 媒体完成/访问：`POST /api/v1/media/:id/complete`、`GET /api/v1/media/:id/access-url`
- 原生小程序壳：`miniprogram/`，包含微信登录、地图点位、GCJ-02/WGS84 转换和定位打卡
- M2 打卡：`POST /api/v1/visits`（含围栏验证和风险标记）
- 挑战：`/api/v1/challenges`、`/api/v1/challenges/:id/progress`
- 排行榜：`GET /api/v1/leaderboards/:seasonKey`
- 勋章：`GET /api/v1/me/badges`
- GPX 轨迹登记：`POST /api/v1/tracks/register`
- 管理员复核：`/api/v1/admin/reviews`、`POST /api/v1/admin/visits/:id/review`
- PACK：`/api/v1/packs`、`POST /api/v1/packs/join`、`/api/v1/packs/:id/invitations`
- 队伍任务和共享相册：`/api/v1/packs/:id/tasks`、`/api/v1/packs/:id/media`
- 动态、评论和点赞：`/api/v1/feed`、`/api/v1/feed/posts/:id/comments`、`/api/v1/feed/posts/:id/like`
- M4 活动：`/api/v1/activities`、`POST /api/v1/activities/:id/orders`、`POST /api/v1/activities/:id/checkin`
- 订单支付/退款：`POST /api/v1/orders/:orderNo/pay`、`POST /api/v1/orders/:orderNo/refund`（开发环境 `PAYMENT_MODE=mock`）
- 微信支付：`POST /api/v1/orders/:orderNo/payments/wechat`、`POST /api/v1/payments/wechat/notify`（JSAPI 签名、回调验签和 AES-GCM 解密；未配置商户参数返回 501）
- 微信退款：`POST /api/v1/orders/:orderNo/refund`（mock 本地退款；微信订单调用 `/v3/refund/domestic/refunds`，支持退款回调 `/api/v1/payments/wechat/refund-notify`）
- 优惠券：`POST /api/v1/coupons/:code/claim`、`GET /api/v1/me/coupons`、`POST /api/v1/admin/coupons`
- 会员：`GET /api/v1/membership/plans`、`GET /api/v1/membership/me`、`POST /api/v1/membership/subscribe`
- 品牌挑战与运营：`POST /api/v1/admin/challenges/:id/sponsor`、`/api/v1/admin/commerce/summary`、`/api/v1/admin/orders`、`/api/v1/admin/activities`
- 媒体审核：`GET /api/v1/admin/media`、`POST /api/v1/admin/media/:id/review`
- 媒体 Worker：Compose 服务 `xingji-shanhe-worker`，消费 `media_jobs`，开发环境执行元数据/缩略图占位处理
- PostgreSQL + PostGIS：Compose 内部网络 `xingji-shanhe-network`
- Redis：Compose 内置 Redis 7，排行榜缓存默认 30 秒，Redis 不可用时自动回退数据库查询
- 设计与许可证资料：`docs/`，包含 TRIP 选型、产品技术设计和 100cims/MappedLove 许可证审计

## 停止

```powershell
docker compose down
```

默认数据库数据保存在 Docker volume `xingji-shanhe_xingji_pgdata`。如果需要完全重置演示数据，可以执行 `docker compose down -v`，这会删除该项目的数据库卷。

生产部署请复制 `.env.example` 为 `.env`，填入真实密钥，并通过 Docker secrets 或部署平台的密钥管理注入证书。不要把 `.env`、微信证书、对象存储密钥或媒体文件提交到 Git。

## 当前边界

这是 M4 可运行原型。当前开发环境通过 `AUTH_MODE=demo` 和 `PAYMENT_MODE=mock` 提供签名开发令牌与演示支付；生产环境需要配置微信登录、微信支付商户参数、真实地图 SDK、COS/OSS 媒体上传，并将 Worker 的占位处理替换为 ffmpeg 转码、缩略图和内容审核服务。M2 已接入围栏验证、风险复核、挑战计分、积分账本、勋章和赛季排行榜，M3 已接入 PACK、邀请、共享相册、动态、评论和点赞，M4 已接入活动订单、优惠券、会员订阅、签到和运营统计骨架。

## 设计依据

本项目采用“选择性复用 TRIP”的方案：保留本项目的 PostgreSQL/PostGIS 和 Docker 基础设施，吸收 TRIP 的地点、行程、协作、分享和媒体领域模型；微信小程序前端、中国地图、挑战、PACK 社区和商业模块独立实现。

详细实施设计见工作区的 `行迹山河-选择性复用TRIP实施设计.md` 和 `TRIP底座评估与选型结论.md`。

## M4 商业化说明

开发环境的 `PAYMENT_MODE=mock` 只用于本地验收，不会生成真实微信支付参数。当前 Docker 的 `STORAGE_MODE=local` 只用于开发；生产可切换 `STORAGE_MODE=cos` 并配置 `COS_SECRET_ID`、`COS_SECRET_KEY`、`COS_BUCKET`、`COS_REGION`，或切换 `STORAGE_MODE=oss` 配置对应 OSS 参数和 `CDN_BASE_URL`。微信支付仍需配置 `WECHAT_APPID`、`WECHAT_MCHID`、`WECHAT_SERIAL_NO`、`WECHAT_PRIVATE_KEY(_PATH)`、`WECHAT_API_V3_KEY`、`WECHAT_PLATFORM_CERT_PATH` 和 `WECHAT_NOTIFY_URL`；退款请求和退款回调接口已接入，仍需真实商户证书联调，账单下载尚未接入。

## P0-1 认证与打卡收口（已完成）

- 仪表盘接口现在必须携带登录令牌，未登录返回 401；
- 旧版 `POST /api/visits` 已下线，首页改走 `/api/v1/visits`；
- 非计划打卡没有定位时进入人工复核；
- 围栏验证使用 PostGIS `ST_Distance`，并校验经纬度范围；
- 增加行程归属校验和用户删除时访问记录级联清理迁移（`m5.sql`）。

下一阶段按清单接入 COS/OSS、CDN、ffmpeg 转码和真实内容审核服务。

## P0-2 媒体上传基础（已完成开发环境闭环）

- 新增 `/api/v1/media/presign` 和 `PUT /api/v1/media/upload/:token`；
- 开发 Docker 使用独立 `xingji_media` volume，上传凭证有效期 15 分钟；
- 对象键由服务端生成，限制图片/视频/GPX 大小，校验访问记录归属；
- 接入会员月度媒体额度计数，上传完成后才标记媒体 ready；
- 生产环境仍需将同一契约替换为真实 COS/OSS 预签名、CDN 签名 URL，并把 `media_jobs` 的占位 Worker 接到 ffmpeg 和内容审核服务。

## P0-4 订单一致性（部分完成）

已增加订单客户端幂等键、15 分钟过期时间和支付前过期校验，重复提交同一个 `Idempotency-Key` 会返回同一订单。真实微信统一下单、回调验签和退款请求/回调仍需商户参数与证书联调；账单下载和自动对账仍未接入。
