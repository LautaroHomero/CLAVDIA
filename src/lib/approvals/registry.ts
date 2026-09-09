import type { PendingHumanRequest } from "./types";

/**
 * Tracks the human-in-the-loop requests a workflow is currently blocked on, so
 * the web UI can show a dedicated "pendientes de aprobación" panel even without
 * Slack configured.
 *
 * This is process-local state (fine for local dev and a single-instance deploy).
 * In a multi-instance deployment, back this with Redis/Postgres — the workflow
 * itself already holds the source of truth via its hook, this is only a view.
 */
const globalForRegistry = globalThis as unknown as {
  __pendingHumanRequests?: Map<string, PendingHumanRequest>;
};

const registry: Map<string, PendingHumanRequest> =
  globalForRegistry.__pendingHumanRequests ?? new Map();
globalForRegistry.__pendingHumanRequests = registry;

export function addPendingRequest(req: PendingHumanRequest): void {
  registry.set(req.token, req);
}

export function removePendingRequest(token: string): void {
  registry.delete(token);
}

export function getPendingRequest(token: string): PendingHumanRequest | undefined {
  return registry.get(token);
}

export function listPendingRequests(): PendingHumanRequest[] {
  return [...registry.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
