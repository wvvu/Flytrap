import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const PANEL_FILES: Record<string, { name: string; type: string }> = {
  "/": { name: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { name: "index.html", type: "text/html; charset=utf-8" },
  "/boot.js": { name: "boot.js", type: "text/javascript; charset=utf-8" },
  "/app.css": { name: "app.css", type: "text/css; charset=utf-8" },
  "/app.js": { name: "app.js", type: "text/javascript; charset=utf-8" },
  "/constants.js": { name: "constants.js", type: "text/javascript; charset=utf-8" },
  "/state.js": { name: "state.js", type: "text/javascript; charset=utf-8" },
  "/dom.js": { name: "dom.js", type: "text/javascript; charset=utf-8" },
  "/util.js": { name: "util.js", type: "text/javascript; charset=utf-8" },
  "/net.js": { name: "net.js", type: "text/javascript; charset=utf-8" },
  "/ui.js": { name: "ui.js", type: "text/javascript; charset=utf-8" },
  "/nav.js": { name: "nav.js", type: "text/javascript; charset=utf-8" },
  "/shell.js": { name: "shell.js", type: "text/javascript; charset=utf-8" },
  "/auth.js": { name: "auth.js", type: "text/javascript; charset=utf-8" },
  "/mail-view.js": { name: "mail-view.js", type: "text/javascript; charset=utf-8" },
  "/dlq-view.js": { name: "dlq-view.js", type: "text/javascript; charset=utf-8" },
  "/settings-view.js": { name: "settings-view.js", type: "text/javascript; charset=utf-8" },
  "/send-view.js": { name: "send-view.js", type: "text/javascript; charset=utf-8" },
};

/** Paths the login page needs before a session exists. */
export function isPanelAsset(urlPath: string): boolean {
  return Object.prototype.hasOwnProperty.call(PANEL_FILES, urlPath);
}

/** Serve the no-build panel. File names are a fixed map, never the request path. */
export function registerPanel(app: FastifyInstance): void {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
  for (const [url, file] of Object.entries(PANEL_FILES)) {
    app.get(url, async (_request, reply) => {
      try {
        const body = await readFile(path.join(root, file.name));
        return reply.type(file.type).header("cache-control", "no-cache").send(body);
      } catch (err) {
        if (isEnoent(err)) return reply.code(404).send({ error: "not_found" });
        throw err;
      }
    });
  }
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}
