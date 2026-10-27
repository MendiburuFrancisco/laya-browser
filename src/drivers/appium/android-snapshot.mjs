const decode = text => String(text ?? "").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function attributes(xml) {
  const out = {};
  for (const match of xml.matchAll(/([\w:-]+)="((?:\\.|[^"])*)"/g)) out[match[1]] = decode(match[2]);
  return out;
}

function visibleBounds(value) {
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(value ?? "");
  if (!match) return null;
  const [, x1, y1, x2, y2] = match.map(Number);
  const x = Math.max(0, x1), y = Math.max(0, y1), right = Math.max(x, x2), bottom = Math.max(y, y2);
  return { x, y, width: right - x, height: bottom - y };
}

const xpathLiteral = value => {
  const text = String(value ?? "");
  if (!text.includes("'")) return `'${text}'`;
  if (!text.includes('"')) return `"${text}"`;
  return `concat(${text.split("'").map(part => `'${part}'`).join(`, "'", `)})`;
};

function descendantText(node, sensitive = false) {
  if (node.hidden) return "";
  const ownSensitive = sensitive || node.sensitive;
  const own = node.a["content-desc"] || node.a.text || "";
  const children = node.children.map(child => descendantText(child, ownSensitive)).filter(Boolean);
  return ownSensitive && (own || children.length) ? "[redacted]" : [own, ...children].filter(Boolean).join(" ");
}

export function parseAndroidSnapshot(xml, { packageName = "", activity = "", maxElements = 300, maxText = 12000 } = {}) {
  const nodes = [], stack = [], root = { path: "/hierarchy", childCounts: {} };
  const hierarchy = attributes(String(xml).match(/<hierarchy\b([^>]*)>/)?.[1] ?? "");
  const width = Number(hierarchy.width) || Infinity, height = Number(hierarchy.height) || Infinity;
  for (const match of String(xml ?? "").matchAll(/<(\/)?([\w.]+)([^>]*?)(\/)?>/g)) {
    const [, closing, tag, rawAttributes, selfClosing] = match;
    if (tag === "hierarchy") continue;
    if (closing) { stack.pop(); continue; }
    const parent = stack.at(-1) ?? root;
    const childIndex = (parent.childCounts[tag] ?? 0) + 1;
    parent.childCounts[tag] = childIndex;
    const node = { a: attributes(rawAttributes), children: [], childCounts: {}, path: `${parent.path}/${tag}[${childIndex}]` };
    node.hidden = stack.at(-1)?.hidden || node.a.displayed === "false" || node.a["visible-to-user"] === "false";
    node.sensitive = stack.at(-1)?.sensitive || node.a.password === "true" || /password|passwd|secret|token/i.test(node.a["resource-id"] ?? "");
    nodes.push(node);
    if (stack.length) stack.at(-1).children.push(node);
    if (!selfClosing) stack.push(node);
  }
  const candidates = [];
  for (const node of nodes) {
    const a = node.a;
    if (node.hidden) continue;
    const bounds = visibleBounds(a.bounds);
    if (bounds) {
      bounds.width = Math.max(0, Math.min(bounds.x + bounds.width, width) - bounds.x);
      bounds.height = Math.max(0, Math.min(bounds.y + bounds.height, height) - bounds.y);
    }
    if (!bounds || !bounds.width || !bounds.height) continue;
    const cls = a.class || "android.view.View";
    const edit = /EditText/.test(cls) || a["password"] === "true";
    const sensitive = node.sensitive;
    const text = sensitive ? "[redacted]" : a.text || "";
    const label = sensitive ? "[redacted]" : descendantText(node);
    const actions = [];
    if (a.enabled === "true" && a.clickable === "true") actions.push("click");
    if (a.enabled === "true" && edit) actions.push("type", "clear");
    if (a.enabled === "true" && a.scrollable === "true") actions.push("scroll");
    if (!actions.length && !text && !a["content-desc"]) continue;
    const predicates = [`@class=${xpathLiteral(cls)}`, `@bounds=${xpathLiteral(a.bounds)}`];
    if (a.text !== undefined) predicates.push(`@text=${xpathLiteral(a.text)}`);
    if (a["content-desc"] !== undefined) predicates.push(`@content-desc=${xpathLiteral(a["content-desc"])}`);
    if (a["resource-id"]) predicates.push(`@resource-id=${xpathLiteral(a["resource-id"])}`);
    const element = {
      tag: cls, role: edit ? "textbox" : a.checkable === "true" ? "checkbox" : a.clickable === "true" ? "button" : "text",
      label, text, value: sensitive ? "[redacted]" : edit ? (a["showing-hint"] === "true" ? "" : text) : null,
      ...(edit && a["showing-hint"] === "true" ? { placeholder: a.hint || text } : {}),
      enabled: a.enabled === "true", checked: a.checkable === "true" ? a.checked === "true" : null,
      selected: a.selected === "true" ? true : a.selected === "false" ? false : null,
      clickable: a.clickable === "true", bounds, actions,
    };
    Object.defineProperty(element, "_native", { value: { xpath: `${node.path}[${predicates.join(" and ")}]`, identity: `${cls}:${a["resource-id"] ?? ""}`, showingHint: a["showing-hint"] === "true" }, enumerable: false });
    candidates.push(element);
  }
  const elements = candidates.slice(0, maxElements).map((element, index) => {
    const numbered = { i: index + 1, ...element };
    Object.defineProperty(numbered, "_native", { value: element._native, enumerable: false });
    return numbered;
  });
  const texts = candidates.map(element => element.text).filter(Boolean);
  const rawText = texts.join(" ");
  const truncated = candidates.length > elements.length || rawText.length > maxText;
  return {
    platform: "android", url: `app://${packageName}/${activity}`, title: activity || packageName,
    text: rawText.slice(0, maxText), elements, metrics: { elements: elements.length }, package: packageName, activity,
    ...(truncated ? { truncated: true, truncation: { elements_dropped: candidates.length - elements.length, text_chars_dropped: Math.max(0, rawText.length - maxText) } } : {}),
  };
}
