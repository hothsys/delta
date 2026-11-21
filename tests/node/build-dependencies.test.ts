import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("app-builder-lib"));
const universalRequire = createRequire(builderRequire.resolve("@electron/universal"));

describe("temporary build-dependency security overrides", () => {
  it("resolves only the affected parent minimatch versions to the patched major", () => {
    for (const parent of [builderRequire, universalRequire]) {
      expect(parent("minimatch/package.json").version).toMatch(/^11\./);
    }
    const asarRequire = createRequire(builderRequire.resolve("@electron/asar"));
    expect(asarRequire("minimatch/package.json").version).toMatch(/^3\./);
  });

  it("keeps electron-builder file filtering, dotfiles, exclusions and partial directories working", () => {
    const { FileMatcher } = builderRequire("./fileMatcher");
    const matcher = new FileMatcher("/app", "/out", (value: string) => value, [
      "**/*",
      "!**/*.map",
      "!**/private/**",
    ]);
    const filter = matcher.createFilter();
    const file = { isDirectory: () => false };
    const directory = { isDirectory: () => true };
    expect(filter("/app/dist/index.js", file)).toBe(true);
    expect(filter("/app/.config", file)).toBe(true);
    expect(filter("/app/dist/index.js.map", file)).toBe(false);
    expect(filter("/app/private/key.txt", file)).toBe(false);
    expect(filter("/app/dist", directory)).toBe(true);
  });

  it("supports the matchBase API used by Electron universal packaging", () => {
    const { minimatch } = universalRequire("minimatch");
    expect(minimatch("Frameworks/libexample.dylib", "*.dylib", { matchBase: true })).toBe(true);
    expect(minimatch("Contents/Info.plist", "Info.plist", { matchBase: true })).toBe(true);
    expect(minimatch("Contents/Other.plist", "Info.plist", { matchBase: true })).toBe(false);
    expect(typeof universalRequire("@electron/universal").makeUniversalApp).toBe("function");
  });
});
