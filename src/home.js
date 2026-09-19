import { createHomeModeReader, normalizeMode, readHomeMode } from "./home-state.js";

export function activateHomeMode({ api, root }) {
// 在顶部保持 Codex 模式时，为“新对话”页补回聊天 / Codex 选择器。
// 选择器只改变 Codex 原生的 Home 撰写器模式状态，发送、建会话、项目与
// 模型逻辑仍由客户端自己的组件处理。

const RUNTIME_KEY = Symbol.for(
  "codex-tweaks.codex-home-mode-toggle.runtime",
);
const ATOM_PATCH_MARKER = Symbol.for(
  "codex-tweaks.codex-home-mode-toggle.atom-patch",
);
const ROOT_MARKER = "data-codex-tweaks-codex-home-mode-toggle";
const ROOT_MODE_MARKER = "data-codex-tweaks-home-composer-mode";
const TOGGLE_MARKER = "data-codex-tweaks-home-mode-toggle";
const ANIMATE_MARKER = "data-codex-tweaks-home-mode-animate";
const BUTTON_MARKER = "data-codex-tweaks-home-mode-button";
const INDICATOR_MARKER = "data-codex-tweaks-home-mode-indicator";
const FIBER_PROPERTY_PREFIX = "__reactFiber$";
const SCAN_INTERVAL_MS = 1500;
const runtimeHost = root ?? document.documentElement;

runtimeHost[RUNTIME_KEY]?.cleanup?.();

let disposed = false;
let scanQueued = false;
let desiredMode = null;
let activeHomeInfo = null;
let patchedModeAtom = null;
let originalModeAtomRead = null;
let patchedModeAtomRead = null;
let patchedModeInfo = null;
let toggleNode = null;
let observedHeader = null;
let observedContent = null;
let warnedAboutUnsupportedClient = false;
const getHomeModeInfo = createHomeModeReader();
const positionObserver = new ResizeObserver(queueHomeScan);

function isVisible(element) {
  if (!(element instanceof Element)) return false;
  if (element.closest('[aria-hidden="true"], [inert]')) return false;
  const rect = element.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    getComputedStyle(element).visibility !== "hidden"
  );
}

function getReactFiber(element) {
  let current = element;

  while (current instanceof Element) {
    const propertyName = Object.getOwnPropertyNames(current).find((name) =>
      name.startsWith(FIBER_PROPERTY_PREFIX),
    );
    if (propertyName) return current[propertyName];
    current = current.parentElement;
  }

  return null;
}

function findHomeModeInfo() {
  const candidates = [
    ...document.querySelectorAll('[role="main"]'),
    ...document.querySelectorAll('[data-codex-intelligence-trigger="true"]'),
    document.querySelector("main"),
    document.querySelector("[data-codex-composer]"),
    ...document.querySelectorAll('[contenteditable="true"][role="textbox"]'),
  ].filter(isVisible);

  for (const element of new Set(candidates)) {
    let fiber = getReactFiber(element);
    let remainingDepth = 128;

    while (fiber && remainingDepth > 0) {
      const info = getHomeModeInfo(fiber);
      if (info) return info;
      fiber = fiber.return;
      remainingDepth -= 1;
    }
  }

  return null;
}

function restoreModeAtom() {
  const info = patchedModeInfo;
  const ownsPatch = info && info.atom.read === patchedModeAtomRead;
  if (ownsPatch) info.atom.read = originalModeAtomRead;
  patchedModeAtom = null;
  originalModeAtomRead = null;
  patchedModeAtomRead = null;
  patchedModeInfo = null;
  if (!ownsPatch) return;

  try {
    // 改回 read 函数并不会使原生 store 的缓存失效；沿原生偏好订阅链刷新，
    // 停用或离开首页后立即恢复客户端自己的模式判定。
    const { store, persistedAtom, atom } = info;
    const mode = store.get(persistedAtom);
    const nativeMode = Reflect.apply(atom.read, atom, [
      (dependency) => store.get(dependency),
    ]);
    if (store.get(atom) !== nativeMode) {
      try {
        store.set(persistedAtom, mode === "chat" ? "work" : "chat");
      } finally {
        store.set(persistedAtom, mode);
      }
    }
  } catch (error) {
    console.warn("[Codex Tweaks] 已恢复原生模式读取，未能立即刷新首页。", error);
  }
}

function patchModeAtom(info) {
  if (
    patchedModeAtom === info.atom &&
    patchedModeAtomRead &&
    info.atom.read === patchedModeAtomRead
  ) {
    return false;
  }

  restoreModeAtom();

  const stalePatch = info.atom.read?.[ATOM_PATCH_MARKER];
  if (typeof stalePatch?.originalRead === "function") {
    info.atom.read = stalePatch.originalRead;
  }

  patchedModeAtom = info.atom;
  patchedModeInfo = info;
  originalModeAtomRead = info.atom.read;
  patchedModeAtomRead = function codexTweaksHomeModeRead(get, options) {
    return readHomeMode(info, { get, options });
  };
  Object.defineProperty(patchedModeAtomRead, ATOM_PATCH_MARKER, {
    configurable: true,
    value: { originalRead: originalModeAtomRead },
  });
  info.atom.read = patchedModeAtomRead;
  return true;
}

function getHeaderHost() {
  const header = document.querySelector(
    'header[data-app-shell-header-layout], header[data-pip-obstacle="app-shell-header"]',
  );
  return isVisible(header) ? header : null;
}

function updateTogglePosition(header) {
  const surface = header.closest("[data-app-shell-main-surface]");
  const viewport = surface?.querySelector(
    "[data-app-shell-main-content-layout]",
  );
  const content = isVisible(viewport) ? viewport : surface ?? header;

  if (observedHeader !== header || observedContent !== content) {
    positionObserver.disconnect();
    positionObserver.observe(header);
    positionObserver.observe(content);
    observedHeader = header;
    observedContent = content;
  }

  // 标题栏左右按钮会随聊天 / Codex 模式变化；以主内容区域而非按钮之间
  // 剩余的 flex 空间居中，切换时两个标签的位置保持不变。
  const contentRect = content.getBoundingClientRect();
  const headerRect = header.getBoundingClientRect();
  const center = contentRect.left + contentRect.width / 2;
  toggleNode.style.setProperty(
    "--codex-tweaks-home-mode-x",
    `${center - headerRect.left - header.clientLeft}px`,
  );
}

function createToggleNode() {
  const toggle = document.createElement("div");
  toggle.setAttribute(TOGGLE_MARKER, "");
  toggle.setAttribute("role", "group");
  toggle.setAttribute("aria-label", "新对话模式");

  const surface = document.createElement("span");
  surface.setAttribute("data-codex-tweaks-home-mode-surface", "");
  surface.setAttribute("aria-hidden", "true");

  const indicator = document.createElement("span");
  indicator.setAttribute(INDICATOR_MARKER, "");
  indicator.setAttribute("aria-hidden", "true");

  for (const [mode, label] of [
    ["chat", "聊天"],
    ["work", "Codex"],
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.setAttribute(BUTTON_MARKER, mode);
    toggle.append(button);
  }

  toggle.prepend(surface, indicator);
  return toggle;
}

function ensureToggleNode() {
  const headerHost = getHeaderHost();
  if (!headerHost) return null;

  if (!toggleNode?.isConnected) {
    toggleNode = createToggleNode();
    // 在插入和测量之前设好选中项，避免首帧从默认位置播放一次切换。
    updateToggleNode();
    headerHost.append(toggleNode);
  } else if (toggleNode.parentElement !== headerHost) {
    headerHost.append(toggleNode);
  }
  updateTogglePosition(headerHost);

  return toggleNode;
}

function updateToggleNode({ animate = false } = {}) {
  const toggle = toggleNode;
  const mode = normalizeMode(desiredMode) ?? "work";
  if (!toggle) return;

  const previousMode = toggle.getAttribute("data-codex-tweaks-home-mode");
  if (previousMode !== mode) {
    toggle.toggleAttribute(
      ANIMATE_MARKER,
      animate && toggle.isConnected && normalizeMode(previousMode) !== null,
    );
    toggle.setAttribute("data-codex-tweaks-home-mode", mode);
  }

  for (const button of toggle.querySelectorAll(`[${BUTTON_MARKER}]`)) {
    const selected = button.getAttribute(BUTTON_MARKER) === mode;
    button.setAttribute("aria-pressed", String(selected));
    button.toggleAttribute("data-codex-tweaks-home-mode-selected", selected);
    const nextMode = button.getAttribute(BUTTON_MARKER);
    button.disabled =
      !activeHomeInfo ||
      readHomeMode(activeHomeInfo, { mode: nextMode }) !== nextMode;
  }

  document.documentElement.setAttribute(ROOT_MODE_MARKER, mode);
}

function applyHomeMode(mode, { animate = false } = {}) {
  const nextMode = normalizeMode(mode);
  if (!nextMode || disposed) return;

  try {
    const freshInfo = findHomeModeInfo();
    if (!freshInfo || freshInfo.scope !== activeHomeInfo?.scope) return;
    if (freshInfo.store.get(freshInfo.productModeAtom) !== false) return;
    if (readHomeMode(freshInfo, { mode: nextMode }) !== nextMode) return;
    desiredMode = nextMode;
    const { store, persistedAtom } = freshInfo;

    // 当持久值已是目标模式、但 Codex 原生派生值仍强制为 work 时，先写入
    // 相反值再写回目标值，以触发同一条原生订阅链重新计算。
    if (
      freshInfo.persistedMode === nextMode &&
      freshInfo.effectiveMode !== nextMode
    ) {
      try {
        store.set(persistedAtom, nextMode === "chat" ? "work" : "chat");
      } finally {
        store.set(persistedAtom, nextMode);
      }
    } else {
      store.set(persistedAtom, nextMode);
    }
    updateToggleNode({ animate });
    queueHomeScan();
  } catch (error) {
    desiredMode = activeHomeInfo?.effectiveMode ?? "work";
    updateToggleNode();
    if (!warnedAboutUnsupportedClient) {
      warnedAboutUnsupportedClient = true;
      console.warn("[Codex Tweaks] 无法切换新对话模式。", error);
    }
  }
}

function removeToggleNode() {
  positionObserver.disconnect();
  observedHeader = null;
  observedContent = null;
  toggleNode?.remove();
  toggleNode = null;
  document.documentElement.removeAttribute(ROOT_MARKER);
  document.documentElement.removeAttribute(ROOT_MODE_MARKER);
}

function hideHomeMode() {
  removeToggleNode();
  // 首页模式 atom 属于应用作用域。跨页面保留适配，返回首页时原生组件
  // 首次读取就能得到已选模式；完整恢复只在停用或替换该 atom 时进行。
  desiredMode = null;
  activeHomeInfo = null;
}

function scanHomeMode() {
  scanQueued = false;
  if (disposed || !document.body) return;

  const info = findHomeModeInfo();
  if (!info || info.store.get(info.productModeAtom) !== false) {
    hideHomeMode();
    return;
  }

  const homeChanged = activeHomeInfo?.scope !== info.scope;
  desiredMode = normalizeMode(readHomeMode(info)) ?? info.effectiveMode;

  activeHomeInfo = info;
  const atomChanged = patchModeAtom(info);
  document.documentElement.setAttribute(ROOT_MARKER, "");
  ensureToggleNode();
  updateToggleNode();

  if (
    (homeChanged || atomChanged) &&
    desiredMode !== info.effectiveMode
  ) {
    applyHomeMode(desiredMode);
  }
}

function queueHomeScan() {
  if (disposed || scanQueued) return;
  scanQueued = true;
  queueMicrotask(scanHomeMode);
}

function handleToggleClick(event) {
  const button = event.target?.closest?.(`[${BUTTON_MARKER}]`);
  if (!button?.closest(`[${TOGGLE_MARKER}]`)) return;

  event.preventDefault();
  event.stopPropagation();
  applyHomeMode(button.getAttribute(BUTTON_MARKER), { animate: true });
}

const homeObserver = new MutationObserver(queueHomeScan);
homeObserver.observe(document.body, { childList: true, subtree: true });
const scanInterval = window.setInterval(queueHomeScan, SCAN_INTERVAL_MS);
document.addEventListener("click", handleToggleClick);

function cleanup() {
  if (disposed) return;
  disposed = true;
  homeObserver.disconnect();
  window.clearInterval(scanInterval);
  document.removeEventListener("click", handleToggleClick);
  removeToggleNode();
  restoreModeAtom();
  activeHomeInfo = null;
  desiredMode = null;

  if (runtimeHost[RUNTIME_KEY]?.cleanup === cleanup) {
    delete runtimeHost[RUNTIME_KEY];
  }
}

runtimeHost[RUNTIME_KEY] = { cleanup };
api.registerCleanup(cleanup);
scanHomeMode();
}
