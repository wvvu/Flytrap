// 跨模块无环回调注册表，保持 ES 模块导入图为严格有向无环图 (DAG)。
let navImpl = null;
let revealImpl = null;

export function setSwitchNav(fn) {
  navImpl = fn;
}

export function switchNav(view, options) {
  if (!navImpl) throw new Error("switchNav not registered");
  return navImpl(view, options);
}

export function setRevealApp(fn) {
  revealImpl = fn;
}

export function revealApp() {
  if (!revealImpl) throw new Error("revealApp not registered");
  return revealImpl();
}
