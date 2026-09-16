import { ASSISTANT_TURN_ATTEMPT_TIMEOUT_MS } from "@showzy/assistant-runtime";

/** Postgres NOTIFY channel fired on `domain_events` INSERT. */
export const OUTBOX_NOTIFY_CHANNEL = "domain_events";

/** Polling fallback when LISTEN is quiet (retries, expired claims). */
export const POLL_INTERVAL_MS = 1_000;

/**
 * Bounded concurrent delivery executions per tick (SHO-279). Small on
 * purpose: enough that one slow consumer (a 30 s PDF render) does not
 * head-of-line block the batch, small enough that a burst cannot starve
 * the pool. Per-aggregate ordering stays with core's claim logic
 * (advisory lock + earliest-first defer).
 */
export const DELIVERY_CONCURRENCY = 4;

/**
 * Cap for the exponential tick-failure backoff (SHO-279): a transient
 * dispatch/findDue error logs and skips ticks for
 * `pollInterval * 2^(failures-1)` up to this cap, instead of crashing the
 * process with an unhandled rejection.
 */
export const TICK_FAILURE_BACKOFF_MAX_MS = 30_000;

export const JOB_DRAIN_TIMEOUT_MS = ASSISTANT_TURN_ATTEMPT_TIMEOUT_MS;

/** First LISTEN reconnect delay after a dropped connection. */
export const LISTEN_RECONNECT_MIN_MS = 1_000;

/** Cap for exponential LISTEN reconnect backoff. */
export const LISTEN_RECONNECT_MAX_MS = 30_000;

/**
 * Heartbeat while LISTEN is down and the 1s poll is the only wakeup.
 * `docs/operations/alerts.md` pages SEV2 after this signal lasts > 5 min.
 */
export const LISTEN_DOWN_HEARTBEAT_MS = 60_000;
