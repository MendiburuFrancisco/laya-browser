import { AppiumError } from "./client.mjs";

const elementId = value => value?.["element-6066-11e4-a52e-4f735466cecf"] ?? value?.ELEMENT;

async function resolve(client, element) {
  if (!element?._native?.xpath) throw new Error("Element has no current Android locator");
  return client.findElement(element._native.xpath);
}

async function focused(client, element) {
  const id = await resolve(client, element);
  await client.elementCommand(id, "POST", "click", {});
  const active = await client.command("GET", "element/active");
  if (!elementId(active) || elementId(active) !== id) {
    throw new AppiumError("Android field did not retain focus; text was not entered", { method: "POST", path: "element/click" });
  }
  return id;
}

export async function performAndroidAction(client, element, action) {
  switch (action.tool) {
    case "click": {
      const id = await resolve(client, element);
      await client.elementCommand(id, "POST", "click", {});
      return;
    }
    case "clear": {
      const id = await focused(client, element);
      await client.elementCommand(id, "POST", "clear", {});
      const active = await client.command("GET", "element/active");
      if (elementId(active) !== id) throw new AppiumError("Android field lost focus after clear", { method: "POST", path: "element/clear", outcome: "unknown" });
      return;
    }
    case "type": {
      if (action.value == null) throw new Error("no value to type");
      const id = await focused(client, element);
      await client.elementCommand(id, "POST", "clear", {});
      const active = await client.command("GET", "element/active");
      if (elementId(active) !== id) throw new AppiumError("Android field lost focus after clear; text was not entered", { method: "POST", path: "element/clear", outcome: "unknown" });
      const text = String(action.value);
      await client.elementCommand(id, "POST", "value", { text, value: [...text] });
      return;
    }
    case "scroll": {
      const bounds = element?.bounds;
      if (!bounds) throw new Error("scroll needs an observed Android scroll container");
      const x = Math.round(bounds.x + bounds.width / 2);
      const top = Math.round(bounds.y + bounds.height * 0.25);
      const bottom = Math.round(bounds.y + bounds.height * 0.75);
      const fromY = action.direction === "up" ? top : bottom;
      const toY = action.direction === "up" ? bottom : top;
      await client.command("POST", "actions", { actions: [{
        type: "pointer", id: "finger", parameters: { pointerType: "touch" },
        actions: [
          { type: "pointerMove", duration: 0, x, y: fromY },
          { type: "pointerDown", button: 0 },
          { type: "pointerMove", duration: 350, x, y: toY },
          { type: "pointerUp", button: 0 },
        ],
      }] }, { mutation: true });
      return;
    }
    case "back":
      await client.command("POST", "back", {}, { mutation: true });
      return;
    case "wait":
      return;
    case "none":
      return;
    default:
      throw new Error(`Android does not support action ${action.tool}`);
  }
}
