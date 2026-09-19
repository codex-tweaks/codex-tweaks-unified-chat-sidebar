const MODE_PREFERENCE_KEY = "home-composer-mode-v1";
const ATOM_PATCH_MARKER = Symbol.for(
  "codex-tweaks.codex-home-mode-toggle.atom-patch",
);

export function normalizeMode(mode) {
  return mode === "chat" || mode === "work" ? mode : null;
}

function isStore(value) {
  return (
    typeof value?.get === "function" &&
    typeof value.set === "function" &&
    typeof value.sub === "function"
  );
}

function findModePreference(scope) {
  for (let node = scope.node; node; node = node.parent) {
    if (!(node.familyBindings instanceof Map)) continue;

    for (const bindings of node.familyBindings.values()) {
      if (!(bindings instanceof Map)) continue;
      for (const binding of bindings.values()) {
        const value = binding?.value;
        if (value?.key === MODE_PREFERENCE_KEY && value.value$?.atom) {
          return value.value$.atom;
        }
      }
    }
  }
  return null;
}

function readDependencies(atom, store) {
  const dependencies = new Set();
  const read = atom.read?.[ATOM_PATCH_MARKER]?.originalRead ?? atom.read;
  Reflect.apply(read, atom, [
    (dependency) => {
      dependencies.add(dependency);
      return store.get(dependency);
    },
  ]);
  return [...dependencies];
}

function findPersistedModeAtom(atom, store, preference, seen = new Set()) {
  if (!atom || atom === preference || seen.has(atom) || seen.size >= 16) {
    return null;
  }
  seen.add(atom);

  const dependencies = readDependencies(atom, store);
  // 使用原生偏好设置的可写外层 atom，让客户端继续负责持久化。
  // 直接写 value$ 只会改变内存值，重启后会丢失选择。
  if (typeof atom.write === "function" && dependencies.includes(preference)) {
    return atom;
  }

  for (const dependency of dependencies) {
    const value = store.get(dependency);
    if (!normalizeMode(value) && value !== undefined) continue;
    const persisted = findPersistedModeAtom(
      dependency,
      store,
      preference,
      seen,
    );
    if (persisted) return persisted;
  }
  return null;
}

function getSubscription(hook) {
  const dependencies = hook.memoizedState?.[1];
  if (!Array.isArray(dependencies)) return null;

  const [source, atom] = dependencies;
  if (isStore(source) && typeof atom?.read === "function") {
    return { store: source, atom };
  }
  if (isStore(source?.store) && typeof source.atom?.read === "function") {
    return { store: source.store, atom: source.atom };
  }
  return null;
}

function findModeBinding(atom, store, preference) {
  const dependencies = readDependencies(atom, store);
  const productModeAtom = dependencies.find((dependency) => {
    if (typeof store.get(dependency) !== "boolean") return false;
    const inputs = readDependencies(dependency, store);
    // 原生订阅还可能带有生命周期依赖，不能假定模式是唯一依赖。
    return inputs.some((input) =>
      ["STEPS_PROSE", "STEPS_COMMANDS", "STEPS_EXECUTION"].includes(
        store.get(input),
      ),
    );
  });
  if (!productModeAtom) return null;

  for (const persistedModeAtom of dependencies) {
    const mode = store.get(persistedModeAtom);
    if (!normalizeMode(mode) && mode !== undefined) continue;
    const persistedAtom = findPersistedModeAtom(
      persistedModeAtom,
      store,
      preference,
    );
    if (persistedAtom) {
      return { productModeAtom, persistedModeAtom, persistedAtom };
    }
  }
  return null;
}

export function readHomeMode(info, { get, options, mode } = {}) {
  const read = info.atom.read?.[ATOM_PATCH_MARKER]?.originalRead ?? info.atom.read;
  const readValue = get ?? ((atom) => info.store.get(atom));
  return Reflect.apply(read, info.atom, [
    (dependency, ...args) => {
      const value = readValue(dependency, ...args);
      // 只让原生模式判定认为首页处于统一产品视图。账户、工作区权限和
      // 工作模式可用性仍由同一个原生 read 函数决定。
      if (dependency === info.productModeAtom) return true;
      if (dependency === info.persistedModeAtom && normalizeMode(mode)) return mode;
      return value;
    },
    options,
  ]);
}

export function createHomeModeReader() {
  const bindings = new WeakMap();

  return function getHomeModeInfo(fiber) {
    const hooks = [];
    for (
      let hook = fiber?.memoizedState;
      hook && hooks.length < 256;
      hook = hook.next
    ) {
      hooks.push(hook);
    }
    const scope = hooks
      .map((hook) => hook.memoizedState?.current)
      .find(
        (value) =>
          value?.value?.routeKind === "home" && isStore(value.node?.store),
      );
    if (!scope) return null;

    for (const hook of hooks) {
      const subscription = getSubscription(hook);
      if (!subscription || subscription.store !== scope.node.store) continue;
      const { store, atom } = subscription;
      if (typeof atom.write === "function") continue;

      try {
        const effectiveMode = normalizeMode(store.get(atom));
        if (!effectiveMode) continue;

        let binding = bindings.get(atom);
        if (!binding) {
          const preference = findModePreference(scope);
          if (!preference) continue;
          binding = findModeBinding(atom, store, preference);
          if (!binding) continue;
          bindings.set(atom, binding);
        }

        return {
          scope,
          store,
          atom,
          ...binding,
          persistedMode: normalizeMode(store.get(binding.persistedAtom)),
          effectiveMode,
        };
      } catch {
        // 不识别的订阅不应阻断其他首页组件的发现。
      }
    }
    return null;
  };
}
