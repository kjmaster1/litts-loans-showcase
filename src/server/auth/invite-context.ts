import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Accounts may only be created while accepting a valid invite. The invite
 * acceptance flow runs sign-up inside `withInviteContext`; the Better Auth
 * `user.create.before` hook rejects any creation outside it. This is defence in
 * depth on top of the public sign-up route being disabled.
 */
const storage = new AsyncLocalStorage<{ inviteId: string }>();

export function withInviteContext<T>(inviteId: string, fn: () => Promise<T>): Promise<T> {
  return storage.run({ inviteId }, fn);
}

export function currentInviteContext() {
  return storage.getStore();
}
