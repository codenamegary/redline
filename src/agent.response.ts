// Shared response copy for the redline plugins (opencode plugin and pi
// extension). When the redline server runs reviewer/worker lanes, the agent
// that created the artifact must stop driving the loop: the server-side
// agents handle live replies and iteration duties, so wait_for_feedback
// would park a second agent next to them.

export type ResponseSummary = {
  id: string
  current: string
  status: string
  reviewUrl: string
  // Phase-5 summary field. Undefined on older servers, treated as "none":
  // the creating agent keeps the wait_for_feedback loop.
  reviewer?: "none" | "starting" | "idle"
}

const hasServerReviewer = (summary: ResponseSummary): boolean =>
  summary.reviewer !== undefined && summary.reviewer !== "none"

// The plugins' parsed summaries carry extra fields; the copy builders read
// only the fields they format, so both feed their summary through this
// projection to keep the parsed shape and the shared copy in sync.
export const asResponseSummary = (summary: ResponseSummary): ResponseSummary => ({
  id: summary.id,
  current: summary.current,
  status: summary.status,
  reviewUrl: summary.reviewUrl,
  reviewer: summary.reviewer,
})

const reviewerConfiguredLine =
  "Reviewer configured on the redline server: give the user the review URL and stop. Do not call wait_for_feedback. The server's reviewer and worker agents handle live replies and iteration duties."

export const buildCreateResponseText = (summary: ResponseSummary): string =>
  [
    "Artifact created: " + summary.id + " (" + summary.current + ")",
    "Review URL: " + summary.reviewUrl,
    hasServerReviewer(summary)
      ? reviewerConfiguredLine
      : "Give this URL to the user, then call wait_for_feedback: comments wake you for replies only, the user's Iterate submits a batch for you to publish, approval means done for now.",
  ].join("\n")

export const buildUpdateResponseText = (summary: ResponseSummary): string =>
  "Published " +
  summary.current +
  " of " +
  summary.id +
  " (iteration complete, status " +
  summary.status +
  "). Review URL: " +
  summary.reviewUrl +
  ". " +
  (hasServerReviewer(summary) ? reviewerConfiguredLine : "Call wait_for_feedback next.")
