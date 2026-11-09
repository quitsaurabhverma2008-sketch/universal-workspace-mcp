import { describe, it, expect } from "vitest";
import { upsertSection, extractSection, listSections } from "../../src/core/memory.js";

const DOC = [
  "# Project Brain",
  "",
  "## Mission",
  "",
  "Build the thing.",
  "",
  "## Architecture",
  "",
  "Monolith with SQLite.",
  "",
  "## Decisions",
  "",
  "- keep it simple",
].join("\n");

describe("brain section helpers", () => {
  it("lists sections", () => {
    expect(listSections(DOC)).toEqual(["Mission", "Architecture", "Decisions"]);
  });

  it("extracts a section case-insensitively", () => {
    expect(extractSection(DOC, "mission")).toContain("Build the thing.");
    expect(extractSection(DOC, "ARCHITECTURE")).toContain("Monolith with SQLite.");
    expect(extractSection(DOC, "Missing")).toBeNull();
  });

  it("replaces a section body, preserving others", () => {
    const out = upsertSection(DOC, "Mission", "Build the OTHER thing.", "replace");
    expect(extractSection(out, "Mission")).toContain("Build the OTHER thing.");
    expect(extractSection(out, "Mission")).not.toContain("Build the thing.");
    expect(extractSection(out, "Architecture")).toContain("Monolith with SQLite.");
  });

  it("appends within a section body", () => {
    const out = upsertSection(DOC, "Decisions", "- use vitest", "append");
    const section = extractSection(out, "Decisions")!;
    expect(section).toContain("keep it simple");
    expect(section).toContain("use vitest");
  });

  it("creates a missing section at the end", () => {
    const out = upsertSection(DOC, "Open Questions", "What now?", "replace");
    expect(extractSection(out, "Open Questions")).toContain("What now?");
    expect(out.endsWith("\n")).toBe(true);
  });
});
