import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildApi } from "../src/api/app.js";
import { gzipCodec } from "../src/compress.js";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { migrationsDir } from "../src/paths.js";

function cookieHeader(setCookie: string | string[] | undefined, current = ""): string {
  const jar = new Map<string, string>();
  for (const part of current.split(";").filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq > 0) jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  const lines = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const line of lines) {
    const pair = (line.split(";")[0] ?? "").trim();
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
}

test("the panel is static and the mail API stays behind the session", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-ui-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  const app = await buildApi({
    config: loadConfig({
      NODE_ENV: "test",
      ROLES: "api",
      MAIL_DATA_DIR: dir,
      ACCEPT_DOMAINS: "example.com",
      API_PASSWORD: "test-password-value",
      SESSION_SECRET: "0123456789abcdef0123456789abcdef",
      CLASSIFIER: "fake",
    }),
    db,
    codec: gzipCodec(),
    log: false,
  });
  try {
    const page = await app.inject({ method: "GET", url: "/" });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers["content-type"] ?? "", /text\/html/);
    assert.match(page.body, /\/app\.js/);
    assert.match(page.body, /\/app\.css/);
    assert.equal(page.body.includes("allow-same-origin"), false);
    assert.match(page.body, /sandbox=""/);
    assert.match(String(page.headers["content-security-policy"] ?? ""), /script-src 'self'/);

    const script = await app.inject({ method: "GET", url: "/app.js" });
    assert.equal(script.statusCode, 200);
    assert.match(script.headers["content-type"] ?? "", /javascript/);
    assert.match(script.body, /\/v1\/messages/);
    assert.match(script.body, /\/v1\/messages\/" \+ encodeURIComponent\(id\) \+ "\/reclassify/);
    assert.match(script.body, /x-csrf-token/);
    assert.match(page.body, /<title>登录<\/title>/);
    assert.match(page.body, /失败几次才停/);
    assert.match(page.body, /收信域名/);
    assert.equal(page.body.includes("security-banner"), false);
    assert.equal(page.body.includes("allow-scripts"), false);
    const guardAt = page.body.indexOf('id="preview-guard"');
    const imageAt = page.body.indexOf('id="btn-load-images"');
    assert.ok(guardAt > 0 && imageAt > guardAt);
    assert.match(page.body, /共 0 处外链资源未加载/);
    assert.match(script.body, /处外链资源未加载/);
    assert.match(script.body, /处外链资源已加载/);
    assert.match(page.body, /id="set-names"/);
    assert.match(page.body, /id="nav-spam"/);
    assert.match(page.body, /value="not-legit" selected/);
    assert.match(page.body, /id="label" type="hidden" value="legit"/);
    assert.match(page.body, /id="btn-open-dlq"/);
    assert.equal(page.body.includes('value="legit" selected'), false);
    assert.match(script.body, /\/v1\/unread/);
    assert.match(page.body, /末 4 位/);
    assert.match(page.body, /启用分拣/);
    assert.match(page.body, /id="password-next"/);
    assert.match(page.body, /id="log-view"/);
    assert.match(script.body, /mail-item unread|classList\.add\("unread"\)/);
    assert.match(script.body, /value === "pass" \|\| value === "none"/);
    assert.equal(/[你我他]/.test(page.body), false);
    assert.equal(/[你我他]/.test(script.body), false);
    assert.match(page.body, /已放过/);
    assert.match(script.body, /stripRemoteImages/);
    assert.match(script.body, /隐藏图片/);
    assert.match(page.body, /class="btn-fit"/);
    assert.match(script.body, /document\.title = "登录"/);
    assert.match(script.body, /document\.title = VIEW_TITLES\[view\]/);
    assert.match(script.body, /身份检查/);
    assert.match(script.body, /重分类/);
    assert.equal(script.body.includes("innerHTML"), false);
    assert.equal(page.body.includes("蜜罐"), false);
    assert.equal(page.body.includes("威胁研判"), false);
    assert.equal(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(page.body), false);
    assert.equal(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(script.body), false);

    const style = await app.inject({ method: "GET", url: "/app.css" });
    assert.equal(style.statusCode, 200);
    assert.match(style.headers["content-type"] ?? "", /text\/css/);

    const closed = await app.inject({ method: "GET", url: "/v1/messages" });
    assert.equal(closed.statusCode, 401);
    assert.deepEqual(closed.json(), { error: "unauthorized" });

    const anonymous = await app.inject({ method: "GET", url: "/%2e%2e/%2e%2e/package.json" });
    assert.equal(anonymous.statusCode, 401);
    assert.equal(anonymous.body.includes("better-sqlite3"), false);

    const csrf = await app.inject({ method: "GET", url: "/v1/csrf" });
    let cookie = cookieHeader(csrf.headers["set-cookie"]);
    const token = csrf.json().token as string;
    const login = await app.inject({
      method: "POST",
      url: "/v1/login",
      headers: { cookie, "x-csrf-token": token, "content-type": "application/json" },
      payload: { username: "admin", password: "test-password-value" },
    });
    assert.equal(login.statusCode, 200);
    cookie = cookieHeader(login.headers["set-cookie"], cookie);
    const escaped = await app.inject({ method: "GET", url: "/%2e%2e/%2e%2e/package.json", headers: { cookie } });
    assert.equal(escaped.statusCode, 404);
    assert.equal(escaped.body.includes("better-sqlite3"), false);
  } finally {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
