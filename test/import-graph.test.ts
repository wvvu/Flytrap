// The panel JS is split into ES modules. A cycle between modules is a latent
// white-screen risk: ESM only tolerates it while every cross-cycle binding is
// a hoisted function declaration called lazily. If anyone adds a top-level
// cross-cycle call, the TDZ fires at load. This test keeps the graph a DAG.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const publicDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "api",
  "public",
);

test("panel ES modules: import graph has no cycles", () => {
  const files = readdirSync(publicDir).filter((f) => f.endsWith(".js"));
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const src = readFileSync(path.join(publicDir, file), "utf8");
    const deps = [...src.matchAll(/from "\.\/([^"]+)"/g)]
      .map((m) => m[1])
      .filter((dep): dep is string => typeof dep === "string");
    for (const dep of deps) {
      assert.ok(files.includes(dep), `${file} imports missing module ${dep}`);
    }
    graph.set(file, deps);
  }

  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const visit = (node: string): void => {
    state.set(node, "visiting");
    stack.push(node);
    for (const dep of graph.get(node) ?? []) {
      if (state.get(dep) === "visiting") {
        cycles.push([...stack.slice(stack.indexOf(dep)), dep]);
      } else if (!state.has(dep)) {
        visit(dep);
      }
    }
    stack.pop();
    state.set(node, "done");
  };
  for (const file of files) {
    if (!state.has(file)) visit(file);
  }
  assert.deepEqual(cycles, []);
});
