// unclaimed-plugin-routes -- maps an unmatched /api path to the first-party
// plugin that owns it, so core can return a useful {pluginRequired} 404 instead
// of a bare "Not found" when the plugin is uninstalled or inactive. Pure; split
// from server.js. Add future plugin prefixes to EXTRACTED_PLUGIN_ROUTES.
const EXTRACTED_PLUGIN_ROUTES = [
  { pluginId: 'azure-devops', pluginName: 'Azure DevOps', prefix: /^\/api\/(workitems|iterations|teams|areas|velocity|burndown|start-working|team-members)(?:\/|$|\?)/ },
  { pluginId: 'github',       pluginName: 'GitHub',       prefix: /^\/api\/(github\/|pull-request(?:$|\?))/ },
];

function matchUnclaimedPluginRoute(pathname, plugins) {
  for (const spec of EXTRACTED_PLUGIN_ROUTES) {
    if (!spec.prefix.test(pathname)) continue;
    const installed = Array.isArray(plugins) && plugins.some(p => p.id === spec.pluginId);
    return { pluginId: spec.pluginId, pluginName: spec.pluginName, installed };
  }
  return null;
}

module.exports = { EXTRACTED_PLUGIN_ROUTES, matchUnclaimedPluginRoute };
