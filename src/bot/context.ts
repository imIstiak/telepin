import type { Context } from "grammy";
import type { User } from "../db/schema";

export type BotContext = Context & { user: User };
