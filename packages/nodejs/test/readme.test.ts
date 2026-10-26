import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("README", () => {
  it("usageExampleMatchesTheTypeCheckedCopy", () => {
    const readme = read("../README.md");
    const usage = readme.slice(readme.indexOf("\n## Usage\n"));
    const block = /```ts\n([\s\S]*?)```/.exec(usage)?.[1];

    const example = read("./readme-example.ts")
      .replace(/^\/\/ The "Usage" example.*\n/, "")
      .replace('from "../src/index.js"', 'from "@natsuneko-laboratory/catalyst-sdk"');

    expect(block).toBe(example);
  });
});
