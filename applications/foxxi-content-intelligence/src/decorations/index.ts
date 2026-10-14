/**
 * The decorations Foxxi publishes, each built with the decorator kit (kit.ts):
 *
 *   LRS-X  an xAPI 2.0 Learning Record Store an organization already runs (bound by its endpoint)
 *   LMS-X  an LMS, through the LTI 1.3 Advantage and OneRoster 1.2 interfaces it exposes
 *   LTI-X  the LTI 1.3 specification itself: its claims and services, read as xAPI
 *   LER-X  the IEEE learning and employment record standards
 *   TLA-X  ADL's Total Learning Architecture
 *
 * I2IDL-X (../../i2idlx) is the reference instance of the same pattern, built by its own pipeline.
 */
import type { DecorationId, DecorationSpec } from './kit.js';
import { LER_X } from './ler-x.js';
import { LMS_X } from './lms-x.js';
import { LRS_X } from './lrs-x.js';
import { LTI_X } from './lti-x.js';
import { TLA_X } from './tla-x.js';

export const DECORATIONS: Readonly<Record<DecorationId, DecorationSpec>> = Object.freeze({
  'lrs-x': LRS_X, 'lms-x': LMS_X, 'lti-x': LTI_X, 'ler-x': LER_X, 'tla-x': TLA_X,
});

export const decorationById = (id: string): DecorationSpec | undefined =>
  Object.prototype.hasOwnProperty.call(DECORATIONS, id) ? DECORATIONS[id as DecorationId] : undefined;
