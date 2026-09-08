import { useParams } from "react-router"

import { ReviewShell } from "./shell"

export const ReviewPage = () => {
  const { id } = useParams()
  if (id === undefined || id.length === 0) return null
  return <ReviewShell id={id} />
}
