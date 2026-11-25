# 散场之后 · After the Show

面向演唱会、体育赛事等大型活动的散场出行推演原型：模拟不同需求人群的离场过程，生成并对比调度方案，支持情境调整与过程回放。

在线演示：https://37jpmxbgig9gwot7ftm.traesite.cn/

> 推演数据来自可配置的模拟参数，用于方案讨论与演示，不是真实客流预测。

## 功能

- **散场推演**：按需求组（普通 / 需要无台阶通行 / 希望赶上末班车）模拟登车、排队、错过末班等指标。
- **方案生成与对比**：规则引擎给出基线方案与建议；配置模型后可由 LLM 参与排序与解释，调用失败或额度不足时自动降级为规则模式，并注明真实原因。
- **情境调整**：关闭通道、修改输入等操作先出差异预览，确认后才应用；每次应用 revision 只加 1，旧建议立即标记过期，重算后更新指标。
- **过程回放**：保存当前结果为回放，支持加载、退出与时间轴回放；回放内容不随当前场景变化。
- **地图与地点确认**：接入高德 JS API，支持地点候选确认、只展示归属可信的场馆出口、真实步行动线；地图服务请求经同源 `/_AMapService` 代理，安全密钥不下发浏览器。

## 技术栈

- 前端：React 18 + TypeScript + Vite 5，Vitest
- 服务端：Node.js 20 + TypeScript，零框架 `http` 服务，node:test
- 部署：FunctionWeb 单进程网关（`deployment/gateway.cjs`），同时提供静态资源、`/api/*` 与 `/_AMapService/*`

## 目录结构

```
web/          前端（页面、地图、出行、回放、样式）
server/       决策、仿真、出行建议、安全限流（llm_gate）
shared/       前后端共享类型
tests/        服务端与接口测试（node:test）
fixtures/     固定场景与样例结果
deployment/   FunctionWeb 网关、构建与启动脚本
```

## 本地运行

需要 Node.js 20+。

```bash
# 服务端 API
npm install
npm run build
npm start                 # 默认 http://localhost:8787

# 前端（另开一个终端）
cd web
npm install
npm run dev               # http://localhost:5173
```

前端通过 `web/public/demo-config.js` 读取运行时配置。本地联调时把 `apiBaseUrl` 指向 API：

```js
window.__DEMO_CONFIG__ = {
  apiBaseUrl: "http://localhost:8787",
  amapKey: "",
  amapServiceHost: "/_AMapService",
  mapGeoJson: "",
};
```

**地图说明**：高德 JS API 的服务请求固定走同源 `/_AMapService` 代理（安全密钥只存在于服务端）。直接使用 Vite dev server 时没有该代理，地图相关功能不可用；需要在网关环境运行，或自行在 dev server 配置同源代理，并设置下面的高德环境变量。未配置高德时，其余功能不受影响。

## 配置

所有凭据只通过环境变量注入，仓库中不含任何真实凭据。

### 地图

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `AMAP_JS_API_KEY` | 地图必需 | 高德 Web 端（JS API）Key，会公开下发给浏览器 |
| `AMAP_SECURITY_JS_CODE` | 地图必需 | 高德安全密钥，仅在服务端代理中使用，不下发 |
| `AMAP_MAP_GEO_JSON` | 地图必需 | 场馆底图几何（节点/连线 JSON） |
| `AMAP_PROXY_TIMEOUT_MS` | 可选 | 代理上游超时，默认 8000 |
| `AMAP_PROXY_RATE_LIMIT` / `AMAP_PROXY_RATE_WINDOW_MS` | 可选 | 代理限流，默认 120 次 / 60000ms |
| `AMAP_PROXY_MAX_CONCURRENCY` | 可选 | 代理并发上限，默认 12 |

### 模型（可选）

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `LLM_API_KEY` | 否 | OpenAI 兼容接口 Key；与 `LLM_MODEL` 同时存在才启用 |
| `LLM_MODEL` | 否 | 模型名称或接入点 ID |
| `LLM_BASE_URL` | 否 | 默认 `https://ark.cn-beijing.volces.com/api/v3` |
| `LLM_TIMEOUT_MS` | 否 | 单次调用超时，默认 15000 |
| `LLM_MAX_CONCURRENCY` | 否 | 并发闸门，默认 2 |
| `LLM_MAX_CALLS_PER_MINUTE` | 否 | 每分钟额度，默认 12 |
| `LLM_MAX_CALLS_PER_UTC_DAY` | 否 | 每 UTC 日额度，默认 200 |

不配置模型时全部走规则模式，功能可用。

### 网关

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `APP_ROOT` / `STATIC_ROOT` | 进程目录 / `<APP_ROOT>/web` | 服务端入口与静态资源根目录 |
| `API_RATE_LIMIT` / `API_RATE_WINDOW_MS` | 60 / 60000 | `/api/*` 限流（`/api/health` 不计入） |
| `MAX_API_BODY_BYTES` | 2MB | 请求体上限 |
| `TRUST_PROXY` | `0` | 设为 `1` 才信任 `x-forwarded-for` |

## 部署

`deployment/` 是 FunctionWeb 的打包约定：

- `gateway.cjs`：读取 `server/app.js` 导出的 `createServer()`，同时服务静态资源、`/api/*`、`/_AMapService/*`；动态生成 `/demo-config.js`（`no-store`，只含 `amapKey` / `amapServiceHost` / `mapGeoJson` / `apiBaseUrl` 四个键）。
- `build.sh`：把 `payload/` 下的 `server`、`shared`、`fixtures`、`web` 组装到 `out/`。
- `run.sh`：启动网关。

仓库不包含 `payload/` 构建产物，需要先构建前端（`cd web && npm run build`）、编译服务端（`npm run build`），再按目标平台要求组装。

## 测试

```bash
npm test                                      # 服务端 node:test
cd web && npm test                            # 前端 Vitest
node --test deployment/gateway.security.test.cjs   # 网关安全用例
```

当前提交下：前端 325 项、服务端 113 项、网关 10 项用例全部通过。

## 安全与凭据边界

- 高德 JS API Key 必然会出现在浏览器侧，这是 Web 端 JS API 的机制；**安全密钥不进入前端**，由网关代填 `jscode`。
- 代理对路径做白名单（`v3/v4/v5/ws`）并拒绝 `//`、`..`、`\`；剥离客户端传入的 `key` / `jscode` 后注入服务端值；JSONP 响应强制 `application/javascript` + `nosniff`。
- `/demo-config.js` 每次动态生成，`cache-control: no-store`；仓库内的 `web/public/demo-config.js` 只是空占位。
- 模型调用有三层闸门（并发、每分钟、每 UTC 日），失败或额度不足时降级为规则并透出真实原因，不把失败标成模型成功。

## 已知限制

- 模拟人数、班次、步行速度等均为演示参数，不构成真实疏散能力结论。
- 浏览器定位精度不足（城市/IP 级）时只提示，不覆盖用户已确认的场馆与路线。
- 前端地图依赖同源代理，独立 Vite dev server 下不可用。
- 限流与闸门是单进程内存实现，未覆盖多实例部署与持久化。
