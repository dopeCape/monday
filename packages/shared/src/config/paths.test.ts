import { describe, expect, test } from "bun:test";
import { configCandidates, expandHome, resolveConfigPath } from "./paths.ts";

const linux = { HOME: "/home/t", XDG_CONFIG_HOME: undefined };
const mac = { HOME: "/Users/t" };
const win = { HOME: "C:\\Users\\t", APPDATA: "C:\\Users\\t\\AppData\\Roaming" };

const existsIn = (paths: string[]) => (p: string) => paths.includes(p);

describe("config paths", () => {
  test("MONDAY_CONFIG overrides everything", () => {
    expect(configCandidates("linux", { ...linux, MONDAY_CONFIG: "/etc/monday.toml" })).toEqual([
      "/etc/monday.toml",
    ]);
    expect(configCandidates("windows", { ...win, MONDAY_CONFIG: "D:\\rice\\monday.toml" })).toEqual(
      ["D:\\rice\\monday.toml"],
    );
    expect(configCandidates("macos", { ...mac, MONDAY_CONFIG: "~/dots/monday.toml" })).toEqual([
      "/Users/t/dots/monday.toml",
    ]);
  });

  test("linux uses XDG_CONFIG_HOME, else ~/.config", () => {
    expect(configCandidates("linux", linux)).toEqual(["/home/t/.config/monday/monday.toml"]);
    expect(configCandidates("linux", { ...linux, XDG_CONFIG_HOME: "/home/t/cfg/" })).toEqual([
      "/home/t/cfg/monday/monday.toml",
    ]);
  });

  test("~/.config wins on macOS and Windows when it exists, else the native path", () => {
    const macCandidates = configCandidates("macos", mac);
    expect(macCandidates).toEqual([
      "/Users/t/.config/monday/monday.toml",
      "/Users/t/Library/Application Support/monday/monday.toml",
    ]);
    expect(
      resolveConfigPath("macos", mac, existsIn(["/Users/t/.config/monday/monday.toml"])),
    ).toEqual({
      path: "/Users/t/.config/monday/monday.toml",
      exists: true,
    });
    expect(resolveConfigPath("macos", mac, existsIn([]))).toEqual({
      path: "/Users/t/Library/Application Support/monday/monday.toml",
      exists: false,
    });

    expect(configCandidates("windows", win)).toEqual([
      "C:\\Users\\t\\.config\\monday\\monday.toml",
      "C:\\Users\\t\\AppData\\Roaming\\monday\\monday.toml",
    ]);
    expect(
      resolveConfigPath(
        "windows",
        win,
        existsIn(["C:\\Users\\t\\AppData\\Roaming\\monday\\monday.toml"]),
      ),
    ).toEqual({ path: "C:\\Users\\t\\AppData\\Roaming\\monday\\monday.toml", exists: true });
  });

  test("Windows falls back to USERPROFILE and a derived APPDATA", () => {
    expect(configCandidates("windows", { USERPROFILE: "C:\\Users\\u" })).toEqual([
      "C:\\Users\\u\\.config\\monday\\monday.toml",
      "C:\\Users\\u\\AppData\\Roaming\\monday\\monday.toml",
    ]);
  });

  test("an existing MONDAY_CONFIG path is reported as such, a missing one still wins", () => {
    const env = { ...linux, MONDAY_CONFIG: "/x/monday.toml" };
    expect(resolveConfigPath("linux", env, existsIn(["/x/monday.toml"]))).toEqual({
      path: "/x/monday.toml",
      exists: true,
    });
    expect(resolveConfigPath("linux", env, existsIn([]))).toEqual({
      path: "/x/monday.toml",
      exists: false,
    });
  });

  test("with no home at all there is nowhere to look", () => {
    expect(configCandidates("linux", {})).toEqual([]);
    expect(resolveConfigPath("linux", {}, () => false)).toBeUndefined();
  });

  test("expandHome leaves other paths alone", () => {
    expect(expandHome("linux", linux, "/abs/path")).toBe("/abs/path");
    expect(expandHome("linux", linux, "~")).toBe("/home/t");
  });
});
