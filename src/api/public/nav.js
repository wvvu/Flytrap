// 跨模块无环回调注册表：下游视图通过此注册表调用上层导航与写信动作，保证静态依赖图为严格 DAG。
let navImpl = null;
let revealImpl = null;
let composeImpl = null;

export function setSwitchNav(fn) {
  navImpl = fn;
}

export function switchNav(view) {
  if (!navImpl) throw new Error("switchNav not registered");
  return navImpl(view);
}

export function setRevealApp(fn) {
  revealImpl = fn;
}

export function revealApp() {
  if (!revealImpl) throw new Error("revealApp not registered");
  return revealImpl();
}

export function setOpenCompose(fn) {
  composeImpl = fn;
}

export function openCompose(options) {
  if (!composeImpl) return;
  return composeImpl(options);
}
