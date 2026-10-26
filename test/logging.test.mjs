import assert from "node:assert/strict";
import { test } from "node:test";
import "../dist/server/util.js";

test("a closed stdout/stderr pipe (EPIPE) doesn't crash the app", () => {
  for (const stream of [process.stdout, process.stderr]) {
    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    assert.doesNotThrow(() => stream.emit("error", epipe));
  }
});
