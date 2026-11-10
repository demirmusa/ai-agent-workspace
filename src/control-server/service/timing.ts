import { providerReachable } from '../connection-recovery.js';

/** Delays and probes of run handling; tests shorten them through the ControlService statics. */
export const serviceTiming = {
  /** A native TUI reads text and Enter in one chunk as a paste, so Enter follows after this delay. */
  terminalSubmitDelayMs: 150,
  /** Quiet period after which a completed native TUI has finished its last turn. */
  completionQuietMs: 5000,
  /** Quiet period after which a TUI showing a connection error has stopped its turn. */
  connectionQuietMs: 10_000,
  connectionRecoveryAttempts: 5,
  /** Failures further apart than this count as separate incidents. */
  connectionRecoveryWindowMs: 600_000,
  connectivityRetryMs: 15_000,
  connectivityProbe: providerReachable as (provider: string) => Promise<boolean>,
  /** Margin added after a provider's quota reset time before asking its CLI to continue (+1 minute). */
  usageLimitGraceMs: 60_000,
};
