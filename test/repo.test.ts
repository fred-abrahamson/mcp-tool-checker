import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("secrets stay out of git", () => {
  it("ignores .env and keeps .env.example", () => {
    const check = (file: string) => {
      try {
        execFileSync("git", ["check-ignore", "-q", file]);
        return true;
      } catch {
        return false;
      }
    };
    expect(check(".env")).toBe(true);
    expect(check(".env.local")).toBe(true);
    expect(check(".env.example")).toBe(false);
  });

  it("leaves every value in .env.example empty", () => {
    const lines = readFileSync(".env.example", "utf8").split("\n").filter((line) => /^[A-Z_]+=/.test(line));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/^[A-Z_]+=$/);
  });
});
