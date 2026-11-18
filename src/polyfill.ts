import { File as NodeFile } from "node:buffer";

if (typeof globalThis.File === "undefined") {
  (globalThis as unknown as { File: unknown }).File = NodeFile;
}
