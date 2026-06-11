/**
 * Compatibility shim. Canonical implementation moved to lib/security.js in the
 * Stage-0 mind-extraction (note: symphonee-2.0-development-plan). External
 * consumers now require '../lib/security'; this keeps mind/-internal requires
 * ('./security') working until they are migrated in a later phase.
 */
'use strict';
module.exports = require('../lib/security');
