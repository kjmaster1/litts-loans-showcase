/**
 * Session lifetime policy (SPEC §8). Idle timeout raised from 15 to 60 minutes (owner,
 * 2026-10-11): officers switch between the game and the app; the 12-hour absolute limit,
 * mandatory 2FA and step-up for sensitive actions stay.
 */

/** Sliding idle timeout: the session expires after this long without activity. */
export const SESSION_IDLE_SECONDS = 60 * 60;

/** How often activity pushes the idle expiry forward. */
export const SESSION_REFRESH_SECONDS = 60;

/** Absolute lifetime regardless of activity. */
export const SESSION_ABSOLUTE_SECONDS = 12 * 60 * 60;

/** How long a step-up (fresh 2FA) authorises sensitive actions. */
export const STEP_UP_WINDOW_SECONDS = 5 * 60;

/** Invite links expire after this long. */
export const INVITE_TTL_SECONDS = 48 * 60 * 60;
