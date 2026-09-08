import { FastifyReply } from "fastify"

export type ProblemDetails = {
  type: string
  title: string
  status: number
  detail?: string
}

export const sendProblem = (
  reply: FastifyReply,
  status: number,
  title: string,
  detail?: string,
): FastifyReply => {
  const problem: ProblemDetails =
    detail === undefined
      ? { type: "about:blank", title: title, status: status }
      : { type: "about:blank", title: title, status: status, detail: detail }
  return reply.type("application/problem+json").status(status).send(problem)
}
