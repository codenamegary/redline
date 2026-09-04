import { escapeHtml } from "./markup"

export type GalleryItem = {
  id: string
  title: string
  status: string
  current: string
  versionCount: number
  openThreads: number
  createdAt: string
  updatedAt: string
  reviewUrl: string
  rawUrl: string
}

const pillClass = (status: string): string =>
  status === "iterating" ? "pill iterating" : status === "review" ? "pill review" : "pill draft"

const pillLabel = (status: string): string =>
  status === "iterating" ? "iterating" : status === "review" ? "in review" : "draft"

const shortDate = (isoTimestamp: string): string => isoTimestamp.slice(0, 16).replace("T", " ")

const renderCard = (item: GalleryItem): string => {
  const title = escapeHtml(item.title)
  const id = escapeHtml(item.id)
  const reviewUrl = escapeHtml(item.reviewUrl)
  const rawUrl = escapeHtml(item.rawUrl)
  const status = escapeHtml(item.status)
  const current = escapeHtml(item.current)
  return (
    '<article class="card">' +
    '<div class="card-head">' +
    '<a class="card-title" href="' + reviewUrl + '">' + title + "</a>" +
    '<span class="' + pillClass(status) + '">' + pillLabel(status) + "</span>" +
    "</div>" +
    '<div class="card-meta">' + id + " &middot; " + current + " &middot; " +
    item.versionCount + (item.versionCount === 1 ? " version" : " versions") + " &middot; " +
    '<span class="' + (item.openThreads > 0 ? "open-count" : "") + '">' +
    item.openThreads + (item.openThreads === 1 ? " open thread" : " open threads") + "</span>" +
    " &middot; updated " + shortDate(item.updatedAt) + "</div>" +
    '<div class="card-links">' +
    '<a href="' + reviewUrl + '">Review</a>' +
    '<a href="' + rawUrl + '">Open raw</a>' +
    "</div>" +
    "</article>"
  )
}

export const renderGalleryPage = (items: GalleryItem[], home: string): string => {
  const body =
    items.length === 0
      ? '<p class="empty">No artifacts yet. Create one with <code>POST /api/v1/artifacts</code>.</p>'
      : '<section class="cards">' + items.map(renderCard).join("\n") + "</section>"
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>redline</title>
<style>
  :root { color-scheme: dark }
  * { box-sizing: border-box }
  body { margin: 0; font: 14px/1.5 system-ui, -apple-system, sans-serif; background: #0f1115; color: #e6e8ee }
  header { padding: 20px 28px 14px; border-bottom: 1px solid #262b36 }
  header h1 { margin: 0; font-size: 20px }
  header h1 span { color: #e5484d }
  header .tagline { margin: 6px 0 0; color: #c6cbd6; font-size: 13px }
  header p { margin: 4px 0 0; color: #9aa3b2; font-size: 13px }
  header a { color: #8ab4ff; text-decoration: none }
  header a:hover { text-decoration: underline }
  main { padding: 20px 28px 40px }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px }
  .card { border: 1px solid #262b36; background: #171a21; border-radius: 10px; padding: 14px 16px }
  .card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px }
  .card-title { color: #e6e8ee; font-weight: 600; text-decoration: none; font-size: 15px }
  .card-title:hover { color: #fff }
  .card-meta { color: #9aa3b2; font-size: 12px; margin-top: 6px }
  .card-links { display: flex; gap: 14px; margin-top: 10px }
  .card-links a { color: #8ab4ff; text-decoration: none; font-size: 13px }
  .card-links a:hover { text-decoration: underline }
  .pill { padding: 2px 10px; border-radius: 999px; font-size: 12px; border: 1px solid; white-space: nowrap }
  .pill.review { color: #f5a524; border-color: #6b5320; background: rgba(245, 165, 36, .08) }
  .pill.iterating { color: #46d68c; border-color: #2a5c40; background: rgba(70, 214, 140, .08) }
  .pill.draft { color: #9aa3b2; border-color: #3a4152; background: rgba(154, 163, 178, .08) }
  .open-count { color: #f5a524 }
  .empty { color: #9aa3b2 }
  code { background: #1d2230; padding: 2px 6px; border-radius: 4px; font-size: 12px }
</style>
</head>
<body>
<header>
  <h1><span>redline</span> &mdash; artifact review</h1>
  <p class="tagline">review loop for design artifacts: architecture docs, decision records, API contracts, diagrams, UI mockups</p>
  <p>home: <code>${escapeHtml(home)}</code> &middot; <a href="/settings">Settings</a></p>
</header>
<main>
${body}
</main>
</body>
</html>
`
}
