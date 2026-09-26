export function activateRefresh({ api, root }) {
// 在 Codex 的统一侧栏中，为“最近”标题栏补充 ChatGPT 侧任务的手动刷新。
// 原生目录读取器会先在临时状态中取回新页，再一次性替换现有条目；刷新期间
// 因而继续保留当前列表，不插入空态或加载占位。

const RUNTIME_KEY = Symbol.for(
  "codex-tweaks.unified-sidebar-refresh.runtime",
);
const UNIFIED_VIEW_MARKER = "data-codex-tweaks-unified-chat-sidebar";
const ROOT_MARKER = "data-codex-tweaks-unified-sidebar-refresh";
const BUTTON_MARKER = "data-codex-tweaks-unified-sidebar-refresh-button";
const REFRESHING_MARKER =
  "data-codex-tweaks-unified-sidebar-refreshing";
const FIBER_PROPERTY_PREFIX = "__reactFiber$";
const RECENTS_SELECTOR =
  'section[data-app-action-sidebar-section-heading="Recents"]';
const DEFAULT_LABEL = "刷新 ChatGPT 侧任务";
const BUSY_LABEL = "正在刷新 ChatGPT 侧任务";
const BUTTON_APPEARANCE_ATTRIBUTES = [
  "data-color",
  "data-variant",
  "data-size",
  "data-icon-size",
  "data-gutter-size",
  "data-uniform",
  "data-pill",
  "data-squircle",
  "data-optically-align",
];
const runtimeHost = root ?? document.documentElement;

runtimeHost[RUNTIME_KEY]?.cleanup?.();

let disposed = false;
let syncQueued = false;
let refreshInProgress = false;
let activeButton = null;

function getReactFiber(element) {
  if (!(element instanceof Element)) return null;
  const propertyName = Object.getOwnPropertyNames(element).find((name) =>
    name.startsWith(FIBER_PROPERTY_PREFIX),
  );
  return propertyName ? element[propertyName] : null;
}

function getFiberPair(fiber) {
  return [...new Set([fiber, fiber?.alternate].filter(Boolean))];
}

function isCatalogReader(value) {
  return (
    value != null &&
    typeof value === "object" &&
    Array.isArray(value.hostIds) &&
    typeof value.reconcileHosts === "function" &&
    value.service != null &&
    typeof value.service.requestSync === "function"
  );
}

function findCatalogReader(section) {
  let fiber = getReactFiber(section);
  let remainingFiberDepth = 160;

  while (fiber && remainingFiberDepth > 0) {
    for (const candidate of getFiberPair(fiber)) {
      let hook = candidate.memoizedState;
      let remainingHooks = 400;

      while (hook && remainingHooks > 0) {
        if (isCatalogReader(hook.memoizedState)) {
          return hook.memoizedState;
        }
        hook = hook.next;
        remainingHooks -= 1;
      }
    }

    fiber = fiber.return;
    remainingFiberDepth -= 1;
  }

  return null;
}

function isChatGptHostId(hostId) {
  return typeof hostId === "string" && /^chatgpt(?::|$)/.test(hostId);
}

async function refreshChatGptCatalog(section) {
  const reader = findCatalogReader(section);
  if (!reader) {
    throw new Error("未找到 Codex 原生任务目录读取器");
  }

  const chatGptHostIds = reader.hostIds.filter(isChatGptHostId);
  if (chatGptHostIds.length === 0) {
    throw new Error("当前侧栏没有可刷新的 ChatGPT 任务来源");
  }

  // 先要求 ChatGPT 主机立即同步，再让原生读取器重取对应来源。读取器内部
  // 使用临时条目集合完成请求，成功后才发布新快照，因此旧列表不会先消失。
  const status = await reader.service.requestSync(
    chatGptHostIds,
    "immediate",
  );
  if (status != null && typeof reader.updateStatus === "function") {
    reader.updateStatus(status);
  }
  await reader.reconcileHosts(chatGptHostIds);
}

function createRefreshIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  const path = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "path",
  );
  path.setAttribute(
    "d",
    "M3.50205 16.6664V13.3333C3.50205 12.9661 3.79982 12.6683 4.16709 12.6683H7.5001L7.63389 12.682C7.93696 12.7439 8.16514 13.0119 8.16514 13.3333C8.16514 13.6547 7.93696 13.9227 7.63389 13.9847L7.5001 13.9984H5.47471C6.58687 15.2249 8.21848 16.0013 10.0001 16.0013C13.06 16.0013 15.586 13.711 15.9552 10.7513L15.9854 10.6195C16.0846 10.3266 16.3786 10.1335 16.6974 10.1732C17.0617 10.2186 17.3198 10.551 17.2745 10.9154L17.2247 11.2523C16.6301 14.7051 13.6225 17.3313 10.0001 17.3314C8.01108 17.3314 6.17193 16.5383 4.83213 15.2474V16.6664C4.83213 17.0335 4.53416 17.3312 4.16709 17.3314C3.79982 17.3314 3.50205 17.0336 3.50205 16.6664ZM4.04502 9.24936C3.99941 9.61354 3.66706 9.87179 3.30283 9.82651C2.93839 9.78106 2.67926 9.44877 2.72471 9.08432L4.04502 9.24936ZM10.0001 2.6683C11.994 2.66834 13.8372 3.46552 15.1778 4.76205V3.33334C15.1778 2.96617 15.4757 2.66846 15.8429 2.6683C16.2101 2.6683 16.5079 2.96607 16.5079 3.33334V6.66635C16.5079 7.03362 16.2101 7.33139 15.8429 7.33139H12.5099C12.1426 7.33139 11.8448 7.03362 11.8448 6.66635C11.845 6.29923 12.1427 6.00131 12.5099 6.00131H14.5255C13.4134 4.77489 11.7816 3.99842 10.0001 3.99838C6.94004 3.99838 4.41411 6.28948 4.04502 9.24936L3.38486 9.16635L2.72471 9.08432C3.1758 5.46703 6.26081 2.6683 10.0001 2.6683Z",
  );
  path.setAttribute("fill", "currentColor");
  svg.append(path);
  return svg;
}

function updateButtonState(button) {
  if (!(button instanceof HTMLButtonElement)) return;

  button.disabled = refreshInProgress;
  button.toggleAttribute("data-disabled", refreshInProgress);
  button.setAttribute(
    "aria-label",
    refreshInProgress ? BUSY_LABEL : DEFAULT_LABEL,
  );
  button.setAttribute("title", DEFAULT_LABEL);
  if (refreshInProgress) {
    button.setAttribute("aria-busy", "true");
    button.setAttribute(REFRESHING_MARKER, "");
  } else {
    button.removeAttribute("aria-busy");
    button.removeAttribute(REFRESHING_MARKER);
  }
}

function setRefreshInProgress(value) {
  refreshInProgress = value;
  updateButtonState(activeButton);
}

async function handleRefreshClick(event) {
  event.preventDefault();
  event.stopPropagation();
  if (disposed || refreshInProgress) return;

  const section = document.querySelector(RECENTS_SELECTOR);
  if (!section) return;

  setRefreshInProgress(true);
  try {
    await refreshChatGptCatalog(section);
  } catch (error) {
    console.warn(
      "[Codex Tweaks] 无法刷新 ChatGPT 侧任务；已保留当前最近列表。",
      error,
    );
  } finally {
    setRefreshInProgress(false);
  }
}

function disposeButton() {
  if (!activeButton) return;
  activeButton.removeEventListener("click", handleRefreshClick);
  activeButton.remove();
  activeButton = null;
}

function getRefreshPlacement() {
  const section = document.querySelector(RECENTS_SELECTOR);
  const sectionToggle = section?.querySelector(
    "button[data-app-action-sidebar-section-toggle]",
  );
  const header = sectionToggle?.parentElement?.parentElement?.parentElement;
  const actionsRoot = header?.lastElementChild;
  if (!(actionsRoot instanceof HTMLElement)) return null;

  const nativeButtons = [...actionsRoot.querySelectorAll("button")].filter(
    (button) => !button.hasAttribute(BUTTON_MARKER),
  );
  if (nativeButtons.length < 3) return null;

  const actionGroup = nativeButtons[0].parentElement;
  const newConversationButton = nativeButtons.at(-1);
  if (!(actionGroup instanceof HTMLElement) || !newConversationButton) {
    return null;
  }
  if (!actionGroup.contains(newConversationButton)) return null;

  let insertionAnchor = newConversationButton;
  while (
    insertionAnchor.parentElement &&
    insertionAnchor.parentElement !== actionGroup
  ) {
    insertionAnchor = insertionAnchor.parentElement;
  }
  if (insertionAnchor.parentElement !== actionGroup) return null;

  return {
    actionGroup,
    insertionAnchor,
    referenceButton: newConversationButton,
  };
}

function syncButtonAppearance(button, referenceButton) {
  // 新版原生按钮通过 data-* 选择尺寸、颜色和形状，class 本身不包含这些信息。
  // 仅复用表现属性，保留刷新按钮自己的无障碍语义和交互状态。
  button.className = referenceButton.className;
  for (const attribute of BUTTON_APPEARANCE_ATTRIBUTES) {
    const value = referenceButton.getAttribute(attribute);
    if (value == null) button.removeAttribute(attribute);
    else button.setAttribute(attribute, value);
  }
  const referenceContent = referenceButton.firstElementChild;
  button.firstElementChild.className =
    referenceContent instanceof HTMLSpanElement ? referenceContent.className : "";
}

function createButton(referenceButton) {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute(BUTTON_MARKER, "");
  const content = document.createElement("span");
  content.append(createRefreshIcon());
  button.append(content);
  syncButtonAppearance(button, referenceButton);
  button.addEventListener("click", handleRefreshClick);
  updateButtonState(button);
  return button;
}

function syncRefreshButton() {
  syncQueued = false;
  if (disposed || !document.body) return;

  if (!document.documentElement.hasAttribute(UNIFIED_VIEW_MARKER)) {
    disposeButton();
    document.documentElement.removeAttribute(ROOT_MARKER);
    return;
  }

  const placement = getRefreshPlacement();
  if (!placement) {
    disposeButton();
    document.documentElement.removeAttribute(ROOT_MARKER);
    return;
  }

  document.documentElement.setAttribute(ROOT_MARKER, "");
  if (
    activeButton?.isConnected &&
    activeButton.parentElement === placement.actionGroup
  ) {
    syncButtonAppearance(activeButton, placement.referenceButton);
    updateButtonState(activeButton);
    return;
  }

  disposeButton();
  for (const staleButton of document.querySelectorAll(`[${BUTTON_MARKER}]`)) {
    staleButton.remove();
  }

  activeButton = createButton(placement.referenceButton);
  placement.actionGroup.insertBefore(activeButton, placement.insertionAnchor);
}

function queueButtonSync() {
  if (disposed || syncQueued) return;
  syncQueued = true;
  queueMicrotask(syncRefreshButton);
}

const sidebarObserver = new MutationObserver(queueButtonSync);
sidebarObserver.observe(document.documentElement, {
  attributes: true,
  attributeFilter: [UNIFIED_VIEW_MARKER],
  childList: true,
  subtree: true,
});

function cleanup() {
  if (disposed) return;
  disposed = true;
  sidebarObserver.disconnect();
  disposeButton();
  document.documentElement.removeAttribute(ROOT_MARKER);

  if (runtimeHost[RUNTIME_KEY]?.cleanup === cleanup) {
    delete runtimeHost[RUNTIME_KEY];
  }
}

runtimeHost[RUNTIME_KEY] = { cleanup };
api.registerCleanup(cleanup);
syncRefreshButton();
}
