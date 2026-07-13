import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const dockerfile = readFileSync(
  new URL("../../docker/app/Dockerfile", import.meta.url),
  "utf8"
);

test("app image supports a cold source build of Xenova sharp and its runtime linkage", () => {
  const [builder = "", runtime = ""] = dockerfile.split(
    "FROM node:22-slim AS runtime"
  );

  assert.match(builder, /\blibvips-dev\b/);
  assert.match(runtime, /\blibvips42\b/);
});
