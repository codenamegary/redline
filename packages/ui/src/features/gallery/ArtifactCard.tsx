import { ArtifactSummary } from "@redline/http-contracts/artifact.schemas"
import React from "react"
import { Link } from "react-router"
import { countLabel, shortDate } from "../../components/format"
import { StatusBadge } from "../../components/StatusBadge"
import { useFeedbackQuery } from "../review/queries"
import { VersionChips } from "./VersionChips"

export type ArtifactCardProps = {
  item: ArtifactSummary
}

export const ArtifactCard: React.FC<ArtifactCardProps> = ({ item }) => {
  // The card upgrades itself from the feedback view (same cache key as the
  // review page): approval lives on version rows, not on the summary.
  const feedbackQuery = useFeedbackQuery(item.id, false)
  const view = feedbackQuery.data
  const versions = view?.versions ?? []
  const approved = view?.approvedAt !== undefined
  const lastApproved = versions.slice().reverse().find((entry) => entry.approvedAt !== undefined)
  const previouslyApproved = !approved && lastApproved !== undefined

  return (
    <article className="flex flex-col gap-2 rounded-[10px] border border-edge bg-card px-4 py-3.5">
      <div className="flex items-center justify-between gap-2.5">
        <Link to={"/a/" + item.id} className="text-[15px] font-semibold text-fog no-underline hover:text-white">
          {item.title}
        </Link>
        <StatusBadge status={item.status} approved={approved} />
      </div>
      <div className="mt-0.5 text-xs text-mist">
        {item.id} ·{" "}
        {view === undefined ? (
          <span>
            {item.current} · {countLabel(item.versionCount, "version")}
          </span>
        ) : (
          <VersionChips versions={versions} current={item.current} />
        )}
        {previouslyApproved ? (
          <span className="text-go">
            {" "}
            · {lastApproved?.version} previously approved
          </span>
        ) : null}
        {" · "}
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
    </article>
  )
}
