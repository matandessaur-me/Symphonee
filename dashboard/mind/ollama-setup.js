/**
 * Compatibility shim. Canonical implementation moved to lib/ollama-setup.js in
 * the Stage-0 mind-extraction (note: symphonee-2.0-development-plan). External
 * consumers (brain/index.js, server.js) now require '../lib/ollama-setup';
 * this keeps mind/-internal requires ('./ollama-setup') working until they are
 * migrated in a later phase.
 */
'use strict';
module.exports = require('../lib/ollama-setup');
