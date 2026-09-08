import { describe, expect, it } from "vitest"

import type { Version } from "@redline/http-contracts/artifact.models"

import { versionOptionLabel } from "./versions.select"

describe("versionOptionLabel", () => {
  it("joins note and state chips", () => {
    expect(
      versionOptionLabel({
        version: "v3" as Version,
        createdAt: "2026-09-07T10:00:00.000Z",
        note: "redline pass",
        batch: { threadIds: ["t"], submittedAt: "2026-09-07T11:00:00.000Z" },
      }),
    ).toBe("v3 · redline pass · awaiting agent")
    expect(
      versionOptionLabel({
        version: "v1" as Version,
        createdAt: "2026-09-07T10:00:00.000Z",
        approvedAt: "2026-09-07T11:00:00.000Z",
      }),
    ).toBe("v1 · approved")
  })
})
