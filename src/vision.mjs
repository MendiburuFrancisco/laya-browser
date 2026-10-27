// Viewport images only: normalized Box edges are mapped back to CSS mouse coordinates.
import sharp from "sharp";
import { createHash, randomUUID } from "node:crypto";
import { setting } from "./jev.mjs";

// Separate from DOM target, completion and irreversible-action thresholds.
export function imageThresholds(readSetting = setting) {
  const probability = (name, fallback) => {
    const raw = readSetting(name, String(fallback));
    const value = Number(raw);
    if (String(raw).trim() === "" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`${name} must be a number between 0 and 1`);
    }
    return value;
  };
  return { presence: probability("JEV_IMAGE_MIN_PRESENCE", 0.85), confidence: probability("JEV_IMAGE_MIN_CONFIDENCE", 0.6) };
}

export const BOX_ACTIONS = ["click", "hover", "right_click", "type", "press_enter"];
export const validBox = b => !!b && [b.left, b.right, b.top, b.bottom].every(n => Number.isFinite(n) && n >= 0 && n <= 1)
  && b.left < b.right && b.top < b.bottom;

export async function prepareImage(buffer, viewport) {
  const resized = await sharp(buffer).resize({ width: 1568, height: 1568, fit: "inside", withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
  const width = Math.max(280, resized.info.width), height = Math.max(280, resized.info.height);
  const left = Math.floor((width - resized.info.width) / 2), top = Math.floor((height - resized.info.height) / 2);
  const data = await sharp(resized.data).extend({ left, right: width - resized.info.width - left, top, bottom: height - resized.info.height - top, background: "#808080" }).png().toBuffer();
  const ref = randomUUID();
  return { ref, assets: { [ref]: { type: "image", format: "png", data_base64: data.toString("base64") } },
    viewport, width, height, content: { left, top, width: resized.info.width, height: resized.info.height },
    hash: createHash("sha256").update(buffer).digest("hex") };
}

export function boxPoint(box, image) {
  if (!validBox(box)) throw new Error("Invalid box: expected ordered edges between 0 and 1");
  const { content: c } = image;
  const x = (box.left + box.right) / 2 * image.width - c.left;
  const y = (box.top + box.bottom) / 2 * image.height - c.top;
  if (x < 0 || y < 0 || x >= c.width || y >= c.height) throw new Error("Box target is outside the screenshot content");
  return { x: x / c.width * image.viewport.width, y: y / c.height * image.viewport.height };
}

export const boxQuestions = instructions => ({
  visible: { type: "noul", instructions: `Is exactly one visible target matching ${instructions} present in \`screenshot\`? Answer no if absent or ambiguous.` },
  box: { type: "box", instructions: `Find the smallest box around ${instructions} in \`screenshot\`.` },
});
