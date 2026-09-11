import { isPendingVersion, Version } from "@redline/http-contracts/artifact.models"
import { ArtifactSummary } from "@redline/http-contracts/artifact.schemas"
import { BadgeCheck } from "lucide-react"
import React from "react"
import { Link } from "react-router"
import { countLabel, shortDate } from "../../components/format"
import { StatusBadge } from "../../components/StatusBadge"
import { useFeedbackQuery } from "../review/queries"
import { VersionDrawer } from "./VersionDrawer"

export type ArtifactCardProps = {
  item: ArtifactSummary
}

export const ArtifactCard: React.FC<ArtifactCardProps> = ({ item }) => {
  // The card upgrades itself from the feedback view (same cache key as the
  // review page): approval lives on version rows, not on the summary.
  const feedbackQuery = useFeedbackQuery(item.id, false)
  const view = feedbackQuery.data
  const versions = view?.versions ?? []
  const hasPending = versions.some(isPendingVersion)
  const currentApproved = view?.approvedAt !== undefined
  // Honest badge grammar: "approved" only when the current version carries
  // the approval and nothing is in flight — an iterate-after-approve round
  // reads as "iterating" while the drawer keeps the green history visible.
  const approved = currentApproved && !hasPending
  // Sealed: approved and stable. A quiet border tint + outline check.
  const sealed = approved && item.status === "review"
  const commentCounts = new Map<Version, number>()
  for (const thread of view?.threads ?? []) {
    const key = thread.anchorVersion
    // General comments (no pin) don't belong to any version row.
    if (key === undefined) continue
    commentCounts.set(key, (commentCounts.get(key) ?? 0) + 1)
  }

  return (
    <article
      className={`group/card relative flex flex-col gap-2 rounded-[10px] border bg-card px-4 py-3.5 hover:z-20 focus-within:z-20 ${
        sealed ? "border-go/30" : "border-edge"
      }`}
    >
      <div className="flex items-center justify-between gap-2.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <Link to={"/a/" + item.id} className="truncate text-[15px] font-semibold text-fog no-underline hover:text-white">
            {item.title}
          </Link>
          {sealed ? <BadgeCheck className="size-4 shrink-0 text-go" aria-hidden /> : null}
        </span>
        <StatusBadge status={item.status} approved={approved} />
      </div>
      <div className="mt-0.5 text-xs text-mist">
        {item.id} · {item.current} · {countLabel(item.versionCount, "version")}
        {item.assetsCount > 0 ? " · " + countLabel(item.assetsCount, "image") : ""} ·{" "}
        <span className={item.openThreads > 0 ? "text-warn" : undefined}>
          {countLabel(item.openThreads, "open thread")}
        </span>{" "}
        · updated {shortDate(item.updatedAt)}
      </div>
      <div className="mt-1.5 flex gap-3.5 text-[13px]">
        <Link to={"/a/" + item.id} className="text-link no-underline hover:underline">
          Review
        </Link>
        <a
          href={`/a/${item.id}/${item.current}/index.html`}
          target="_blank"
          rel="noreferrer"
          className="text-link no-underline hover:underline"
        >
          Open raw
        </a>
      </div>
      {/* Only multi-version artifacts get the drawer; a lone v1 has no
          history to peek out from under the card. */}
      {versions.length > 1 ? (
        <VersionDrawer artifactId={item.id} versions={versions} current={item.current} commentCounts={commentCounts} />
      ) : null}
    </article>
  )
}
