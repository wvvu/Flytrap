// 导航注册表：dlq-view / send-view 需要切栏目，但 shell.js 又要引用它们，
// 直接 import 会成环。视图模块调这里的 switchNav，shell.js 在加载时注册真正实现。
let impl = null;

export function setSwitchNav(fn) {
  impl = fn;
}

export function switchNav(view) {
  if (!impl) throw new Error("switchNav not registered");
  return impl(view);
}
