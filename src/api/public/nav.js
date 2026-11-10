// 跨模块接线注册表：有些调用方在依赖图的下游，却要在运行时调上游的函数，
// 直接 import 会成环。调用方调这里的注册表函数，shell.js 在加载时注册真正实现。
// 目前两条：switchNav（dlq-view / send-view 用）和 revealApp（auth.js 的登录后引导用）。
let navImpl = null;
let revealImpl = null;

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
