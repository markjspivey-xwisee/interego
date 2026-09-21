/**
 * The System One client lives in the shared judgment kit since 2026-09-21
 * (applications/_shared/judgment-kit/jev-client.ts): Foxxi judges content with the same
 * client, and the fake it ships is how both verticals test their judgments. Everything is
 * re-exported here so the harness keeps one import path.
 */
export * from '../../_shared/judgment-kit/jev-client.js';
