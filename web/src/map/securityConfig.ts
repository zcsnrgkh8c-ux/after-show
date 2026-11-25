/** Both map entry points use the same same-origin proxy. No security secret is read by the browser. */
export function resolveAmapServiceHost(value: string | undefined, origin: string): string {
  const url = new URL(value?.trim() || "/_AMapService", origin);
  if (url.origin !== origin || url.pathname.replace(/\/$/, "") !== "/_AMapService" || url.search || url.hash || url.username || url.password) {
    throw new Error("高德代理配置无效：仅支持本站 /_AMapService");
  }
  return `${origin}/_AMapService`;
}

export function configureAmapProxy(serviceHost: string): void {
  const resolved = resolveAmapServiceHost(serviceHost, window.location.origin);
  // Replace any legacy clear-text config rather than merging it.
  window._AMapSecurityConfig = { serviceHost: resolved };
}
