import { describe, expect, it } from "bun:test"

import { buildCreateResponseText, buildUpdateResponseText } from "./agent.response"

const summary = (reviewer?: "none" | "starting" | "idle") => ({
  id: "a1",
  current: "v1",
  status: "review",
  reviewUrl: "http://127.0.0.1:4739/a/a1",
  reviewer: reviewer,
})

describe("plugin response text", () => {
  it("keeps the wait_for_feedback loop on create when no reviewer is configured", () => {
    expect(buildCreateResponseText(summary("none"))).toBe(
      [
        "Artifact created: a1 (v1)",
        "Review URL: http://127.0.0.1:4739/a/a1",
        "Give this URL to the user, then call wait_for_feedback: comments wake you for replies only, the user's Iterate submits a batch for you to publish, approval means done for now.",
      ].join("\n"),
    )
  })

  it("stops the loop on create when the server runs reviewer lanes", () => {
    for (const reviewer of ["starting", "idle"] as const) {
      const text = buildCreateResponseText(summary(reviewer))
      expect(text).toBe(
        [
          "Artifact created: a1 (v1)",
          "Review URL: http://127.0.0.1:4739/a/a1",
          "Reviewer configured on the redline server: give the user the review URL and stop. Do not call wait_for_feedback. The server's reviewer and worker agents handle live replies and iteration duties.",
        ].join("\n"),
      )
    }
  })

  it("treats a missing reviewer flag as none on create", () => {
    expect(buildCreateResponseText(summary(undefined))).toContain("then call wait_for_feedback")
  })

  it("keeps the wait loop on update when no reviewer is configured", () => {
    expect(buildUpdateResponseText(summary("none"))).toBe(
      "Published v1 of a1 (iteration complete, status review). Review URL: http://127.0.0.1:4739/a/a1. Call wait_for_feedback next.",
    )
  })

  it("stops the loop on update when the server runs reviewer lanes", () => {
    expect(buildUpdateResponseText(summary("idle"))).toBe(
      "Published v1 of a1 (iteration complete, status review). Review URL: http://127.0.0.1:4739/a/a1. Reviewer configured on the redline server: give the user the review URL and stop. Do not call wait_for_feedback. The server's reviewer and worker agents handle live replies and iteration duties.",
    )
  })

  it("treats a missing reviewer flag as none on update", () => {
    expect(buildUpdateResponseText(summary(undefined))).toContain("Call wait_for_feedback next.")
  })
})
