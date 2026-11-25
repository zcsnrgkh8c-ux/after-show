"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const test = require("node:test");

const {
  buildAmapUpstream,
  createAmapProxyHandler,
  createGateway,
  runtimeConfigScript,
} = require("./gateway.cjs");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function fakeHttpsRequest(calls, response = { statusCode: 200, body: "ok" }) {
  return (url, options, callback) => {
    calls.push({ url, options });
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = (error) => {
      if (error) queueMicrotask(() => request.emit("error", error));
    };
    request.end = () => {
      const upstream = Readable.from([response.body]);
      upstream.statusCode = response.statusCode;
      upstream.headers = { "content-type": "application/json" };
      callback(upstream);
    };
    return request;
  };
}

test("runtime config 仅暴露前端必需字段且不回显安全密钥", () => {
  const source = runtimeConfigScript({
    amapKey: "public-js-key",
    mapGeoJson: '{"coordVerified":false}',
    securityJsCode: "must-never-appear",
  });
  assert.match(source, /window\.__DEMO_CONFIG__/);
  assert.match(source, /"amapServiceHost":"\/_AMapService"/);
  assert.match(source, /"apiBaseUrl":""/);
  assert.doesNotMatch(source, /securityJsCode|must-never-appear/);
});

test("动态 /demo-config.js 覆盖旧静态文件并强制 no-store", async () => {
  const staticRoot = fs.mkdtempSync(path.join(os.tmpdir(), "after-show-gateway-test-"));
  fs.writeFileSync(path.join(staticRoot, "index.html"), "ok", "utf8");
  fs.writeFileSync(
    path.join(staticRoot, "demo-config.js"),
    'window.__DEMO_CONFIG__={securityJsCode:"old-static-secret"};',
    "utf8",
  );
  const server = createGateway({
    staticRoot,
    apiHandler: (_req, res) => res.end(),
    runtimeConfig: { amapKey: "current-public-key", mapGeoJson: "{}" },
    amapSecurityJsCode: "server-only-secret",
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test address");

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/demo-config.js`);
    const source = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") || "", /no-store/);
    assert.match(source, /current-public-key/);
    assert.doesNotMatch(source, /old-static-secret|server-only-secret|securityJsCode/);
  } finally {
    await close(server);
    fs.rmSync(staticRoot, { recursive: true, force: true });
  }
});

test("代理上游主机和路径固定，客户端不能覆盖 jscode 或目标主机", () => {
  const upstream = buildAmapUpstream(
    "/_AMapService/v3/direction/walking?origin=1,2&destination=https://evil.example/&jscode=client&JsCoDe=client2",
    "server-secret",
    "server-public-key",
  );
  assert.equal(upstream.protocol, "https:");
  assert.equal(upstream.hostname, "restapi.amap.com");
  assert.equal(upstream.pathname, "/v3/direction/walking");
  assert.equal(upstream.searchParams.get("destination"), "https://evil.example/");
  assert.deepEqual(upstream.searchParams.getAll("jscode"), ["server-secret"]);
  assert.deepEqual(upstream.searchParams.getAll("key"), ["server-public-key"]);

  const style = buildAmapUpstream(
    "/_AMapService/v4/map/styles?styleid=x&key=client-key",
    "server-secret",
    "server-public-key",
  );
  assert.equal(style.hostname, "webapi.amap.com");
  assert.equal(style.pathname, "/v4/map/styles");

  assert.throws(
    () =>
      buildAmapUpstream(
        "/_AMapService/https://evil.example/path",
        "server-secret",
        "server-public-key",
      ),
    /not allowed/,
  );
  assert.throws(
    () =>
      buildAmapUpstream(
        "/_AMapService/v3/%2e%2e/private",
        "server-secret",
        "server-public-key",
      ),
    /not allowed/,
  );
});

test("代理只接受 GET/HEAD，成功响应不回显服务端安全密钥", async () => {
  const calls = [];
  const handler = createAmapProxyHandler({
    securityJsCode: "server-secret",
    jsApiKey: "server-public-key",
    requestImpl: fakeHttpsRequest(calls),
    timeoutMs: 1000,
  });
  const server = http.createServer(handler);
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test address");

  try {
    const getResponse = await fetch(
      `http://127.0.0.1:${address.port}/_AMapService/v3/place/text?keywords=test&jscode=client`,
    );
    assert.equal(getResponse.status, 200);
    assert.equal(await getResponse.text(), "ok");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.hostname, "restapi.amap.com");
    assert.deepEqual(calls[0].url.searchParams.getAll("jscode"), ["server-secret"]);

    const postResponse = await fetch(
      `http://127.0.0.1:${address.port}/_AMapService/v3/place/text`,
      { method: "POST" },
    );
    assert.equal(postResponse.status, 405);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(await postResponse.text(), /server-secret/);
  } finally {
    await close(server);
  }
});

test("合法 JSONP callback 保持 wrapper 并以 JavaScript + nosniff 返回", async () => {
  const calls = [];
  const jsonp = 'AMap._callback_123({"status":"1","info":"OK","pois":[]})';
  const handler = createAmapProxyHandler({
    securityJsCode: "server-secret",
    jsApiKey: "server-public-key",
    requestImpl: fakeHttpsRequest(calls, { statusCode: 200, body: jsonp }),
  });
  const server = http.createServer(handler);
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test address");

  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/_AMapService/v3/place/text?keywords=test&callback=AMap._callback_123`,
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /^application\/javascript/i);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await response.text(), jsonp);
    assert.equal(calls.length, 1);
  } finally {
    await close(server);
  }
});

test("恶意或重复 JSONP callback 在访问上游前被拒绝", async () => {
  const calls = [];
  const handler = createAmapProxyHandler({
    securityJsCode: "server-secret",
    jsApiKey: "server-public-key",
    requestImpl: fakeHttpsRequest(calls),
  });
  const server = http.createServer(handler);
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test address");

  try {
    const base = `http://127.0.0.1:${address.port}/_AMapService/v3/place/text?keywords=test`;
    const malicious = await fetch(`${base}&callback=${encodeURIComponent("x);alert(1)//")}`);
    assert.equal(malicious.status, 404);
    const duplicate = await fetch(`${base}&callback=one&callback=two`);
    assert.equal(duplicate.status, 404);
    assert.equal(calls.length, 0);
  } finally {
    await close(server);
  }
});

test("上游失败被严格收敛，不透传可能含凭据的错误体", async () => {
  const calls = [];
  const handler = createAmapProxyHandler({
    securityJsCode: "server-secret",
    jsApiKey: "server-public-key",
    requestImpl: fakeHttpsRequest(calls, {
      statusCode: 403,
      body: "upstream echoed server-secret",
    }),
  });
  const server = http.createServer(handler);
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test address");

  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/_AMapService/v3/place/text?keywords=test`,
    );
    assert.equal(response.status, 502);
    assert.equal(await response.text(), "map service unavailable");
  } finally {
    await close(server);
  }
});

test("地图代理独立限制每来源请求频率", async () => {
  const calls = [];
  const handler = createAmapProxyHandler({
    securityJsCode: "server-secret",
    jsApiKey: "server-public-key",
    requestImpl: fakeHttpsRequest(calls),
    rateLimit: 1,
    rateWindowMs: 60_000,
    maxConcurrency: 12,
  });
  const server = http.createServer(handler);
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test address");

  try {
    const url = `http://127.0.0.1:${address.port}/_AMapService/v3/place/text?keywords=test`;
    assert.equal((await fetch(url)).status, 200);
    const limited = await fetch(url, { headers: { "x-forwarded-for": "203.0.113.77" } });
    assert.equal(limited.status, 429);
    assert.equal(calls.length, 1);
  } finally {
    await close(server);
  }
});

test("地图代理进程级并发上限拒绝额外上游调用", async () => {
  let pendingRequest;
  let notifyStarted;
  const started = new Promise((resolve) => {
    notifyStarted = resolve;
  });
  const requestImpl = () => {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = (error) => {
      if (error) queueMicrotask(() => request.emit("error", error));
    };
    request.end = () => notifyStarted();
    pendingRequest = request;
    return request;
  };
  const handler = createAmapProxyHandler({
    securityJsCode: "server-secret",
    jsApiKey: "server-public-key",
    requestImpl,
    rateLimit: 100,
    maxConcurrency: 1,
  });
  const server = http.createServer(handler);
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test address");

  try {
    const url = `http://127.0.0.1:${address.port}/_AMapService/v3/place/text?keywords=test`;
    const first = fetch(url);
    await started;
    const second = await fetch(url);
    assert.equal(second.status, 429);
    pendingRequest.destroy(new Error("finish test request"));
    assert.equal((await first).status, 502);
  } finally {
    await close(server);
  }
});

test("地图上游超时严格返回 504 且不泄露凭据", async () => {
  const requestImpl = () => {
    const request = new EventEmitter();
    request.setTimeout = (_timeoutMs, onTimeout) => {
      queueMicrotask(onTimeout);
      return request;
    };
    request.destroy = (error) => {
      if (error) queueMicrotask(() => request.emit("error", error));
    };
    request.end = () => undefined;
    return request;
  };
  const handler = createAmapProxyHandler({
    securityJsCode: "server-secret",
    jsApiKey: "server-public-key",
    requestImpl,
    timeoutMs: 1,
  });
  const server = http.createServer(handler);
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test address");

  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/_AMapService/v3/place/text?keywords=test`,
    );
    assert.equal(response.status, 504);
    assert.equal(await response.text(), "map service unavailable");
  } finally {
    await close(server);
  }
});

