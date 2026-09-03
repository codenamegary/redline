import { FastifyRequest } from "fastify"

export const requestOrigin = (request: FastifyRequest): string => {
  const host = request.headers.host ?? "localhost"
  return request.protocol + "://" + host
}
