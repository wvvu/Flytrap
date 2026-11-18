// 网络请求封装：自动附带与刷新 CSRF 令牌，解析结构化错误原因。
import { state } from "./state.js";

export async function request(url, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const send = async (force) => {
    const headers = new Headers();
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      headers.set("x-csrf-token", await fetchCsrf(force));
    }
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
    }
    return fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: "same-origin",
    });
  };
  let response = await send(false);
  if (response.status === 403 && method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    const peek = await response.clone().json().catch(() => null);
    if (!peek || !peek.reason) {
      await response.text().catch(() => "");
      state.csrfToken = null;
      response = await send(true);
    }
  }
  const raw = await response.text();
  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }
  if (!response.ok) {
    const error = new Error((data && data.reason) || (data && data.error) || "request_failed");
    error.status = response.status;
    error.reason = data && typeof data.reason === "string" ? data.reason : "";
    throw error;
  }
  return data || {};
}

export async function fetchCsrf(force) {
  if (state.csrfToken && !force) return state.csrfToken;
  const response = await fetch("/v1/csrf", { credentials: "same-origin" });
  if (!response.ok) {
    const error = new Error("csrf");
    error.status = response.status;
    throw error;
  }
  const data = await response.json();
  state.csrfToken = data.token;
  return state.csrfToken;
}
