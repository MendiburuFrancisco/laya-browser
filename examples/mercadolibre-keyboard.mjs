#!/usr/bin/env node
// Search Mercado Libre Argentina and report the first product marked as a special offer.
import { JevBrowser } from "../src/index.mjs";

const URL = "https://www.mercadolibre.com.ar/";
const query = "Teclado mecanicos";
const headed = process.env.JEV_BROWSER_HEADED !== "0";
const userDataDir = process.env.JEV_BROWSER_PROFILE || undefined;

const step = async (browser, goal, options = {}) => {
  console.log(`\n▶ ${goal}`);
  const result = await browser.do(goal, {
    ...options,
    log: line => console.log(line),
  });
  console.log(`  = ${result.status} → ${result.url}`);
  if (!["done", "likely_done"].includes(result.status)) {
    throw new Error(`${goal} no terminó: ${result.info || result.status}`);
  }
  return result;
};

const firstText = async (page, selectors) => {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count() && await locator.isVisible().catch(() => false)) {
      const text = (await locator.innerText()).trim();
      if (text) return text;
    }
  }
  return null;
};

const browser = await JevBrowser.launch({
  headed,
  slowMo: headed ? 150 : 0,
  highlight: headed,
  userDataDir,
});

try {
  await browser.open(URL);
  await step(browser, `Search for ${query}`, { values: { search: query }, maxActions: 12 });
  await step(browser, "Complete the visible 'No soy un robot' verification if Mercado Libre shows one, then continue to the search results", { maxActions: 8 });
  await step(browser, "Open the first product marked 'Oferta imperdible' in the results", { maxActions: 12 });

  const title = await firstText(browser.page, ["h1.ui-pdp-title", "h1"]);
  const price = await firstText(browser.page, [
    ".ui-pdp-price__second-line .andes-money-amount__fraction",
    ".ui-pdp-price__main .andes-money-amount__fraction",
    '[data-testid="price-part"]',
  ]);

  if (!price) {
    throw new Error("No se encontró el precio en la página del producto; revisa con browser_snapshot.");
  }

  console.log(`\nProducto: ${title || "(sin título)"}`);
  console.log(`Precio: $ ${price}`);
} finally {
  await browser.close();
}
