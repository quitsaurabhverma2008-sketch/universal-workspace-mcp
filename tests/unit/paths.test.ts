import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { safeResolve, isReservedTopLevel } from "../../src/utils/paths.js";
import { globToRegex } from "../../src/core/filesystem.js";
import { AppError } from "../../src/utils/errors.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "umcp-paths-"));

describe("safeResolve", () => {
  it("resolves ordinary relative paths inside the root", () => {
    const resolved = safeResolve(root, "src/index.ts");
    expect(resolved).toBe(path.join(root, "src", "index.ts"));
  });

  it("treats '.' as the root", () => {
    expect(safeResolve(root, ".")).toBe(path.resolve(root));
  });

  it("rejects parent traversal", () => {
    expect(() => safeResolve(root, "../escape")).toThrow(AppError);
    expect(() => safeResolve(root, "a/../../b")).toThrow(AppError);
    expect(() => safeResolve(root, "..")).toThrow(AppError);
  });

  it("rejects absolute paths", () => {
    expect(() => safeResolve(root, "/etc/passwd")).toThrow(AppError);
    expect(() => safeResolve(root, "/data/data/com.termux/files/home")).toThrow(AppError);
  });

  it("rejects NUL-containing paths", () => {
    expect(() => safeResolve(root, "a\0b")).toThrow(AppError);
  });

  it("rejects symlink escapes", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "umcp-outside-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "top secret");
    fs.symlinkSync(outside, path.join(root, "evil-link"));
    expect(() => safeResolve(root, "evil-link/secret.txt")).toThrow(AppError);
    expect(() => safeResolve(root, "evil-link")).toThrow(AppError);
  });
});

describe("isReservedTopLevel", () => {
  it("blocks the reserved files and reserved dirs themselves", () => {
    expect(isReservedTopLevel("Brain.md")).toBe(true);
    expect(isReservedTopLevel("PLAN.md")).toBe(true);
    expect(isReservedTopLevel("PROJECT.md")).toBe(true);
    expect(isReservedTopLevel("outputs")).toBe(true);
    expect(isReservedTopLevel("logs")).toBe(true);
  });

  it("allows files inside outputs/ and logs/", () => {
    expect(isReservedTopLevel("outputs/report.md")).toBe(false);
    expect(isReservedTopLevel("logs/build.log")).toBe(false);
  });

  it("allows ordinary project paths", () => {
    expect(isReservedTopLevel("src/index.ts")).toBe(false);
    expect(isReservedTopLevel("README.md")).toBe(false);
    expect(isReservedTopLevel("src/Brain.md")).toBe(false); // nested file is not the root one
  });
});

describe("globToRegex", () => {
  it("matches **/name against nested files", () => {
    const re = globToRegex("**/hello*.txt");
    expect(re.test("src/hello.txt")).toBe(true);
    expect(re.test("hello.txt")).toBe(true);
    expect(re.test("a/b/c/hello-world.txt")).toBe(true);
    expect(re.test("src/goodbye.txt")).toBe(false);
  });

  it("matches src/**/*.ts", () => {
    const re = globToRegex("src/**/*.ts");
    expect(re.test("src/index.ts")).toBe(true);
    expect(re.test("src/core/deep.ts")).toBe(true);
    expect(re.test("test/core/deep.ts")).toBe(false);
  });
});
