/**
 * Canary tripwire module — see check.ts for the detection idea, quarantine.ts
 * for storage, card.ts for the owner-facing decision card.
 *
 * NOT WIRED INTO THE ROUTER YET. This module is a standalone, independently
 * testable unit: `runCanaryCheck(text)` to test, `quarantineAndCard(...)` to
 * hold+card a flagged message. The one remaining step is a single call site
 * in src/router.ts (around the writeSessionMessage call at router.ts:507)
 * that runs the check before a message reaches a session, and calls
 * quarantineAndCard() instead of writeSessionMessage() when it fails. Left
 * out deliberately until the false-positive rate is validated by hand.
 */
import './card.js';

export { runCanaryCheck, type CanaryResult, type CanaryVerdict, type TaskMode } from './check.js';
export { quarantineAndCard, dropToOubliette, type QuarantineRequest, type GuillotineRequest } from './card.js';
export { dueDeferredIds } from './quarantine.js';
