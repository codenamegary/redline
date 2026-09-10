import { ArtifactSummary } from "@redline/http-contracts/artifact.schemas"
import React from "react"
import { Link } from "react-router"
import { countLabel, shortDate } from "../../components/format"
import { StatusBadge } from "../../components/StatusBadge"

export type ArtifactCardProps = {
  item: ArtifactSummary
}

export const ArtifactCard: React.FC<ArtifactCardProps> = ({ item }) => {
  return (
    <article className="flex flex-col gap-2 rounded-[10px] border border-edge bg-card px-4 py-3.5">
      <div className="flex items-center justify-between gap-2.5">
        <Link to={"/a/" + item.id} className="text-[15px] font-semibold text-fog no-underline hover:text-white">
          {item.title}
        </Link>
        <StatusBadge status={item.status} approved={item.approvedAt !== undefined} />
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
    </article>
  )
}
