import { classifyUrl } from "./page-detector";
import { debugLog } from "@/shared/logging";
import type { BgMessage, PageContext } from "@/shared/types";

function send(msg: BgMessage) {
  chrome.runtime.sendMessage(msg).catch(() => {
    /* service worker may be asleep between navigations */
  });
}

function currentContext(): PageContext {
  return { url: location.href, page: classifyUrl(location.href) };
}

let lastUrl = "";
function emitPageIfChanged() {
  if (location.href === lastUrl) return;
  lastUrl = location.href;
  send({ type: "page/changed", ctx: currentContext() });
}

window.addEventListener("message", (ev) => {
  if (ev.source !== window) return;
  const d = ev.data as {
    __asguard?: boolean;
    kind?: string;
    token?: string;
    origin?: string;
    ndId?: string;
    base64?: string;
    url?: string;
    size?: number;
    payload?: Record<string, unknown>;
    roleData?: Record<string, unknown>;
    body?: Record<string, unknown>;
  };
  if (!d || !d.__asguard) return;
  if (d.kind === "token" && d.token && d.origin) {
    send({ type: "token/capture", token: d.token, origin: d.origin });
  } else if (d.kind === "ndId" && d.ndId) {
    send({ type: "viewing/ndId", ndId: d.ndId });
  } else if (d.kind === "pdf" && d.base64 && d.url) {
    // Forward captured PDF to background
    debugLog("[asguard] forwarding captured PDF", { size: d.size });
    send({ type: "pdf/captured", base64: d.base64, url: d.url, size: d.size ?? 0 });
  } else if (d.kind === "createPayload" && d.payload && d.url) {
    // Forward captured CreateNaskahPayload to background for template saving
    debugLog("[asguard] forwarding CreateNaskahPayload to background");
    send({ type: "naskah/created", payload: d.payload as Record<string, unknown>, url: d.url });
  } else if (d.kind === "simanToken" && d.token && d.origin) {
    send({ type: "siman/token", token: d.token, origin: d.origin });
  } else if (d.kind === "simanRoleData" && d.roleData) {
    send({ type: "siman/role-data", roleData: d.roleData });
  } else if (d.kind === "simanPenetapanBody" && d.body) {
    send({ type: "siman/penetapan-body", body: d.body });
  }
});

emitPageIfChanged();

window.addEventListener("popstate", emitPageIfChanged);
window.addEventListener("hashchange", emitPageIfChanged);

const origPush = history.pushState;
const origReplace = history.replaceState;
history.pushState = function (...args) {
  const r = origPush.apply(this, args as Parameters<typeof history.pushState>);
  queueMicrotask(emitPageIfChanged);
  return r;
};
history.replaceState = function (...args) {
  const r = origReplace.apply(this, args as Parameters<typeof history.replaceState>);
  queueMicrotask(emitPageIfChanged);
  return r;
};

debugLog("[asguard] content script ready", { host: location.hostname });

export {};
