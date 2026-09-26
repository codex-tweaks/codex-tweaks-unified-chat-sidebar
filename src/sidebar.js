export function activateSidebar({ api, root }) {
// 在顶部保持 Codex 模式时，仅把侧栏的项目/最近数据视图接到 ChatGPT
// 已有的统一工作侧栏。列表、筛选、导航和项目操作仍由 Codex 原生组件处理。

const RUNTIME_KEY = Symbol.for("codex-tweaks.unified-chat-sidebar.runtime");
const SIDEBAR_WRAPPER_MARKER = Symbol.for(
  "codex-tweaks.unified-chat-sidebar.component-wrapper",
);
const ROOT_MARKER = "data-codex-tweaks-unified-chat-sidebar";
const SECTION_MARKER = "data-codex-tweaks-unified-sidebar-section";
const SOURCE_MARKER = "data-codex-tweaks-unified-sidebar-source";
const SOURCE_ROW_MARKER = "data-codex-tweaks-unified-sidebar-source-row";
const SOURCE_LABEL_MARKER = "data-codex-tweaks-unified-sidebar-source-label";
const SOURCE_CREATED_LABEL_MARKER =
  "data-codex-tweaks-unified-sidebar-created-source-label";
const SOURCE_NATIVE_LABEL_MARKER =
  "data-codex-tweaks-unified-sidebar-native-source-label";
const SOURCE_CREATED_CONTAINER_MARKER =
  "data-codex-tweaks-unified-sidebar-created-source-container";
const FIBER_PROPERTY_PREFIX = "__reactFiber$";
const SCAN_INTERVAL_MS = 5000;
const runtimeHost = root ?? document.documentElement;

runtimeHost[RUNTIME_KEY]?.cleanup?.();

let disposed = false;
let scanQueued = false;
let activeSidebarFiber = null;
let warnedAboutUnsupportedSidebar = false;
const patchedFiberTypes = new Map();
const sidebarWrappersByType = new WeakMap();

function isVisible(element) {
  if (!(element instanceof Element)) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function getProductMode() {
  for (const button of document.querySelectorAll(
    'nav[role="navigation"] button[aria-haspopup="menu"]',
  )) {
    if (!isVisible(button)) continue;
    const mode = button.getAttribute("aria-label")
      ?.match(/(?:[：:]\s*)(Codex|ChatGPT)\s*$/)?.[1];
    if (mode) return mode;
    const label = button.textContent.trim();
    if (label === "Codex" || label === "ChatGPT") return label;
  }
  return null;
}

function getReactFiber(element) {
  if (!(element instanceof Element)) return null;
  const propertyName = Object.getOwnPropertyNames(element).find((name) =>
    name.startsWith(FIBER_PROPERTY_PREFIX),
  );
  return propertyName ? element[propertyName] : null;
}

function getFiberProps(fiber) {
  return fiber?.memoizedProps ?? fiber?.pendingProps ?? null;
}

function isUnifiedSidebarFiber(fiber) {
  const props = getFiberProps(fiber);
  return (
    props != null &&
    typeof props === "object" &&
    "catalogPageScope" in props &&
    "catalogSourcesReady" in props &&
    "codexFeaturesAllowed" in props &&
    "sidebarMode" in props &&
    "workCloudSidebarContentVisible" in props &&
    "workLocalSidebarContentVisible" in props
  );
}

function findUnifiedSidebarFiber(section) {
  let fiber = getReactFiber(section);

  while (fiber) {
    if (isUnifiedSidebarFiber(fiber)) return fiber;
    fiber = fiber.return;
  }

  return null;
}

function getFiberPair(fiber) {
  return [...new Set([fiber, fiber?.alternate].filter(Boolean))];
}

function getSidebarWrapper(component) {
  let wrapper = sidebarWrappersByType.get(component);
  if (wrapper) return wrapper;

  // 只在统一侧栏组件的边界覆盖 sidebarMode。React 后续的数据更新会继续
  // 复用这个组件类型，因此无需在每次“最近”更新后再派发一次强制刷新。
  wrapper = function codexTweaksUnifiedSidebar(props, ...rest) {
    return Reflect.apply(
      component,
      this,
      [{ ...props, sidebarMode: "chatgpt" }, ...rest],
    );
  };
  Object.defineProperty(wrapper, SIDEBAR_WRAPPER_MARKER, {
    value: component,
  });
  sidebarWrappersByType.set(component, wrapper);
  return wrapper;
}

function findRefreshHook(fiber) {
  for (const candidate of getFiberPair(fiber)) {
    let hook = candidate.memoizedState;

    while (hook) {
      if (
        hook.memoizedState instanceof Map &&
        typeof hook.queue?.dispatch === "function"
      ) {
        return hook;
      }
      hook = hook.next;
    }
  }

  return null;
}

function refreshSidebar(fiber) {
  const hook = findRefreshHook(fiber);
  if (!hook) return false;

  try {
    hook.queue.dispatch(new Map(hook.memoizedState));
    return true;
  } catch (error) {
    if (!warnedAboutUnsupportedSidebar) {
      warnedAboutUnsupportedSidebar = true;
      console.warn(
        "[Codex Tweaks] 无法刷新统一聊天侧栏；客户端内部结构可能已变化。",
        error,
      );
    }
    return false;
  }
}

function patchSidebar(fiber) {
  let changed = false;

  for (const candidate of getFiberPair(fiber)) {
    const originalType =
      candidate.type?.[SIDEBAR_WRAPPER_MARKER] ?? candidate.type;
    if (typeof originalType !== "function") continue;

    const wrapper = getSidebarWrapper(originalType);
    patchedFiberTypes.set(candidate, originalType);
    if (candidate.type === wrapper) continue;

    candidate.type = wrapper;
    changed = true;
  }

  activeSidebarFiber = fiber;
  // 首次安装组件包装时刷新一次；普通任务创建、发消息和标题更新不会再走这里。
  if (changed) refreshSidebar(fiber);
}

function restorePatchedFibers(refresh) {
  let changed = false;

  for (const [fiber, originalType] of patchedFiberTypes) {
    if (fiber?.type?.[SIDEBAR_WRAPPER_MARKER] !== originalType) continue;
    fiber.type = originalType;
    changed = true;
  }
  patchedFiberTypes.clear();

  if (changed && refresh && activeSidebarFiber) {
    refreshSidebar(activeSidebarFiber);
  }

  activeSidebarFiber = null;
}

function getSidebarItemKey(element) {
  let fiber = getReactFiber(element);
  let remainingDepth = 24;

  while (fiber && remainingDepth > 0) {
    for (const props of [fiber.memoizedProps, fiber.pendingProps]) {
      const item = props?.item;
      if (
        typeof item === "string" &&
        /^(?:chatgpt:(?:conversation|project)|codex:(?:thread|project)):/.test(
          item,
        )
      ) {
        return item;
      }
    }

    fiber = fiber.return;
    remainingDepth -= 1;
  }

  return null;
}

function normalizeItemSource(source) {
  return source === "chatgpt" || source === "codex" ? source : null;
}

function classifyNativeEntry(entry) {
  if (!entry) return null;

  // ChatGPT 会为云端 Codex 工作复用 conversation 渲染项，因而键仍以
  // chatgpt:conversation: 开头。原生 target.source 才是业务来源真值。
  const targetSource = normalizeItemSource(entry.target?.source);
  const entrySource = normalizeItemSource(entry.source);
  if (targetSource === "codex" && entrySource === "chatgpt") {
    return "codex-cloud";
  }
  return targetSource ?? entrySource;
}

function findNativeSourceMaps(item) {
  let fiber = getReactFiber(item);
  let remainingDepth = 96;

  while (fiber && remainingDepth > 0) {
    for (const props of [fiber.memoizedProps, fiber.pendingProps]) {
      if (props == null || typeof props !== "object") continue;
      if (
        props.projectByKey instanceof Map ||
        props.conversationByKey instanceof Map
      ) {
        return {
          projectByKey: props.projectByKey,
          conversationByKey: props.conversationByKey,
        };
      }
    }

    fiber = fiber.return;
    remainingDepth -= 1;
  }

  return null;
}

function getNativeItemSource(itemKey, item, sourceMaps) {
  if (!itemKey) return null;

  const knownMap = itemKey.includes(":project:")
    ? sourceMaps?.projectByKey
    : sourceMaps?.conversationByKey;
  const knownSource = classifyNativeEntry(
    knownMap instanceof Map ? knownMap.get(itemKey) : null,
  );
  if (knownSource) return knownSource;

  let fiber = getReactFiber(item);
  let remainingDepth = 96;

  while (fiber && remainingDepth > 0) {
    for (const props of [fiber.memoizedProps, fiber.pendingProps]) {
      if (props == null || typeof props !== "object") continue;

      const map = itemKey.includes(":project:")
        ? props.projectByKey
        : props.conversationByKey;
      const entry = map instanceof Map ? map.get(itemKey) : null;
      const source = classifyNativeEntry(entry);
      if (source) return source;
    }

    fiber = fiber.return;
    remainingDepth -= 1;
  }

  return null;
}

function getItemSource(itemKey, item, sourceMaps) {
  const nativeSource = getNativeItemSource(itemKey, item, sourceMaps);
  if (nativeSource) return nativeSource;

  if (itemKey?.startsWith("chatgpt:")) return "chatgpt";
  if (itemKey?.startsWith("codex:")) return "codex";

  if (
    item.matches("[data-sidebar-chatgpt-conversation-key]") ||
    item.querySelector("[data-sidebar-chatgpt-conversation-key]")
  ) {
    return "chatgpt";
  }

  if (
    item.matches("[data-app-action-sidebar-thread-row]") ||
    item.querySelector(
      "[data-app-action-sidebar-thread-row], " +
        "[data-app-action-sidebar-project-row]",
    )
  ) {
    return "codex";
  }

  return null;
}

function clearManagedSourceElement(element) {
  if (element.hasAttribute(SOURCE_CREATED_LABEL_MARKER)) {
    element.remove();
    return;
  }
  element.removeAttribute(SOURCE_ROW_MARKER);
  element.removeAttribute(SOURCE_MARKER);
  element.removeAttribute(SOURCE_LABEL_MARKER);
  element.removeAttribute(SOURCE_CREATED_LABEL_MARKER);
  element.removeAttribute(SOURCE_NATIVE_LABEL_MARKER);
}

function clearOrphanedSourceContainers(scope = document) {
  for (const container of scope.querySelectorAll(
    `[${SOURCE_CREATED_CONTAINER_MARKER}]`,
  )) {
    if (container.querySelector(`[${SOURCE_CREATED_LABEL_MARKER}]`)) continue;
    container.removeAttribute(SOURCE_CREATED_CONTAINER_MARKER);
  }
}

function clearOrphanedNativeSourceLabels(scope = document) {
  for (const nativeLabel of scope.querySelectorAll(
    `[${SOURCE_NATIVE_LABEL_MARKER}]`,
  )) {
    if (
      nativeLabel.parentElement?.querySelector(
        `[${SOURCE_CREATED_LABEL_MARKER}]`,
      )
    ) {
      continue;
    }
    nativeLabel.removeAttribute(SOURCE_NATIVE_LABEL_MARKER);
  }
}

function clearSourceMarkers(scope = document) {
  for (const element of scope.querySelectorAll(
    `[${SOURCE_ROW_MARKER}], [${SOURCE_MARKER}], ` +
      `[${SOURCE_NATIVE_LABEL_MARKER}]`,
  )) {
    clearManagedSourceElement(element);
  }

  clearOrphanedSourceContainers(scope);
  clearOrphanedNativeSourceLabels(scope);
}

function createOwnedSourceLabel(insertionPoint) {
  const label = document.createElement("span");
  label.setAttribute(SOURCE_CREATED_LABEL_MARKER, "");
  insertionPoint.after(label);
  return label;
}

function findOrCreateThreadSourceLabel(row, sourceLabel) {
  const titleTrigger = row.querySelector('[data-thread-title-trigger="true"]');
  if (!titleTrigger) return null;

  const existingLabel = titleTrigger.querySelector(
    `[${SOURCE_CREATED_LABEL_MARKER}]`,
  );
  if (existingLabel instanceof HTMLSpanElement) return existingLabel;

  const titleContainer = titleTrigger?.querySelector(":scope > span");
  const nativeLabel = titleContainer
    ? [...titleContainer.children].find(
      (element) =>
        element instanceof HTMLSpanElement &&
        !element.hasAttribute("data-thread-title") &&
        element.classList.contains("shrink-0") &&
        element.classList.contains("text-tertiary"),
      )
    : null;

  const title = titleTrigger.querySelector(
    '[data-thread-title="true"]',
  );
  if (!(title instanceof HTMLSpanElement)) return null;

  if (nativeLabel?.textContent.trim() === sourceLabel) {
    nativeLabel.removeAttribute(SOURCE_NATIVE_LABEL_MARKER);
    return nativeLabel;
  }

  if (nativeLabel) {
    nativeLabel.setAttribute(SOURCE_NATIVE_LABEL_MARKER, "");
    return createOwnedSourceLabel(nativeLabel);
  }

  // 不移动或包裹 React 管理的标题节点。直接插入独立标签，避免模式切换
  // 卸载时 React 仍按原父节点 removeChild 而触发 NotFoundError。
  const label = createOwnedSourceLabel(title);
  title.parentElement?.setAttribute(SOURCE_CREATED_CONTAINER_MARKER, "");
  return label;
}

function getNativeEnvironmentType(row) {
  let fiber = getReactFiber(row);
  let remainingDepth = 24;

  while (fiber && remainingDepth > 0) {
    for (const props of [fiber.memoizedProps, fiber.pendingProps]) {
      if (typeof props?.envType === "string") return props.envType;
    }
    fiber = fiber.return;
    remainingDepth -= 1;
  }

  return null;
}

function usesNativeCloudMarker(row, source) {
  if (source === "codex-cloud") return true;
  if (source !== "codex") return false;

  const environmentType = getNativeEnvironmentType(row);
  return (
    row.getAttribute("data-app-action-sidebar-thread-kind") === "remote" ||
    environmentType === "cloud" ||
    environmentType === "remote" ||
    environmentType === "remote-worktree"
  );
}

function markSectionSources(section, markedElements) {
  section.setAttribute(SECTION_MARKER, "threads");
  // 从任务标题定位实际行，包含项目中的任务与自定义分组，跳过项目本身。
  const rows = new Set(
    [...section.querySelectorAll('[data-thread-title-trigger="true"]')]
      .map((title) => title.closest(
        '[data-app-action-sidebar-thread-row], [role="button"]',
      ))
      .filter((row) => row && section.contains(row)),
  );
  const sourceMaps = findNativeSourceMaps(rows.values().next().value);

  for (const row of rows) {
    const item = row.closest('[role="listitem"]') ?? row;
    const source = getItemSource(getSidebarItemKey(item), item, sourceMaps);
    if (!source) continue;

    const effectiveSource = usesNativeCloudMarker(row, source)
      ? "codex-cloud"
      : source;
    item.setAttribute(SOURCE_MARKER, effectiveSource);
    row.setAttribute(SOURCE_MARKER, effectiveSource);
    markedElements.add(item);
    markedElements.add(row);

    const sourceLabel = effectiveSource === "chatgpt" ? "聊天" : "Codex";
    const managedSourceLabel = findOrCreateThreadSourceLabel(row, sourceLabel);
    if (!managedSourceLabel) continue;

    // 只会修改由 Tweaks 创建的文本节点；React 原生来源文字要么原样复用，
    // 要么通过标记隐藏，绝不替换其 textContent。
    if (
      managedSourceLabel.hasAttribute(SOURCE_CREATED_LABEL_MARKER) &&
      managedSourceLabel.textContent !== sourceLabel
    ) {
      managedSourceLabel.textContent = sourceLabel;
    }

    managedSourceLabel.setAttribute(SOURCE_ROW_MARKER, "");
    managedSourceLabel.setAttribute(SOURCE_MARKER, effectiveSource);
    managedSourceLabel.setAttribute(SOURCE_LABEL_MARKER, sourceLabel);
    markedElements.add(managedSourceLabel);
  }
}

function clearStaleSourceMarkers(markedElements) {
  for (const element of document.querySelectorAll(
    `[${SOURCE_ROW_MARKER}], [${SOURCE_MARKER}]`,
  )) {
    if (markedElements.has(element)) continue;
    clearManagedSourceElement(element);
  }
  clearOrphanedSourceContainers();
  clearOrphanedNativeSourceLabels();
}

function clearViewMarkers() {
  document.documentElement.removeAttribute(ROOT_MARKER);
  clearSourceMarkers();
  for (const section of document.querySelectorAll(`[${SECTION_MARKER}]`)) {
    section.removeAttribute(SECTION_MARKER);
  }
}

function markUnifiedView() {
  document.documentElement.setAttribute(ROOT_MARKER, "");
  const markedElements = new Set();
  const markedSections = new Set();

  // 自定义分组也能包含项目和聊天；按实际任务行处理，不依赖分组标题。
  for (const section of document.querySelectorAll(
    "section[data-app-action-sidebar-section]",
  )) {
    markSectionSources(section, markedElements);
    markedSections.add(section);
  }

  clearStaleSourceMarkers(markedElements);
  for (const section of document.querySelectorAll(`[${SECTION_MARKER}]`)) {
    if (!markedSections.has(section)) section.removeAttribute(SECTION_MARKER);
  }
}

function scanSidebar() {
  scanQueued = false;
  if (disposed || !document.body) return;

  const productMode = getProductMode();
  if (productMode !== "Codex") {
    restorePatchedFibers(false);
    clearViewMarkers();
    return;
  }

  const section = document.querySelector(
    "section[data-app-action-sidebar-section]",
  );
  if (!section) return;

  const sidebarFiber = findUnifiedSidebarFiber(section);
  if (!sidebarFiber) {
    if (!warnedAboutUnsupportedSidebar) {
      warnedAboutUnsupportedSidebar = true;
      console.warn(
        "[Codex Tweaks] 未找到统一侧栏组件；客户端内部结构可能已变化。",
      );
    }
    return;
  }

  patchSidebar(sidebarFiber);
  markUnifiedView();
}

function queueSidebarScan() {
  if (disposed || scanQueued) return;
  scanQueued = true;
  queueMicrotask(scanSidebar);
}

const sidebarObserver = new MutationObserver(queueSidebarScan);
sidebarObserver.observe(document.body, { childList: true, subtree: true });
const scanInterval = window.setInterval(queueSidebarScan, SCAN_INTERVAL_MS);

function cleanup() {
  if (disposed) return;
  disposed = true;
  sidebarObserver.disconnect();
  window.clearInterval(scanInterval);
  restorePatchedFibers(true);
  clearViewMarkers();

  if (runtimeHost[RUNTIME_KEY]?.cleanup === cleanup) {
    delete runtimeHost[RUNTIME_KEY];
  }
}

runtimeHost[RUNTIME_KEY] = { cleanup };
api.registerCleanup(cleanup);
scanSidebar();
}
