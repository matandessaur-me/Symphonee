/**
 * Symphonee -- Plugin SDK
 * Include this in plugin iframes: <script src="/plugins/sdk/symphonee-sdk.js"></script>
 * Provides: Symphonee.getContext(), .switchTab(), .askAi(), .toast(), .api(), .on()
 */
(function () {
  'use strict';
  var pending = new Map();
  var reqId = 0;

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || !msg.__symphonee) return;

    if (msg.type === 'contextResponse' && pending.has(msg.requestId)) {
      pending.get(msg.requestId)(msg.data);
      pending.delete(msg.requestId);
    }

    var eventTypes = ['repoChanged', 'tabActivated', 'configChanged', 'iterationChanged'];
    if (eventTypes.indexOf(msg.type) !== -1) {
      window.dispatchEvent(new CustomEvent('symphonee:' + msg.type, { detail: msg.data }));
    }
  });

  function postToHost(msg) {
    msg.__symphonee = true;
    window.parent.postMessage(msg, '*');
  }

  // Auto-inject CSS theme variables from the parent window
  try {
    var parentDoc = window.parent.document.documentElement;
    var computed = window.parent.getComputedStyle(parentDoc);
    var vars = [
      '--crust', '--mantle', '--base', '--surface0', '--surface1', '--surface2',
      '--overlay0', '--overlay1', '--subtext0', '--subtext1', '--text',
      '--blue', '--sapphire', '--green', '--yellow', '--peach', '--red', '--mauve', '--teal',
      '--accent', '--font-ui', '--font-mono', '--radius', '--radius-lg'
    ];
    var css = vars.map(function (v) {
      return v + ': ' + computed.getPropertyValue(v);
    }).join('; ');
    var style = document.createElement('style');
    var baseCss = ':root { ' + css + ' } body { font-family: var(--font-ui); color: var(--text); background: var(--base); margin: 0; }';

    var tintCss = '';
    try {
      var iframes = window.parent.document.querySelectorAll('iframe[data-plugin-id]');
      for (var i = 0; i < iframes.length; i++) {
        if (iframes[i].contentWindow === window && iframes[i].dataset.tint) {
          var rgb = iframes[i].dataset.tint;
          tintCss = ':root { --plugin-tint: ' + rgb + '; --accent: rgb(' + rgb + '); }'
            + ' body { border-top: 2px solid rgba(' + rgb + ', 0.35); }';
          break;
        }
      }
    } catch (_) {}

    style.textContent = baseCss + tintCss;
    document.head.appendChild(style);
  } catch (_) {
    // Silently fail if cross-origin
  }

  var api = {
    getContext: function () {
      return new Promise(function (resolve) {
        var id = ++reqId;
        pending.set(id, resolve);
        postToHost({ type: 'getContext', requestId: id });
        setTimeout(function () {
          if (pending.has(id)) { pending.delete(id); resolve(null); }
        }, 3000);
      });
    },

    switchTab: function (tab) { postToHost({ type: 'switchTab', tab: tab }); },
    viewWorkItem: function (id) { postToHost({ type: 'viewWorkItem', id: id }); },
    openSettings: function (tab) { postToHost({ type: 'openSettings', tab: tab || 'plugins' }); },

    askAi: function (prompt) { postToHost({ type: 'askAi', prompt: prompt }); },

    toast: function (message, level) { postToHost({ type: 'toast', message: message, level: level || 'info' }); },

    api: function (apiPath, options) {
      options = options || {};
      return fetch('http://127.0.0.1:3800' + apiPath, {
        method: options.method || 'GET',
        headers: Object.assign({ 'Content-Type': 'application/json' }, options.headers || {}),
        body: options.body ? JSON.stringify(options.body) : undefined,
      }).then(function (r) { return r.json(); });
    },

    on: function (event, callback) {
      window.addEventListener('symphonee:' + event, function (e) { callback(e.detail); });
    },
  };

  window.Symphonee = api;
})();
