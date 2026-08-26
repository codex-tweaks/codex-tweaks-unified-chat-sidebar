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
let toggleNode = null;
let nativeModeSetter = null;
let nativeModeSetterPromise = null;
let nativeModeSetterFailed = false;
let warnedAboutUnsupportedClient = false;

function isVisible(element) {
  if (!(element instanceof Element)) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function getProductMode() {
  for (const button of document.querySelectorAll(
    'button[aria-label^="切换模式，当前模式："], button[aria-haspopup="menu"]',
  )) {
    if (!isVisible(button)) continue;
    const label = button.textContent.trim();
    if (label === "Codex" || label === "ChatGPT") return label;
  }
  return null;
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

function getHook(fiber, index) {
  let hook = fiber?.memoizedState ?? null;
  let remaining = index;

  while (hook && remaining > 0) {
    hook = hook.next;
    remaining -= 1;
  }

  return hook;
}

function normalizeMode(mode) {
  return mode === "chat" || mode === "work" ? mode : null;
}

function getHomeModeInfo(fiber) {
  const scope = getHook(fiber, 0)?.memoizedState?.current;
  const persistedMode = normalizeMode(getHook(fiber, 2)?.memoizedState);
  const effectiveMode = normalizeMode(getHook(fiber, 6)?.memoizedState);
  const atomPair = getHook(fiber, 5)?.memoizedState?.[1];
  const atom = Array.isArray(atomPair) ? atomPair[1] : null;

  if (
    scope?.value?.routeKind !== "home" ||
    typeof scope.get !== "function" ||
    typeof scope.set !== "function" ||
    !persistedMode ||
    !effectiveMode ||
    typeof atom?.read !== "function"
  ) {
    return null;
  }

  return { fiber, scope, atom, persistedMode, effectiveMode };
}

function findHomeModeInfo() {
  const candidates = [
    ...document.querySelectorAll('[role="main"]'),
    ...document.querySelectorAll('[data-codex-intelligence-trigger="true"]'),
    document.querySelector("main"),
    document.querySelector("[data-codex-composer]"),
  ].filter(Boolean);

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
  if (
    patchedModeAtom &&
    patchedModeAtomRead &&
    patchedModeAtom.read === patchedModeAtomRead
  ) {
    patchedModeAtom.read = originalModeAtomRead;
  }

  patchedModeAtom = null;
  originalModeAtomRead = null;
  patchedModeAtomRead = null;
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
  originalModeAtomRead = info.atom.read;
  patchedModeAtomRead = function codexTweaksHomeModeRead(...args) {
    const nativeMode = Reflect.apply(originalModeAtomRead, this, args);
    return normalizeMode(desiredMode) ?? nativeMode;
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
    'header[data-pip-obstacle="app-shell-header"]',
  );
  if (!header) return null;

  return (
    [...header.children]
      .filter(
        (element) =>
          element.getAttribute("aria-hidden") === "false" &&
          isVisible(element),
      )
      .sort(
        (left, right) =>
          right.getBoundingClientRect().width -
          left.getBoundingClientRect().width,
      )[0] ?? null
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
    headerHost.append(toggleNode);
  } else if (toggleNode.parentElement !== headerHost) {
    headerHost.append(toggleNode);
  }

  return toggleNode;
}

function updateToggleNode() {
  const toggle = toggleNode?.isConnected ? toggleNode : null;
  const mode = normalizeMode(desiredMode) ?? "work";
  if (!toggle) return;

  toggle.setAttribute("data-codex-tweaks-home-mode", mode);
  toggle.toggleAttribute("aria-busy", !nativeModeSetter);

  for (const button of toggle.querySelectorAll(`[${BUTTON_MARKER}]`)) {
    const selected = button.getAttribute(BUTTON_MARKER) === mode;
    button.setAttribute("aria-pressed", String(selected));
    button.toggleAttribute("data-codex-tweaks-home-mode-selected", selected);
    button.disabled = nativeModeSetterFailed;
  }

  document.documentElement.setAttribute(ROOT_MODE_MARKER, mode);
}

async function loadNativeModeSetter() {
  if (nativeModeSetter) return nativeModeSetter;
  if (nativeModeSetterPromise) return nativeModeSetterPromise;

  nativeModeSetterPromise = (async () => {
    const entryScript = [...document.scripts].find((script) =>
      /\/assets\/index-[^/]+\.js$/.test(script.src),
    );
    if (!entryScript) throw new Error("未找到 Codex 入口脚本");

    const entrySource = await fetch(entryScript.src).then((response) => {
      if (!response.ok) throw new Error("无法读取 Codex 入口脚本");
      return response.text();
    });
    const assetName = entrySource.match(
      /\.\/(app-initial-[^"'`]+\.js)/,
    )?.[1];
    if (!assetName) throw new Error("未找到 Codex 初始资源");

    const assetUrl = new URL("./" + assetName, entryScript.src).href;
    const assetSource = await fetch(assetUrl).then((response) => {
      if (!response.ok) throw new Error("无法读取 Codex 初始资源");
      return response.text();
    });
    const definition = assetSource.match(
      /function ([\w$]+)\(([\w$]+),([\w$]+)\)\{\3===`chat`&&\2\.get\([\w$]+\)\|\|\2\.set\([\w$]+,\3\)\}/,
    );
    const functionName = definition?.[1] ?? "TW";
    const exportAlias = assetSource.match(
      new RegExp("\\b" + functionName + " as ([\\w$]+)"),
    )?.[1];
    if (!exportAlias) throw new Error("未找到原生撰写器模式切换函数");

    const appModule = await import(assetUrl);
    const setter = appModule[exportAlias];
    if (typeof setter !== "function") {
      throw new Error("原生撰写器模式切换函数不可用");
    }

    nativeModeSetter = setter;
    nativeModeSetterFailed = false;
    return setter;
  })().catch((error) => {
    nativeModeSetterFailed = true;
    if (!warnedAboutUnsupportedClient) {
      warnedAboutUnsupportedClient = true;
      console.warn(
        "[Codex Tweaks] 无法启用 Codex 新对话模式选择器；客户端内部结构可能已变化。",
        error,
      );
    }
    throw error;
  });

  return nativeModeSetterPromise;
}

async function applyHomeMode(mode) {
  const nextMode = normalizeMode(mode);
  if (!nextMode || disposed) return;

  desiredMode = nextMode;
  updateToggleNode();

  try {
    const setter = await loadNativeModeSetter();
    if (disposed || getProductMode() !== "Codex") return;

    const freshInfo = findHomeModeInfo();
    if (!freshInfo || freshInfo.scope !== activeHomeInfo?.scope) return;

    // 当持久值已是目标模式、但 Codex 原生派生值仍强制为 work 时，先写入
    // 相反值再写回目标值，以触发同一条原生订阅链重新计算。
    if (
      freshInfo.persistedMode === nextMode &&
      freshInfo.effectiveMode !== nextMode
    ) {
      setter(freshInfo.scope, nextMode === "chat" ? "work" : "chat");
    }
    setter(freshInfo.scope, nextMode);
    queueHomeScan();
  } catch {
    desiredMode = activeHomeInfo?.effectiveMode ?? "work";
    updateToggleNode();
  }
}

function removeToggleNode() {
  toggleNode?.remove();
  toggleNode = null;
  document.documentElement.removeAttribute(ROOT_MARKER);
  document.documentElement.removeAttribute(ROOT_MODE_MARKER);
}

function deactivateHomeMode() {
  removeToggleNode();
  restoreModeAtom();
  desiredMode = null;
  activeHomeInfo = null;
}

function scanHomeMode() {
  scanQueued = false;
  if (disposed || !document.body) return;

  if (getProductMode() !== "Codex") {
    deactivateHomeMode();
    return;
  }

  const info = findHomeModeInfo();
  if (!info) {
    deactivateHomeMode();
    return;
  }

  const homeChanged = activeHomeInfo?.scope !== info.scope;
  if (homeChanged || !desiredMode) {
    desiredMode = info.persistedMode ?? info.effectiveMode;
  }

  activeHomeInfo = info;
  const atomChanged = patchModeAtom(info);
  document.documentElement.setAttribute(ROOT_MARKER, "");
  ensureToggleNode();
  updateToggleNode();

  if (!nativeModeSetter && !nativeModeSetterFailed) {
    loadNativeModeSetter().then(queueHomeScan).catch(updateToggleNode);
  }

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
  applyHomeMode(button.getAttribute(BUTTON_MARKER));
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
