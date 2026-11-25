"use strict";

const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_PORT = 8000;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_RATE_LIMIT = 60;
const DEFAULT_RATE_WINDOW_MS = 60_000;
const DEFAULT_MAX_API_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_AMAP_PROXY_TIMEOUT_MS = 8_000;
const DEFAULT_AMAP_PROXY_RATE_LIMIT = 120;
const DEFAULT_AMAP_PROXY_RATE_WINDOW_MS = 60_000;
const DEFAULT_AMAP_PROXY_MAX_CONCURRENCY = 12;
const AMAP_SERVICE_PREFIX = "/_AMapService";
const JSONP_CALLBACK_PATTERN = /^[A-Za-z_$][0-9A-Za-z_$]*(?:\.[A-Za-z_$][0-9A-Za-z_$]*)*$/;

const MIME = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
});

function envInteger(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

function sendText(res, status, text, extraHeaders = {}) {
  const payload = Buffer.from(text, "utf8");
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": payload.length,
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(payload);
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": payload.length,
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(payload);
}

function sendJavaScript(res, status, source, method = "GET") {
  const payload = Buffer.from(source, "utf8");
  res.writeHead(status, {
    "content-type": "text/javascript; charset=utf-8",
    "content-length": payload.length,
    "cache-control": "no-store, max-age=0",
    pragma: "no-cache",
    "x-content-type-options": "nosniff",
  });
  if (method === "HEAD") res.end();
  else res.end(payload);
}

function runtimeConfigScript(config = {}) {
  const payload = {
    amapKey: typeof config.amapKey === "string" ? config.amapKey : "",
    amapServiceHost: AMAP_SERVICE_PREFIX,
    mapGeoJson: typeof config.mapGeoJson === "string" ? config.mapGeoJson : "",
    apiBaseUrl: "",
  };
  // 防止环境变量中意外出现 </script> 时突破脚本上下文；这里只输出白名单字段。
  return `window.__DEMO_CONFIG__ = ${JSON.stringify(payload).replace(/</g, "\\u003c")};\n`;
}

function buildAmapUpstream(rawUrl, securityJsCode, jsApiKey) {
  if (
    typeof securityJsCode !== "string" ||
    securityJsCode.trim() === "" ||
    typeof jsApiKey !== "string" ||
    jsApiKey.trim() === ""
  ) {
    throw new Error("amap proxy unavailable");
  }

  let incoming;
  try {
    incoming = new URL(rawUrl || "/", "http://gateway.invalid");
  } catch {
    throw new Error("invalid amap proxy request");
  }
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(incoming.pathname);
  } catch {
    throw new Error("invalid amap proxy path");
  }
  if (!decodedPath.startsWith(`${AMAP_SERVICE_PREFIX}/`)) {
    throw new Error("invalid amap proxy path");
  }

  const relativePath = decodedPath.slice(AMAP_SERVICE_PREFIX.length);
  const segments = relativePath.split("/");
  if (
    relativePath.includes("\\") ||
    relativePath.includes("//") ||
    segments.some((segment) => segment === "." || segment === "..") ||
    !/^\/(?:v3|v4|v5|ws)\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/.test(relativePath)
  ) {
    throw new Error("amap proxy path not allowed");
  }

  const isCustomMapStyle = relativePath === "/v4/map/styles";
  const callbacks = incoming.searchParams.getAll("callback");
  if (
    callbacks.length > 1 ||
    (callbacks.length === 1 &&
      (callbacks[0].length > 256 || !JSONP_CALLBACK_PATTERN.test(callbacks[0])))
  ) {
    throw new Error("invalid amap jsonp callback");
  }
  const upstream = new URL(
    isCustomMapStyle
      ? "https://webapi.amap.com/v4/map/styles"
      : `https://restapi.amap.com${relativePath}`,
  );
  for (const [name, value] of incoming.searchParams.entries()) {
    if (!["jscode", "key"].includes(name.toLowerCase())) {
      upstream.searchParams.append(name, value);
    }
  }
  upstream.searchParams.append("key", jsApiKey.trim());
  upstream.searchParams.append("jscode", securityJsCode.trim());
  return upstream;
}

function createAmapProxyHandler(options = {}) {
  const securityJsCode = options.securityJsCode || "";
  const jsApiKey = options.jsApiKey || "";
  const timeoutMs = options.timeoutMs ?? DEFAULT_AMAP_PROXY_TIMEOUT_MS;
  const requestImpl = options.requestImpl || https.request;
  const rateLimit = options.rateLimit ?? DEFAULT_AMAP_PROXY_RATE_LIMIT;
  const rateWindowMs = options.rateWindowMs ?? DEFAULT_AMAP_PROXY_RATE_WINDOW_MS;
  const maxConcurrency = options.maxConcurrency ?? DEFAULT_AMAP_PROXY_MAX_CONCURRENCY;
  // 地图资源有独立预算，避免与业务 API 争抢；只按实际 socket 地址，不信任客户端可伪造头。
  const allowMapRequest = createRateLimiter({ limit: rateLimit, windowMs: rateWindowMs, trustProxy: false });
  let active = 0;

  return function proxyAmap(req, res) {
    const method = (req.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      sendText(res, 405, "method not allowed", { allow: "GET, HEAD" });
      return;
    }

    let upstream;
    try {
      upstream = buildAmapUpstream(req.url || "/", securityJsCode, jsApiKey);
    } catch {
      const configured =
        typeof securityJsCode === "string" &&
        securityJsCode.trim() !== "" &&
        typeof jsApiKey === "string" &&
        jsApiKey.trim() !== "";
      sendText(res, configured ? 404 : 503, configured ? "not found" : "map service unavailable");
      return;
    }

    const rate = allowMapRequest(req);
    res.setHeader("x-ratelimit-limit", String(rateLimit));
    res.setHeader("x-ratelimit-remaining", String(rate.remaining));
    if (!rate.allowed) {
      sendText(res, 429, "too many map requests", {
        "retry-after": String(rate.retryAfterSeconds),
      });
      return;
    }
    if (active >= maxConcurrency) {
      sendText(res, 429, "too many concurrent map requests", { "retry-after": "1" });
      return;
    }
    active += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active = Math.max(0, active - 1);
    };

    let timedOut = false;
    let upstreamReq;
    try {
      upstreamReq = requestImpl(
        upstream,
        {
          method,
          headers: {
            accept: typeof req.headers.accept === "string" ? req.headers.accept : "*/*",
            "accept-language":
              typeof req.headers["accept-language"] === "string"
                ? req.headers["accept-language"]
                : "zh-CN,zh;q=0.9",
            "user-agent": "after-show-amap-proxy/1.0",
          },
        },
        (upstreamRes) => {
          upstreamRes.once("end", release);
          upstreamRes.once("close", release);
          const status = upstreamRes.statusCode || 502;
          if (status < 200 || status >= 300) {
            upstreamRes.resume();
            sendText(res, 502, "map service unavailable");
            return;
          }
          const isJsonp = upstream.searchParams.has("callback");
          const headers = {
            "content-type": isJsonp
              ? "application/javascript; charset=utf-8"
              : upstreamRes.headers["content-type"] || "application/octet-stream",
            "cache-control": upstreamRes.headers["cache-control"] || "no-store",
            "x-content-type-options": "nosniff",
          };
          if (upstreamRes.headers.etag) headers.etag = upstreamRes.headers.etag;
          if (upstreamRes.headers["last-modified"]) {
            headers["last-modified"] = upstreamRes.headers["last-modified"];
          }
          res.writeHead(status, headers);
          if (method === "HEAD") {
            upstreamRes.resume();
            res.end();
            return;
          }
          upstreamRes.on("error", () => {
            release();
            res.destroy();
          });
          upstreamRes.pipe(res);
        },
      );
    } catch {
      release();
      sendText(res, 502, "map service unavailable");
      return;
    }
    upstreamReq.setTimeout(timeoutMs, () => {
      timedOut = true;
      upstreamReq.destroy(new Error("amap proxy timeout"));
    });
    upstreamReq.on("error", () => {
      release();
      if (!res.headersSent) sendText(res, timedOut ? 504 : 502, "map service unavailable");
      else res.destroy();
    });
    req.once("aborted", () => {
      release();
      upstreamReq.destroy();
    });
    upstreamReq.end();
  };
}

function requestPath(req) {
  const raw = (req.url || "/").split("?", 1)[0] || "/";
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded.includes("\0")) return { ok: false, status: 400, message: "bad request" };
    return { ok: true, value: decoded };
  } catch {
    return { ok: false, status: 400, message: "bad request" };
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function statFile(candidate) {
  try {
    const stat = await fs.promises.stat(candidate);
    if (stat.isDirectory()) {
      const indexPath = path.join(candidate, "index.html");
      const indexStat = await fs.promises.stat(indexPath);
      return indexStat.isFile() ? { path: indexPath, stat: indexStat } : null;
    }
    return stat.isFile() ? { path: candidate, stat } : null;
  } catch {
    return null;
  }
}

async function serveStatic(req, res, staticRoot) {
  const parsed = requestPath(req);
  if (!parsed.ok) {
    sendText(res, parsed.status, parsed.message);
    return;
  }

  const urlPath = parsed.value;
  const relativeUrlPath = urlPath === "/" ? "index.html" : `.${urlPath}`;
  let candidate = path.resolve(staticRoot, relativeUrlPath);
  if (!isInside(staticRoot, candidate)) {
    sendText(res, 403, "forbidden");
    return;
  }

  let found = await statFile(candidate);
  if (found === null && path.extname(urlPath) === "") {
    candidate = path.join(staticRoot, "index.html");
    found = await statFile(candidate);
  }
  if (found === null || !isInside(staticRoot, found.path)) {
    sendText(res, 404, "not found");
    return;
  }

  let realFilePath;
  try {
    realFilePath = await fs.promises.realpath(found.path);
  } catch {
    sendText(res, 404, "not found");
    return;
  }
  if (!isInside(staticRoot, realFilePath)) {
    sendText(res, 403, "forbidden");
    return;
  }

  const ext = path.extname(found.path).toLowerCase();
  const isHtml = ext === ".html";
  const headers = {
    "content-type": MIME[ext] || "application/octet-stream",
    "content-length": found.stat.size,
    "cache-control": isHtml ? "no-store" : "public, max-age=3600",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
  };
  res.writeHead(200, headers);
  if ((req.method || "GET").toUpperCase() === "HEAD") {
    res.end();
    return;
  }

  const stream = fs.createReadStream(realFilePath);
  stream.on("error", () => {
    if (!res.headersSent) {
      sendText(res, 500, "static read error");
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
}

function clientKey(req, trustProxy) {
  if (trustProxy) {
    const cfIp = req.headers["cf-connecting-ip"];
    if (typeof cfIp === "string" && cfIp.trim() !== "") return `cf:${cfIp.trim()}`;
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.trim() !== "") {
      return `xff:${forwarded.split(",", 1)[0].trim()}`;
    }
  }
  return `socket:${req.socket.remoteAddress || "unknown"}`;
}

function createRateLimiter({ limit, windowMs, trustProxy }) {
  const buckets = new Map();
  let requestsSincePrune = 0;

  return function allow(req) {
    const now = Date.now();
    if (++requestsSincePrune >= 200) {
      requestsSincePrune = 0;
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
      }
      if (buckets.size > 5000) buckets.clear();
    }

    const key = clientKey(req, trustProxy);
    let bucket = buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    return {
      allowed: bucket.count <= limit,
      remaining: Math.max(0, limit - bucket.count),
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  };
}

function loadApiHandler(appRoot) {
  const entry = path.resolve(appRoot, "server", "app.js");
  if (!isInside(appRoot, entry) || !fs.existsSync(entry)) {
    throw new Error(`API entry not found: ${entry}`);
  }
  // The compiled CommonJS module exports createServer and does not call start()
  // when it is required by this gateway.
  const apiModule = require(entry);
  if (typeof apiModule.createServer !== "function") {
    throw new Error("server/app.js must export createServer()");
  }
  const apiServer = apiModule.createServer();
  const listeners = apiServer.listeners("request");
  if (listeners.length !== 1 || typeof listeners[0] !== "function") {
    throw new Error("createServer() must register exactly one request listener");
  }
  return { apiServer, apiHandler: listeners[0] };
}

function createGateway(options) {
  const requestedStaticRoot = path.resolve(options.staticRoot);
  const apiHandler = options.apiHandler;
  const apiContext = options.apiContext || null;
  const rateLimit = options.rateLimit ?? DEFAULT_RATE_LIMIT;
  const rateWindowMs = options.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS;
  const maxApiBodyBytes = options.maxApiBodyBytes ?? DEFAULT_MAX_API_BODY_BYTES;
  const trustProxy = options.trustProxy === true;
  const allowApi = createRateLimiter({ limit: rateLimit, windowMs: rateWindowMs, trustProxy });
  const runtimeConfig = options.runtimeConfig || {};
  const proxyAmap = createAmapProxyHandler({
    securityJsCode: options.amapSecurityJsCode || "",
    jsApiKey: runtimeConfig.amapKey || "",
    timeoutMs: options.amapProxyTimeoutMs ?? DEFAULT_AMAP_PROXY_TIMEOUT_MS,
    requestImpl: options.amapHttpsRequest || https.request,
    rateLimit: options.amapProxyRateLimit ?? DEFAULT_AMAP_PROXY_RATE_LIMIT,
    rateWindowMs: options.amapProxyRateWindowMs ?? DEFAULT_AMAP_PROXY_RATE_WINDOW_MS,
    maxConcurrency: options.amapProxyMaxConcurrency ?? DEFAULT_AMAP_PROXY_MAX_CONCURRENCY,
  });

  if (typeof apiHandler !== "function") throw new TypeError("apiHandler must be a function");
  if (!fs.existsSync(requestedStaticRoot) || !fs.statSync(requestedStaticRoot).isDirectory()) {
    throw new Error(`static root not found: ${requestedStaticRoot}`);
  }
  const staticRoot = fs.realpathSync(requestedStaticRoot);

  const server = http.createServer((req, res) => {
    const rawUrl = req.url || "/";
    const method = (req.method || "GET").toUpperCase();
    const pathname = rawUrl.split("?", 1)[0];

    if (pathname === "/demo-config.js") {
      if (method !== "GET" && method !== "HEAD") {
        sendText(res, 405, "method not allowed", { allow: "GET, HEAD" });
        return;
      }
      sendJavaScript(res, 200, runtimeConfigScript(runtimeConfig), method);
      return;
    }

    if (pathname === AMAP_SERVICE_PREFIX || pathname.startsWith(`${AMAP_SERVICE_PREFIX}/`)) {
      proxyAmap(req, res);
      return;
    }

    if (rawUrl === "/api" || rawUrl.startsWith("/api/")) {
      const contentLength = Number(req.headers["content-length"] || 0);
      if (Number.isFinite(contentLength) && contentLength > maxApiBodyBytes) {
        sendJson(res, 413, { error: { code: "body_too_large", message: "request body too large" } });
        return;
      }

      // Health probes do not consume the public mutation/cost budget.
      if (!(method === "GET" && rawUrl.split("?", 1)[0] === "/api/health")) {
        const rate = allowApi(req);
        res.setHeader("x-ratelimit-limit", String(rateLimit));
        res.setHeader("x-ratelimit-remaining", String(rate.remaining));
        if (!rate.allowed) {
          sendJson(
            res,
            429,
            { error: { code: "rate_limited", message: "too many requests" } },
            { "retry-after": String(rate.retryAfterSeconds) },
          );
          return;
        }
      }

      try {
        Promise.resolve(apiHandler.call(apiContext, req, res)).catch(() => {
          if (!res.headersSent) sendJson(res, 500, { error: { code: "internal_error", message: "internal error" } });
          else res.destroy();
        });
      } catch {
        if (!res.headersSent) sendJson(res, 500, { error: { code: "internal_error", message: "internal error" } });
        else res.destroy();
      }
      return;
    }

    if (method !== "GET" && method !== "HEAD") {
      sendText(res, 405, "method not allowed", { allow: "GET, HEAD" });
      return;
    }
    void serveStatic(req, res, staticRoot).catch(() => {
      if (!res.headersSent) sendText(res, 500, "static error");
      else res.destroy();
    });
  });

  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  return server;
}

function startGateway() {
  const appRoot = path.resolve(process.env.APP_ROOT || process.cwd());
  const staticRoot = path.resolve(process.env.STATIC_ROOT || path.join(appRoot, "web"));
  const port = envInteger("PORT", DEFAULT_PORT, 1, 65535);
  const host = process.env.HOST || DEFAULT_HOST;
  const rateLimit = envInteger("API_RATE_LIMIT", DEFAULT_RATE_LIMIT, 1, 100_000);
  const rateWindowMs = envInteger("API_RATE_WINDOW_MS", DEFAULT_RATE_WINDOW_MS, 1000, 3_600_000);
  const maxApiBodyBytes = envInteger(
    "MAX_API_BODY_BYTES",
    DEFAULT_MAX_API_BODY_BYTES,
    1024,
    20 * 1024 * 1024,
  );
  const amapProxyTimeoutMs = envInteger(
    "AMAP_PROXY_TIMEOUT_MS",
    DEFAULT_AMAP_PROXY_TIMEOUT_MS,
    500,
    60_000,
  );
  const amapProxyRateLimit = envInteger(
    "AMAP_PROXY_RATE_LIMIT",
    DEFAULT_AMAP_PROXY_RATE_LIMIT,
    1,
    100_000,
  );
  const amapProxyRateWindowMs = envInteger(
    "AMAP_PROXY_RATE_WINDOW_MS",
    DEFAULT_AMAP_PROXY_RATE_WINDOW_MS,
    1_000,
    3_600_000,
  );
  const amapProxyMaxConcurrency = envInteger(
    "AMAP_PROXY_MAX_CONCURRENCY",
    DEFAULT_AMAP_PROXY_MAX_CONCURRENCY,
    1,
    100,
  );
  const trustProxy = process.env.TRUST_PROXY === "1";
  const { apiServer, apiHandler } = loadApiHandler(appRoot);
  const server = createGateway({
    staticRoot,
    apiHandler,
    apiContext: apiServer,
    rateLimit,
    rateWindowMs,
    maxApiBodyBytes,
    trustProxy,
    amapSecurityJsCode: process.env.AMAP_SECURITY_JS_CODE || "",
    amapProxyTimeoutMs,
    amapProxyRateLimit,
    amapProxyRateWindowMs,
    amapProxyMaxConcurrency,
    runtimeConfig: {
      amapKey: process.env.AMAP_JS_API_KEY || "",
      mapGeoJson: process.env.AMAP_MAP_GEO_JSON || "",
    },
  });

  server.on("error", (error) => {
    console.error(`[gateway] startup error: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    console.log(`[gateway] listening on http://${host}:${port}`);
    console.log(`[gateway] static=${staticRoot}; api=server/app.js; rate=${rateLimit}/${rateWindowMs}ms`);
    console.log(`[gateway] amap_proxy=${process.env.AMAP_SECURITY_JS_CODE ? "configured" : "disabled"}`);
  });

  const stop = () => server.close(() => process.exit(0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return server;
}

module.exports = {
  buildAmapUpstream,
  createAmapProxyHandler,
  createGateway,
  isInside,
  loadApiHandler,
  requestPath,
  runtimeConfigScript,
  startGateway,
};

if (require.main === module) {
  startGateway();
}
