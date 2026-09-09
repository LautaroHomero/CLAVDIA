import { defineHook } from "workflow";
import type { HumanResponse } from "@/lib/approvals/types";

/**
 * The single hook the agent workflow suspends on whenever it needs a human.
 * The token is always the agent's tool-call id, so the resume endpoints
 * (web UI and Slack webhook) can address it without extra bookkeeping.
 */
export const humanHook = defineHook<HumanResponse>();
