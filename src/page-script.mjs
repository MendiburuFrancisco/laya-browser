// Runs inside each frame. Lists interactive elements in DOM order, tags each with data-jev-i,
// and returns what a person would see: labels, state, viewport text, open dialogs, page metrics.
// Must stay self-contained: Playwright serialises it into the page.
// Capture direct native event listeners before application scripts run. React's
// delegated root listeners are excluded; its actionable nodes expose DOM event
// properties or per-node props instead. The registry does not retain DOM nodes.
export const TRACK_INTERACTIONS = () => {
  if (window.__jevInteractions) return;
  const registry = new WeakMap();
  window.__jevInteractions = registry;
  const types = new Set(["click", "dblclick", "contextmenu", "pointerdown", "mousedown", "touchstart"]);
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function(type, listener, options) {
    const result = add.call(this, type, listener, options);
    if (this instanceof Element && listener && types.has(type) && !options?.once && !options?.signal) {
      let events = registry.get(this);
      if (!events) registry.set(this, events = []);
      const capture = typeof options === "boolean" ? options : !!options?.capture;
      if (!events.some(e => e.type === type && e.listener === listener && e.capture === capture)) events.push({ type, listener, capture });
    }
    return result;
  };
  EventTarget.prototype.removeEventListener = function(type, listener, options) {
    const result = remove.call(this, type, listener, options);
    const capture = typeof options === "boolean" ? options : !!options?.capture;
    const events = registry.get(this);
    if (events) registry.set(this, events.filter(e => !(e.type === type && e.listener === listener && e.capture === capture)));
    return result;
  };
};

export const ENUMERATE = ({ start, frame }) => {
  const SEL = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=menuitem], [role=menuitemcheckbox], [role=tab], [role=checkbox], [role=radio], [role=switch], [role=option], [role=combobox], [role=textbox], [role=searchbox], [role=slider], [contenteditable=""], [contenteditable=true], [onclick], [oncontextmenu], [ondblclick], [draggable=true], [tabindex]:not([tabindex="-1"])';
  const clean = (s, n = 80) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
  const all = [];
  const walk = root => { for (const el of root.querySelectorAll("*")) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot); } };
  walk(document);
  for (const el of all) if (el.hasAttribute("data-jev-i")) el.removeAttribute("data-jev-i");

  const visible = el => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const st = getComputedStyle(el);
    // transparent checkboxes/radios/file inputs are usually styled replacements that still take clicks
    return st.visibility !== "hidden" && st.display !== "none" && (+st.opacity > 0.05 || /^(checkbox|radio|file)$/.test(el.type));
  };
  const byIds = ids => clean((ids || "").split(/\s+/).map(id => document.getElementById(id)?.innerText).filter(Boolean).join(" "));
  const sibText = el => {
    let t = "";
    for (let n = el.nextSibling; n && t.trim().length < 40; n = n.nextSibling) {
      if (n.nodeType === 1 && n.matches("input, select, textarea, button, br, label, div, p, li")) break;
      t += n.textContent;
    }
    return clean(t, 60);
  };
  const labelOf = el => clean(byIds(el.getAttribute("aria-labelledby")) || [...(el.labels || [])].map(l => l.innerText).join(" ") || el.getAttribute("aria-label") || "");
  const handlers = ["onclick", "ondblclick", "oncontextmenu", "onpointerdown", "onmousedown", "ontouchstart"];
  const frameworkHandlers = ["onClick", "onClickCapture", "onDoubleClick", "onContextMenu", "onPointerDown", "onMouseDown", "onTouchStart"];
  const bound = el => {
    if (handlers.some(k => typeof el[k] === "function")) return true;
    // Handles React nodes such as SVG controls where no DOM onclick shim exists.
    const propsKey = Object.keys(el).find(k => k.startsWith("__reactProps$"));
    if (propsKey && frameworkHandlers.some(k => typeof el[propsKey]?.[k] === "function")) return true;
    // Frameworks install listeners on their app root to delegate events. A root
    // listener does not make the entire application a useful clickable target.
    const events = window.__jevInteractions?.get(el);
    return !!events?.length && !Object.keys(el).some(k => k.startsWith("__reactContainer$")) && !el.matches("html, body");
  };

  // Stable XPath so decisions can be persisted and replayed without asking Jev again.
  // Prefers element ids; otherwise a positional path rooted at the nearest id ancestor.
  const xpathOf = el => {
    if (el.id) return `//*[@id='${el.id}']`;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1) {
      let index = 1, sib = node.previousElementSibling;
      while (sib) { if (sib.tagName === node.tagName) index++; sib = sib.previousElementSibling; }
      parts.unshift(node.tagName.toLowerCase() + "[" + index + "]");
      node = node.parentElement;
      if (node && node.id) { parts.unshift("*[@id='" + node.id + "']"); break; }
    }
    return "//" + parts.join("/");
  };

  const out = []; let i = start; const seen = new Set();
  for (const el of all) {
    const tag = el.tagName.toLowerCase();
    let pick = el.matches(SEL) || bound(el);
    if (!pick && !["html", "body", "label", "svg", "path"].includes(tag) && el.parentElement) {
      // JS-bound clickables (div/span/th with a click handler) usually show a pointer cursor
      const cur = getComputedStyle(el).cursor;
      pick = cur === "pointer" && getComputedStyle(el.parentElement).cursor !== "pointer" && !el.closest("a, button, [role=button]");
    }
    // table headers (often sortable) and sizeable images (hover targets, image links' content)
    if (!pick && (tag === "th" && el.closest("thead") || tag === "img" && !el.closest("a, button"))) {
      const r = el.getBoundingClientRect(); pick = tag === "th" || (r.width >= 24 && r.height >= 24);
    }
    if (!pick || el.closest('[aria-hidden="true"], [inert], [data-jev-overlay]')) continue;
    const type = tag === "input" ? (el.getAttribute("type") || "text").toLowerCase() : null;
    let hit = el;
    let hidden = false;
    if (!visible(el)) {
      // custom checkboxes/radios hide the real input behind a visible label;
      // file inputs are often display:none behind a styled button but still accept files
      const lab = (type === "checkbox" || type === "radio") && [...(el.labels || [])].find(visible);
      if (lab) hit = lab;
      else if (type === "file") hidden = true;
      else continue;
    }
    if (seen.has(hit)) continue; seen.add(hit);

    const role = el.getAttribute("role");
    const o = { i };
    o.tag = type ? `input:${type}` : (role && !["a", "button", "select", "textarea"].includes(tag) ? `${tag}[${role}]` : tag);
    if (frame) o.frame = frame;
    if (hidden) o.hidden = true;
    const isField = ["input", "select", "textarea"].includes(tag) || ["textbox", "searchbox", "combobox"].includes(role) || el.isContentEditable;
    if (isField) {
      const label = labelOf(el); if (label) o.label = label;
      const ph = el.getAttribute("placeholder"); if (ph) o.placeholder = clean(ph, 60);
      if (!label && !ph && el.name) o.name = el.name;
      if (tag === "select") {
        o.value = clean(el.selectedOptions?.[0]?.text, 40);
        o.options = [...el.options].slice(0, 25).map(op => clean(op.text, 30));
      } else if (type === "checkbox" || type === "radio") {
        o.checked = el.checked;
        if (!o.label && hit !== el) o.label = clean(hit.innerText);
        if (!o.label) { const t = sibText(el); if (t) o.label = t; }
        if (el.value && el.value !== "on") o.value = clean(el.value, 30);
      } else if (["submit", "button", "reset"].includes(type)) {
        o.text = clean(el.value || label);
      } else {
        const v = el.isContentEditable && tag !== "input" ? el.innerText : el.value;
        if (v) o.value = clean(v, 60);
      }
      const list = el.getAttribute("list"); if (list) o.suggestions = [...(document.getElementById(list)?.options || [])].slice(0, 10).map(op => op.value);
    } else {
      const img = el.querySelector("img[alt], svg title");
      const text = (tag === "img" ? clean(el.getAttribute("alt")) : clean(el.innerText)) || labelOf(el) || clean(el.getAttribute("title")) || clean(img?.getAttribute?.("alt") || img?.textContent);
      if (text) o.text = text;
      const label = labelOf(el); if (label && label !== text) o.label = label;
    }
    const href = el.getAttribute("href");
    if (href && !href.startsWith("javascript")) {
      try { const u = new URL(href, location.href); o.href = clean(u.origin === location.origin ? u.pathname + u.search + u.hash : u.href, 80); } catch { o.href = clean(href, 80); }
    }
    if (el.disabled || el.getAttribute("aria-disabled") === "true") o.disabled = true;
    if (el.getAttribute("aria-busy") === "true") o.busy = true;
    const srt = el.getAttribute("aria-sort") || String(el.className?.baseVal ?? el.className ?? "").match(/sort\w*?(asc|desc|up|down)/i)?.[1];
    if (srt && srt !== "none") o.sorted = /asc|up/i.test(srt) ? "ascending" : /desc|down/i.test(srt) ? "descending" : srt;
    if (el.hasAttribute("aria-expanded")) o.expanded = el.getAttribute("aria-expanded") === "true";
    if (el.getAttribute("aria-checked")) o.checked = el.getAttribute("aria-checked") === "true";
    if (el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-current") || el.getAttribute("aria-pressed") === "true" || /\b(selected|active)\b/.test(el.className?.baseVal ?? el.className ?? "")) o.active = true;

    // short surrounding text for icon-only / generic / field controls
    const own = o.text || o.label || o.placeholder || "";
    if (own.length < 16 || isField) {
      let p = hit.parentElement;
      for (let k = 0; p && k < 5; k++, p = p.parentElement) {
        const t = clean(p.innerText, 400);
        if (t && t !== own) { if (t.length <= 100) o.near = t; break; }
      }
      const row = hit.closest("li, tr, [role=row], [role=listitem]");
      const m = row?.className && String(row.className.baseVal ?? row.className).match(/\b(completed|done|selected|active|checked|disabled|error|expanded)\b/i);
      if (m) o.row_state = m[1];
    }
    // covered: something else (a modal, overlay, banner) is on top of the element's center
    const rr = hit.getBoundingClientRect(), cx = rr.left + rr.width / 2, cy = rr.top + rr.height / 2;
    if (!hidden && cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight) {
      const top = (hit.getRootNode()?.elementFromPoint ? hit.getRootNode() : document).elementFromPoint(cx, cy);
      if (top && top !== hit && !hit.contains(top) && !top.contains(hit) && !(top.tagName === "LABEL" && top.control === el)) o.covered = true;
    }
    hit.setAttribute("data-jev-i", String(i));
    // XPath is frame-local and cannot cross shadow roots
    if (hit.getRootNode() === document) o.xpath = xpathOf(hit);
    out.push(o); i++;
  }
  const dlg = [...document.querySelectorAll('dialog[open], [role=dialog], [role=alertdialog], [aria-modal="true"]')].filter(visible).map(d => clean(d.innerText, 400)).filter(Boolean);
  // overlays that aren't marked up as dialogs: a fixed layer covering most of the viewport at its center
  for (let n = document.elementFromPoint(innerWidth / 2, innerHeight / 2); n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
    const st = getComputedStyle(n), r = n.getBoundingClientRect();
    if ((st.position === "fixed" || st.position === "sticky") && r.width * r.height >= 0.6 * innerWidth * innerHeight) {
      const t = clean(n.innerText, 400);
      if (t && !dlg.includes(t)) dlg.push(t);
      break;
    }
  }
  // text the user can currently see, in DOM order
  let seenText = "";
  if (document.body) {
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const range = document.createRange(); const vh = innerHeight;
    for (let n = tw.nextNode(); n && seenText.length < 2500; n = tw.nextNode()) {
      if (!n.textContent.trim() || !n.parentElement || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(n.parentElement.tagName)) continue;
      range.selectNodeContents(n); const r = range.getBoundingClientRect();
      if (r.bottom < 0 || r.top > vh || r.width === 0) continue;
      seenText += " " + n.textContent;
    }
    seenText = clean(seenText, 2500);
  }
  const full = document.body?.innerText ?? "";
  return {
    url: location.href, title: document.title,
    text: seenText,
    metrics: { scroll_y: Math.round(scrollY), page_height: document.documentElement.scrollHeight, text_length: full.length },
    dialogs: dlg, elements: out, next: i,
  };
};
