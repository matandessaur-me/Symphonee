'use strict';
// Unit tests for the unclaimed-plugin-route matcher extracted from server.js.
// The regexes decide which unmatched /api 404s get a helpful {pluginRequired}
// hint instead of a bare "Not found"; previously only exercised via live requests.
const test = require('node:test');
const assert = require('node:assert');
const { matchUnclaimedPluginRoute } = require('./unclaimed-plugin-routes');

test('matches Azure DevOps-owned paths', () => {
  for (const p of ['/api/workitems', '/api/iterations/5', '/api/teams?x=1', '/api/velocity']) {
    const r = matchUnclaimedPluginRoute(p, []);
    assert.equal(r && r.pluginId, 'azure-devops', p);
  }
});

test('matches GitHub-owned paths', () => {
  assert.equal(matchUnclaimedPluginRoute('/api/github/repos', []).pluginId, 'github');
  assert.equal(matchUnclaimedPluginRoute('/api/pull-request', []).pluginId, 'github');
  assert.equal(matchUnclaimedPluginRoute('/api/pull-request?id=3', []).pluginId, 'github');
});

test('reports installed=true only when the plugin is in the list', () => {
  assert.equal(matchUnclaimedPluginRoute('/api/workitems', []).installed, false);
  assert.equal(matchUnclaimedPluginRoute('/api/workitems', [{ id: 'azure-devops' }]).installed, true);
});

test('returns null for core / unrelated paths', () => {
  for (const p of ['/api/notes', '/api/ui/context', '/api/workitemsX', '/api/githubbed']) {
    assert.equal(matchUnclaimedPluginRoute(p, []), null, p);
  }
});
