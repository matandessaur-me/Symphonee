/**
 * Personas - Stage 5's two-axis adaptation layer.
 *
 * The plan keeps the core universal and pushes ALL adaptation into personas,
 * along two axes:
 *   - model ROLE: controller (drives the work) vs worker (executes a task).
 *   - USER TYPE: coder / marketer / pm / non-technical - the adaptive surface.
 *
 * This module is pure config + a resolver. It does NOT generate prose (that is
 * the frontier voice's job); it produces SURFACE parameters that the
 * deterministic templated-recall path (brain/voice.js) and any escalation
 * prompt honour. Keeping adaptation declarative is what lets the same brain
 * serve a terminal power-user and a non-technical chat-box user without forking.
 */

'use strict';

const USER_TYPES = {
  coder:          { showIds: true,  showPaths: true,  jargon: true,  verbosity: 'terse',   maxItems: 3 },
  marketer:       { showIds: false, showPaths: false, jargon: false, verbosity: 'plain',   maxItems: 2 },
  pm:             { showIds: false, showPaths: false, jargon: false, verbosity: 'summary', maxItems: 3 },
  'non-technical':{ showIds: false, showPaths: false, jargon: false, verbosity: 'plain',   maxItems: 2 },
};

const ROLES = {
  controller: { instructionBias: 'decide-and-delegate', canDispatch: true },
  worker:     { instructionBias: 'execute-the-task',     canDispatch: false },
};

const DEFAULT = { userType: 'coder', role: 'worker' };

/**
 * Resolve a persona spec into a flat surface object the voice + prompts use.
 * Unknown userType/role fall back to defaults (never throws).
 */
function resolveSurface(persona = {}) {
  const userType = USER_TYPES[persona.userType] ? persona.userType : DEFAULT.userType;
  const role = ROLES[persona.role] ? persona.role : DEFAULT.role;
  return { userType, role, ...USER_TYPES[userType], ...ROLES[role] };
}

module.exports = { resolveSurface, USER_TYPES, ROLES, DEFAULT };
