/**
 * Page-world script. Runs in the same JS realm as the Nadine Angular app.
 * Hooks fetch + XMLHttpRequest to capture the bearer token the moment the
 * app makes its first authenticated call to service.kemenkeu.go.id.
 *
 * Also intercepts PDF responses so the extension can extract text for
 * summarization without needing to re-download the file.
 *
 * Does not store the token here; posts it to the content script via
 * window.postMessage. Content script forwards to the service worker.
 */
(() => {
  const TARGET_HOSTS = ["service.kemenkeu.go.id", "satu-notif.kemenkeu.go.id"];
  const SIMAN_API_HOST = "siman-svc.kemenkeu.go.id";
  const TAG = "__asguard_token_probe__";

  if ((window as unknown as Record<string, unknown>)[TAG]) return;
  (window as unknown as Record<string, unknown>)[TAG] = true;

  function isTargetUrl(u: string | URL): boolean {
    try {
      const url = typeof u === "string" ? new URL(u, location.href) : u;
      return TARGET_HOSTS.includes(url.hostname);
    } catch {
      return false;
    }
  }

  function postToken(token: string, origin: string) {
    window.postMessage({ __asguard: true, kind: "token", token, origin }, "*");
  }

  function isSimanUrl(u: string | URL): boolean {
    try {
      const url = typeof u === "string" ? new URL(u, location.href) : u;
      return url.hostname === SIMAN_API_HOST;
    } catch { return false; }
  }

  function postSimanToken(token: string, origin: string) {
    window.postMessage({ __asguard: true, kind: "simanToken", token, origin }, "*");
  }

  function postSimanRoleData(roleData: Record<string, unknown>) {
    window.postMessage({ __asguard: true, kind: "simanRoleData", roleData }, "*");
  }

  function maybePostNdId(urlStr: string) {
    try {
      const m = urlStr.match(/\/DetailKonsepByNdId\/(\d+)/);
      if (m) {
        window.postMessage({ __asguard: true, kind: "ndId", ndId: m[1] }, "*");
      }
    } catch {
      /* ignore */
    }
  }

  function extractBearer(val: unknown): string | null {
    if (typeof val !== "string") return null;
    const m = val.match(/^Bearer\s+(.+)$/i);
    return m ? m[1].trim() : null;
  }

  /** Convert ArrayBuffer to base64 string */
  function arrayBufferToBase64(buffer: ArrayBuffer): string {
    return btoa(Array.from(new Uint8Array(buffer), (b) => String.fromCharCode(b)).join(""));
  }

  /** Check if a response is a PDF based on content-type or URL pattern */
  function isPdfResponse(res: Response, url: string): boolean {
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("application/pdf")) return true;
    // Some Nadine endpoints return octet-stream for PDFs
    if (ct.includes("application/octet-stream") && /\.(pdf)$/i.test(url)) return true;
    return false;
  }

  const origFetch = window.fetch.bind(window);
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    const url = typeof input === "string" || input instanceof URL ? input : input.url;
    const urlStr = typeof url === "string" ? url : url.toString();
    const isTarget = isTargetUrl(url);

    // Extract token (existing logic)
    try {
      if (isTarget) {
        let token: string | null = null;
        if (init?.headers) {
          const h = init.headers;
          if (h instanceof Headers) token = extractBearer(h.get("Authorization"));
          else if (Array.isArray(h)) {
            const pair = h.find(([k]) => k.toLowerCase() === "authorization");
            if (pair) token = extractBearer(pair[1]);
          } else {
            const rec = h as Record<string, string>;
            token = extractBearer(rec["Authorization"] ?? rec["authorization"]);
          }
        }
        if (!token && input instanceof Request) {
          token = extractBearer(input.headers.get("Authorization"));
        }
        if (token) postToken(token, urlStr);
        maybePostNdId(urlStr);

        // Intercept POST to create naskah — capture the payload for template saving
        // Angular HttpClient sends the body as a string, check both /konsepnaskah and /KonsepNaskah
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "POST") {
          const pathOnly = urlStr.split("?")[0];
          console.log(`[asguard] POST detected: ${pathOnly.slice(-80)}`);
          if (/\/konsepnaskah\/?$/i.test(pathOnly)) {
            try {
              const body = init?.body;
              let payloadStr: string | null = null;
              if (typeof body === "string") {
                payloadStr = body;
              } else if (body instanceof URLSearchParams) {
                payloadStr = body.toString();
              }
              if (payloadStr) {
                const payload = JSON.parse(payloadStr);
                console.log("[asguard] captured CreateNaskahPayload from fetch POST");
                window.postMessage(
                  { __asguard: true, kind: "createPayload", payload, url: urlStr },
                  "*",
                );
              }
            } catch {
              /* parse error — ignore */
            }
          }
        }
      } else if (isSimanUrl(url)) {
        // Intercept SIMAN outgoing request bodies we need to capture
        try {
          const pathOnly = urlStr.split("?")[0];
          // Capture penetapan-pengelolaan/get-data request body from SIMAN's own frontend
          if (pathOnly.includes("penetapan-pengelolaan/get-data")) {
            const bodyStr = init?.body;
            if (typeof bodyStr === "string") {
              try {
                const captured = JSON.parse(bodyStr) as Record<string, unknown>;
                console.log("[asguard] captured SIMAN penetapan body from frontend");
                window.postMessage({ __asguard: true, kind: "simanPenetapanBody", body: captured }, "*");
              } catch { /* ignore */ }
            }
          }
        } catch { /* ignore */ }

        try {
          let token: string | null = null;
          if (init?.headers) {
            const h = init.headers;
            if (h instanceof Headers) token = extractBearer(h.get("Authorization"));
            else if (Array.isArray(h)) {
              const pair = h.find(([k]) => k.toLowerCase() === "authorization");
              if (pair) token = extractBearer(pair[1]);
            } else {
              const rec = h as Record<string, string>;
              token = extractBearer(rec["Authorization"] ?? rec["authorization"]);
            }
          }
          if (!token && input instanceof Request) {
            token = extractBearer(input.headers.get("Authorization"));
          }
          if (token) postSimanToken(token, urlStr);
        } catch { /* never block real fetch */ }
      }
    } catch {
      /* never block the real fetch */
    }

    // Call original fetch then intercept PDF + SIMAN role responses
    return origFetch(input, init).then((res) => {
      if (isTarget) {
        try {
          if (isPdfResponse(res, urlStr)) {
            // Clone response so the page can still use it
            const clone = res.clone();
            clone
              .arrayBuffer()
              .then((buf) => {
                if (buf.byteLength > 0 && buf.byteLength < 10 * 1024 * 1024) {
                  // Max 10MB
                  const base64 = arrayBufferToBase64(buf);
                  console.log(
                    `[asguard] captured PDF from fetch: ${urlStr.slice(-60)} (${buf.byteLength} bytes)`,
                  );
                  window.postMessage(
                    { __asguard: true, kind: "pdf", base64, url: urlStr, size: buf.byteLength },
                    "*",
                  );
                }
              })
              .catch(() => {});
          }
        } catch {
          /* ignore */
        }
      }

      // Intercept SIMAN API responses to capture role context
      if (isSimanUrl(urlStr)) {
        try {
          const ct = (res.headers.get("content-type") || "").toLowerCase();
          if (ct.includes("application/json")) {
            const clone = res.clone();
            clone.json().then((body: unknown) => {
              try {
                const obj = body as Record<string, unknown>;
                // jwt-roles response: { status: true, tokens: { access_token: "..." } }
                const hasJwtToken = !!(obj.tokens && typeof obj.tokens === "object" && (obj.tokens as Record<string,unknown>).access_token);
                if (hasJwtToken) {
                  console.log("[asguard] intercepted SIMAN jwt-roles response");
                  postSimanRoleData({ token: (obj.tokens as Record<string,unknown>).access_token, ...obj });
                }
                // get-list-role-active-new response: array of roles
                if (Array.isArray(obj.data) && obj.data.length > 0 && (obj.data[0] as Record<string,unknown>).id_role) {
                  console.log("[asguard] intercepted SIMAN roles list");
                  postSimanRoleData({ roles: obj.data });
                }
                // user-detail-filter response: contains kpknl/kanwil/id_role/id_struktur info
                const fd = Array.isArray(obj.data) ? obj.data[0] as Record<string,unknown> : obj as Record<string,unknown>;
                if (fd && (fd.id_kpknl || fd.id_kanwil || fd.id_role)) {
                  console.log("[asguard] intercepted SIMAN filter/user-detail data, kpknl:", fd.id_kpknl);
                  postSimanRoleData({ filterData: fd });
                }
              } catch { /* parse error */ }
            }).catch(() => {});
          }
        } catch { /* ignore */ }
      }

      return res;
    });
  } as typeof window.fetch;

  // --- XHR hooks (token + PDF interception) ---

  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest & { __asguardUrl?: string; __asguardMethod?: string },
    method: string,
    url: string | URL,
    async?: boolean,
    user?: string | null,
    password?: string | null,
  ) {
    this.__asguardUrl = typeof url === "string" ? url : url.toString();
    this.__asguardMethod = method.toUpperCase();
    if (isTargetUrl(this.__asguardUrl)) maybePostNdId(this.__asguardUrl);
    // eslint-disable-next-line prefer-rest-params
    return origOpen.call(this, method, url, async ?? true, user ?? null, password ?? null);
  } as typeof XMLHttpRequest.prototype.open;

  XMLHttpRequest.prototype.setRequestHeader = function (
    this: XMLHttpRequest & { __asguardUrl?: string; __asguardMethod?: string },
    name: string,
    value: string,
  ) {
    try {
      if (name.toLowerCase() === "authorization" && this.__asguardUrl && isTargetUrl(this.__asguardUrl)) {
        const token = extractBearer(value);
        if (token) postToken(token, this.__asguardUrl);
      } else if (name.toLowerCase() === "authorization" && this.__asguardUrl && isSimanUrl(this.__asguardUrl)) {
        const token = extractBearer(value);
        if (token) postSimanToken(token, this.__asguardUrl);
      }
    } catch {
      /* ignore */
    }
    return origSetHeader.call(this, name, value);
  };

  // Intercept XHR send — capture POST /konsepnaskah body + PDF responses
  XMLHttpRequest.prototype.send = function (
    this: XMLHttpRequest & { __asguardUrl?: string; __asguardMethod?: string },
    body?: Document | XMLHttpRequestBodyInit | null,
  ) {
    const xhrUrl = this.__asguardUrl;
    const xhrMethod = this.__asguardMethod ?? "GET";

    if (xhrUrl && isTargetUrl(xhrUrl)) {
      // Capture CreateNaskahPayload from POST /konsepnaskah
      if (xhrMethod === "POST") {
        const pathOnly = xhrUrl.split("?")[0];
        console.log(`[asguard] XHR POST detected: ${pathOnly.slice(-80)}`);
        if (/\/konsepnaskah\/?$/i.test(pathOnly)) {
          try {
            if (typeof body === "string") {
              const payload = JSON.parse(body);
              console.log("[asguard] captured CreateNaskahPayload from XHR POST");
              window.postMessage(
                { __asguard: true, kind: "createPayload", payload, url: xhrUrl },
                "*",
              );
            }
          } catch {
            /* parse error — ignore */
          }
        }
      }

      this.addEventListener("load", () => {
        try {
          const ct = (this.getResponseHeader("content-type") || "").toLowerCase();
          if (ct.includes("application/pdf") || (ct.includes("octet-stream") && /\.pdf$/i.test(xhrUrl))) {
            if (this.response instanceof ArrayBuffer && this.response.byteLength > 0 && this.response.byteLength < 10 * 1024 * 1024) {
              const base64 = arrayBufferToBase64(this.response);
              console.log(
                `[asguard] captured PDF from XHR: ${xhrUrl.slice(-60)} (${this.response.byteLength} bytes)`,
              );
              window.postMessage(
                { __asguard: true, kind: "pdf", base64, url: xhrUrl, size: this.response.byteLength },
                "*",
              );
            }
          }
        } catch {
          /* ignore */
        }
      });
    }
    return origSend.call(this, body);
  } as typeof XMLHttpRequest.prototype.send;

  // --- Real-time localStorage / sessionStorage scan for SIMAN token ---
  // Angular SPAs often store JWT in localStorage under keys like 'token', 'access_token',
  // 'currentUser', etc. We scan on load and on every storage mutation.

  function looksLikeJwt(val: string): boolean {
    // A JWT has exactly 3 dot-separated base64url segments
    const parts = val.split(".");
    return parts.length === 3 && parts.every((p) => /^[A-Za-z0-9_\-]+$/.test(p));
  }

  function scanStorageForSimanToken() {
    if (!location.hostname.includes("siman")) return;
    const origin = location.href;
    const stores = [localStorage, sessionStorage];
    for (const store of stores) {
      try {
        for (let i = 0; i < store.length; i++) {
          const key = store.key(i);
          if (!key) continue;
          const val = store.getItem(key);
          if (!val) continue;

          // Direct JWT value
          if (looksLikeJwt(val)) {
            console.log(`[asguard] found JWT in storage[${key}], posting as simanToken`);
            postSimanToken(val, origin);
            continue;
          }

          // JSON object that might contain a token field or role data
          if (val.startsWith("{") || val.startsWith("[")) {
            try {
              const parsed = JSON.parse(val);
              const obj = (typeof parsed === "object" && !Array.isArray(parsed)) ? parsed as Record<string, unknown> : null;
              if (obj) {
                const candidate = String(
                  obj.token ?? obj.access_token ?? obj.accessToken ??
                  obj.jwt ?? obj.bearer ?? obj.id_token ?? "",
                );
                if (candidate && looksLikeJwt(candidate)) {
                  console.log(`[asguard] found JWT in storage[${key}].token, posting as simanToken`);
                  postSimanToken(candidate, origin);
                }
                // Check for role context data (kpknl, kanwil, role info)
                if (obj.id_kpknl || obj.id_kanwil || obj.id_role || obj.nm_role) {
                  console.log(`[asguard] found role data in storage[${key}]`);
                  postSimanRoleData({ storageKey: key, ...obj });
                }
              }
              // Array of roles
              if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].id_role) {
                console.log(`[asguard] found roles array in storage[${key}]`);
                postSimanRoleData({ roles: parsed });
              }
            } catch { /* not JSON */ }
          }
        }
      } catch { /* storage access denied */ }
    }
  }

  // Scan immediately on script load
  scanStorageForSimanToken();

  // Re-scan whenever Angular writes to storage (catches post-login token saves)
  window.addEventListener("storage", (ev) => {
    if (!location.hostname.includes("siman")) return;
    const val = ev.newValue;
    if (!val) return;
    const origin = location.href;
    if (looksLikeJwt(val)) {
      postSimanToken(val, origin);
    } else if (val.startsWith("{")) {
      try {
        const obj = JSON.parse(val) as Record<string, unknown>;
        const candidate = String(
          obj.token ?? obj.access_token ?? obj.accessToken ??
          obj.jwt ?? obj.bearer ?? obj.id_token ?? "",
        );
        if (candidate && looksLikeJwt(candidate)) {
          postSimanToken(candidate, origin);
        }
      } catch { /* not JSON */ }
    }
  });

  // Also patch localStorage.setItem to catch in-page writes (same-origin, no storage event fires)
  if (location.hostname.includes("siman")) {
    const origSetItem = localStorage.setItem.bind(localStorage);
    localStorage.setItem = function(key: string, value: string) {
      origSetItem(key, value);
      try {
        const origin = location.href;
        if (looksLikeJwt(value)) {
          postSimanToken(value, origin);
        } else if (value.startsWith("{")) {
          const obj = JSON.parse(value) as Record<string, unknown>;
          const candidate = String(
            obj.token ?? obj.access_token ?? obj.accessToken ??
            obj.jwt ?? obj.bearer ?? obj.id_token ?? "",
          );
          if (candidate && looksLikeJwt(candidate)) {
            postSimanToken(candidate, origin);
          }
        }
      } catch { /* ignore */ }
    };

    // Same for sessionStorage
    const origSessSetItem = sessionStorage.setItem.bind(sessionStorage);
    sessionStorage.setItem = function(key: string, value: string) {
      origSessSetItem(key, value);
      try {
        const origin = location.href;
        if (looksLikeJwt(value)) {
          postSimanToken(value, origin);
        } else if (value.startsWith("{")) {
          const obj = JSON.parse(value) as Record<string, unknown>;
          const candidate = String(
            obj.token ?? obj.access_token ?? obj.accessToken ??
            obj.jwt ?? obj.bearer ?? obj.id_token ?? "",
          );
          if (candidate && looksLikeJwt(candidate)) {
            postSimanToken(candidate, origin);
          }
        }
      } catch { /* ignore */ }
    };
  }
})();

