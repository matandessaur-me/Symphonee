/**
 * Compatibility shim. The canonical implementation moved to lib/llm.js as part
 * of the Stage-0 mind-extraction (note: symphonee-2.0-development-plan): shared
 * primitives belong in lib/ so that code OUTSIDE mind/ (brain/, server.js,
 * agents/, routes/) no longer reaches into mind/ for them. External consumers
 * now require '../lib/llm' directly; this re-export keeps mind/-internal
 * requires ('./llm') working unchanged until a later phase migrates them.
 */
'use strict';
module.exports = require('../lib/llm');
