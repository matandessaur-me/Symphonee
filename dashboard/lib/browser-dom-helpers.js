// browser-dom-helpers -- the DOM helper functions (normalizeText, cssPath,
// clickElement, describeForm, walkDocuments, ...) injected verbatim into the
// page during browser automation. A pure template string split out of
// browser-agent.js. Edit here; browser-agent.js requires it.
module.exports =`
function normalizeText(value) {
  return String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
}
function cleanText(value, maxLen) {
  var text = String(value || '').replace(/\\s+/g, ' ').trim();
  if (!maxLen || text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...';
}
function safeCssEscape(value) {
  if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') return CSS.escape(value);
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, function(ch) {
    return '\\\\' + ch;
  });
}
function isVisible(el) {
  if (!el) return false;
  var win = el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView : window;
  var style = win.getComputedStyle(el);
  if (!style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  var rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
function getFrameElements(doc) {
  return Array.from(doc.querySelectorAll('iframe, frame'));
}
function getDocumentByFramePath(framePath) {
  var doc = document;
  for (var i = 0; i < (framePath || []).length; i++) {
    var idx = framePath[i];
    var frames = getFrameElements(doc);
    var frameEl = frames[idx];
    if (!frameEl) return null;
    try {
      doc = frameEl.contentDocument;
    } catch (_) {
      return null;
    }
    if (!doc) return null;
  }
  return doc;
}
function getFrameMeta(doc, framePath) {
  if (!framePath || !framePath.length) return { framePath: [], frameName: null, frameSrc: location.href, accessible: true };
  var parentDoc = document;
  var frameEl = null;
  for (var i = 0; i < framePath.length; i++) {
    var frames = getFrameElements(parentDoc);
    frameEl = frames[framePath[i]];
    if (!frameEl) break;
    try { parentDoc = frameEl.contentDocument; } catch (_) { break; }
  }
  return {
    framePath: framePath.slice(),
    frameName: frameEl ? (frameEl.name || frameEl.id || null) : null,
    frameSrc: frameEl ? (frameEl.getAttribute('src') || null) : null,
    accessible: !!(frameEl && frameEl.contentDocument)
  };
}
function walkDocuments(maxDepth) {
  maxDepth = Math.max(0, Math.min(maxDepth || 4, 8));
  var out = [];
  function visit(doc, framePath, depth) {
    out.push({ doc: doc, framePath: framePath.slice(), accessible: true });
    if (depth >= maxDepth) return;
    getFrameElements(doc).forEach(function(frameEl, idx) {
      var nextPath = framePath.concat(idx);
      try {
        if (frameEl.contentDocument) visit(frameEl.contentDocument, nextPath, depth + 1);
        else out.push({ framePath: nextPath, accessible: false, frameName: frameEl.name || frameEl.id || null, frameSrc: frameEl.getAttribute('src') || null });
      } catch (_) {
        out.push({ framePath: nextPath, accessible: false, frameName: frameEl.name || frameEl.id || null, frameSrc: frameEl.getAttribute('src') || null });
      }
    });
  }
  visit(document, [], 0);
  return out;
}
function labelsFor(el) {
  var doc = el && el.ownerDocument ? el.ownerDocument : document;
  var labels = [];
  try {
    if (el.labels && el.labels.length) {
      labels = labels.concat(Array.from(el.labels).map(function(label) { return cleanText(label.innerText || label.textContent || '', 160); }));
    }
  } catch (_) {}
  if (el.id) {
    try {
      labels = labels.concat(Array.from(doc.querySelectorAll('label[for="' + safeCssEscape(el.id) + '"]')).map(function(label) {
        return cleanText(label.innerText || label.textContent || '', 160);
      }));
    } catch (_) {}
  }
  return Array.from(new Set(labels.filter(Boolean)));
}
function selectorHint(el) {
  if (!el || !el.tagName) return null;
  var tag = el.tagName.toLowerCase();
  if (el.id) return '#' + el.id;
  if (el.name) return tag + '[name="' + el.name + '"]';
  var type = el.getAttribute && el.getAttribute('type');
  if (type) return tag + '[type="' + type + '"]';
  return tag;
}
function cssPath(el) {
  if (!el || !el.tagName) return null;
  if (el.id) return '#' + safeCssEscape(el.id);
  var parts = [];
  var cur = el;
  while (cur && cur.nodeType === 1 && cur.tagName.toLowerCase() !== 'html') {
    var tag = cur.tagName.toLowerCase();
    if (cur.id) {
      parts.unshift('#' + safeCssEscape(cur.id));
      break;
    }
    var part = tag;
    var parent = cur.parentElement;
    if (parent) {
      var siblings = Array.from(parent.children).filter(function(node) { return node.tagName === cur.tagName; });
      if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
    }
    parts.unshift(part);
    cur = parent;
  }
  return parts.join(' > ');
}
function makeHandle(framePath, element) {
  return JSON.stringify({ framePath: framePath || [], cssPath: cssPath(element) });
}
function parseHandle(handle) {
  if (!handle) return null;
  if (typeof handle === 'object') return handle;
  try { return JSON.parse(String(handle)); } catch (_) { return null; }
}
function getElementByHandle(handle) {
  var parsed = parseHandle(handle);
  if (!parsed || !parsed.cssPath) return null;
  var doc = getDocumentByFramePath(parsed.framePath || []);
  if (!doc) return null;
  try { return doc.querySelector(parsed.cssPath); } catch (_) { return null; }
}
function candidateTexts(el) {
  var texts = [];
  texts.push(cleanText(el.innerText || el.textContent || '', 200));
  texts.push(cleanText(el.value || '', 200));
  texts.push(cleanText(el.getAttribute && el.getAttribute('aria-label'), 200));
  texts.push(cleanText(el.getAttribute && el.getAttribute('placeholder'), 200));
  texts.push(cleanText(el.getAttribute && el.getAttribute('title'), 200));
  texts.push(cleanText(el.getAttribute && el.getAttribute('alt'), 200));
  texts.push(cleanText(el.getAttribute && el.getAttribute('name'), 200));
  texts.push(cleanText(el.id || '', 200));
  labelsFor(el).forEach(function(label) { texts.push(label); });
  return Array.from(new Set(texts.filter(Boolean)));
}
function scoreText(target, candidate, exact) {
  if (!candidate) return 0;
  if (candidate === target) return 500;
  if (exact) return 0;
  if (candidate.startsWith(target)) return 350;
  if (candidate.indexOf(target) >= 0) return 300;
  if (target.indexOf(candidate) >= 0) return 120;
  return 0;
}
function clickElement(el, framePath) {
  el.scrollIntoView({ block: 'center', inline: 'center' });
  try { el.focus({ preventScroll: true }); } catch (_) {}
  try { el.click(); } catch (_) {}
  return {
    clickedText: cleanText(el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '', 200),
    selectorHint: selectorHint(el),
    handle: makeHandle(framePath || [], el)
  };
}
function assignElementValue(el, value, framePath) {
  var nextValue = String(value == null ? '' : value);
  el.scrollIntoView({ block: 'center', inline: 'center' });
  try { el.focus({ preventScroll: true }); } catch (_) {}
  if (el.tagName === 'SELECT') {
    var wanted = normalizeText(nextValue);
    var option = Array.from(el.options || []).find(function(opt) {
      return normalizeText(opt.text) === wanted || normalizeText(opt.value) === wanted;
    }) || Array.from(el.options || []).find(function(opt) {
      return normalizeText(opt.text).indexOf(wanted) >= 0 || normalizeText(opt.value).indexOf(wanted) >= 0;
    });
    el.value = option ? option.value : nextValue;
  } else {
    var proto = Object.getPrototypeOf(el);
    var desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && typeof desc.set === 'function') desc.set.call(el, nextValue);
    else el.value = nextValue;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return {
    filledLabel: labelsFor(el)[0] || cleanText(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || el.id || '', 160),
    selectorHint: selectorHint(el),
    handle: makeHandle(framePath || [], el)
  };
}
function describeField(el, framePath) {
  var meta = getFrameMeta(el.ownerDocument, framePath || []);
  return {
    tag: el.tagName.toLowerCase(),
    type: el.type || null,
    name: el.name || null,
    id: el.id || null,
    role: el.getAttribute && el.getAttribute('role') || null,
    placeholder: cleanText(el.getAttribute && el.getAttribute('placeholder'), 120),
    ariaLabel: cleanText(el.getAttribute && el.getAttribute('aria-label'), 120),
    labels: labelsFor(el),
    valueText: (el.tagName === 'SELECT')
      ? cleanText(((el.selectedOptions && el.selectedOptions[0]) ? el.selectedOptions[0].text : ''), 120)
      : cleanText((el.type === 'password' ? '' : (el.value || '')), 120),
    visible: isVisible(el),
    disabled: !!el.disabled,
    selectorHint: selectorHint(el),
    cssPath: cssPath(el),
    handle: makeHandle(framePath || [], el),
    framePath: meta.framePath,
    frameName: meta.frameName,
    frameSrc: meta.frameSrc
  };
}
function describeInteractive(el, framePath) {
  var desc = describeField(el, framePath || []);
  desc.text = cleanText(el.innerText || el.textContent || el.value || '', 160);
  desc.href = cleanText(el.getAttribute && el.getAttribute('href'), 240);
  return desc;
}
function describeForm(form, framePath) {
  var meta = getFrameMeta(form.ownerDocument, framePath || []);
  var fieldSelector = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), textarea, select';
  return {
    id: form.id || null,
    name: form.name || null,
    method: form.method || 'get',
    action: form.action || form.ownerDocument.location.href,
    cssPath: cssPath(form),
    handle: makeHandle(framePath || [], form),
    framePath: meta.framePath,
    frameName: meta.frameName,
    frameSrc: meta.frameSrc,
    fields: Array.from(form.querySelectorAll(fieldSelector)).slice(0, 40).map(function(el) { return describeField(el, framePath || []); }),
    submitControls: Array.from(form.querySelectorAll('button, input[type="submit"], input[type="button"]')).slice(0, 10).map(function(el) { return describeInteractive(el, framePath || []); })
  };
}

// ── Interactivity heuristics (ported from browser-use ClickableElementDetector) ─
// browser-use uses CDP to ask the runtime which elements have a JS click
// listener. We don't have CDP here, but the on* attributes + a small set of
// framework markers (data-action, data-onclick, [\\@click], [data-v-on]) cover
// the same ground for ~80% of pages without DOM mutation.
function _hasFormControlDescendant(el, maxDepth) {
  if (!el || maxDepth <= 0) return false;
  var children = el.children ? Array.from(el.children) : [];
  for (var i = 0; i < children.length; i++) {
    var c = children[i];
    if (c.nodeType !== 1) continue;
    var tag = (c.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return true;
    if (_hasFormControlDescendant(c, maxDepth - 1)) return true;
  }
  return false;
}
function hasJsClickListener(el) {
  if (!el || el.nodeType !== 1) return false;
  if (typeof el.onclick === 'function') return true;
  if (!el.attributes) return false;
  for (var i = 0; i < el.attributes.length; i++) {
    var name = el.attributes[i].name;
    // Vue: @click v-on:click ; React surfaces as on* properties already
    // handled above. Angular: (click). Stencil/Lit: data-onclick. Generic:
    // data-action or data-click.
    if (name === '@click' || name === 'v-on:click' || name === '(click)') return true;
    if (name === 'data-onclick' || name === 'data-action' || name === 'data-click') return true;
    if (name.indexOf('data-action-') === 0) return true;  // Stimulus
  }
  return false;
}
function isInteractive(el) {
  if (!el || el.nodeType !== 1) return false;
  var tag = (el.tagName || '').toLowerCase();
  if (tag === 'html' || tag === 'body') return false;

  if (hasJsClickListener(el)) return true;

  // Iframes only count if they're large enough to actually need scrolling.
  if (tag === 'iframe' || tag === 'frame') {
    var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    if (rect && rect.width > 100 && rect.height > 100) return true;
    return false;
  }

  // Native interactive elements.
  if (tag === 'a' || tag === 'button' || tag === 'select' || tag === 'textarea') return true;
  if (tag === 'input') {
    var t = (el.type || '').toLowerCase();
    if (t !== 'hidden') return true;
  }
  if (tag === 'summary' || tag === 'details') return true;

  // Labels that proxy via "for" double-fire if we treat them as interactive.
  if (tag === 'label') {
    if (el.attributes && el.getAttribute('for')) return false;
    if (_hasFormControlDescendant(el, 2)) return true;
  }
  if (tag === 'span' && _hasFormControlDescendant(el, 2)) return true;

  // ARIA roles.
  var role = el.getAttribute && el.getAttribute('role');
  if (role) {
    var ROLES = { button: 1, link: 1, checkbox: 1, radio: 1, switch: 1, tab: 1, menuitem: 1, option: 1, combobox: 1, textbox: 1, searchbox: 1, slider: 1, spinbutton: 1 };
    if (ROLES[role]) return true;
  }

  // contenteditable.
  if (el.isContentEditable) return true;

  // Search-element class/attribute hints (Ant Design, Bootstrap, etc.).
  if (el.attributes) {
    var classStr = (el.className && typeof el.className === 'string') ? el.className.toLowerCase() : '';
    var idStr = (el.id || '').toLowerCase();
    var SEARCH_HINTS = ['search', 'magnify', 'glass', 'clickable', 'btn', 'button'];
    for (var j = 0; j < SEARCH_HINTS.length; j++) {
      if (classStr.indexOf(SEARCH_HINTS[j]) >= 0 || idStr.indexOf(SEARCH_HINTS[j]) >= 0) return true;
    }
  }

  // Pointer cursor is a strong signal.
  try {
    var win = el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView : window;
    var cs = win.getComputedStyle(el);
    if (cs && cs.cursor === 'pointer') return true;
  } catch (_) {}
  return false;
}
// True when the element is at least partially behind another, opaque element.
// Single-point center test - cheap and good enough for "is this hit-testable"
function isOccluded(el) {
  try {
    var doc = el.ownerDocument;
    if (!doc || !doc.elementFromPoint) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    var x = rect.left + rect.width / 2;
    var y = rect.top + rect.height / 2;
    var hit = doc.elementFromPoint(x, y);
    if (!hit) return false;
    if (hit === el) return false;
    if (el.contains(hit) || hit.contains(el)) return false;
    return true;
  } catch (_) { return false; }
}
// How far down/up the page is this element from the current viewport, in
// "pages" (1 page = 1 viewport height). Negative = above the fold.
function pagesAwayFromViewport(el) {
  try {
    var win = el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView : window;
    var vh = win.innerHeight || 768;
    if (vh <= 0) return 0;
    var rect = el.getBoundingClientRect();
    if (rect.top >= 0 && rect.bottom <= vh) return 0;
    if (rect.bottom < 0) return Math.round((rect.bottom / vh) * 10) / 10;
    if (rect.top > vh) return Math.round(((rect.top - vh) / vh) * 10) / 10;
    return 0;
  } catch (_) { return 0; }
}
// Enumerate interactive elements across all accessible frames.
// Mirrors browser-use's "clickable list" - the LLM gets a tight, ranked
// inventory instead of the whole DOM.
function enumerateInteractive(opts) {
  opts = opts || {};
  var maxDepth = opts.maxFrameDepth || 4;
  var maxIframes = opts.maxIframes || 100;
  var includeHidden = !!opts.includeHidden;
  var limit = opts.limit || 200;
  var iframesSeen = 0;
  var out = [];
  walkDocuments(maxDepth).forEach(function(entry) {
    if (!entry.accessible) return;
    if (iframesSeen++ > maxIframes) return;
    var nodes = Array.from(entry.doc.querySelectorAll('*'));
    for (var i = 0; i < nodes.length && out.length < limit; i++) {
      var el = nodes[i];
      if (!isInteractive(el)) continue;
      var visible = isVisible(el);
      if (!visible && !includeHidden) {
        // Surface "scrollable, N pages down" hints even when hidden.
        var pagesDown = pagesAwayFromViewport(el);
        if (Math.abs(pagesDown) < 0.05) continue;
        out.push({
          handle: makeHandle(entry.framePath, el),
          tag: el.tagName.toLowerCase(),
          text: cleanText(el.innerText || el.textContent || el.value || el.getAttribute && el.getAttribute('aria-label') || '', 80),
          visible: false,
          hiddenReason: 'offscreen',
          pagesAway: pagesDown,
          framePath: entry.framePath
        });
        continue;
      }
      out.push({
        handle: makeHandle(entry.framePath, el),
        tag: el.tagName.toLowerCase(),
        text: cleanText(el.innerText || el.textContent || el.value || el.getAttribute && el.getAttribute('aria-label') || '', 80),
        href: el.getAttribute && el.getAttribute('href') || null,
        type: el.type || null,
        role: el.getAttribute && el.getAttribute('role') || null,
        visible: visible,
        hiddenReason: visible ? null : 'css',
        occluded: visible ? isOccluded(el) : false,
        framePath: entry.framePath
      });
    }
  });
  return out;
}
`;
