// 跨模块回调注册表：保持 ES 模块导入图严格有向无环（DAG）。
let navImpl = null;
let revealImpl = null;
let resetComposeImpl = null;

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

export function setResetCompose(fn) {
  resetComposeImpl = fn;
}

export function resetCompose() {
  if (resetComposeImpl) resetComposeImpl();
}
