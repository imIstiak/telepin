import IORedis, { type RedisOptions } from "ioredis";
import { env } from "./env";

/** BullMQ requires maxRetriesPerRequest = null for blocking connections. */
export function createRedisConnection(overrides: RedisOptions = {}) {
  return new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    // Railway private networking resolves over IPv6.
    family: 0,
    ...overrides,
  });
}
