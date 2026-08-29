import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const OUT_DIR = path.resolve("data");
await fs.mkdir(OUT_DIR, { recursive: true });

const RAW_URL = "https://api.pokeca-chart.com/php/get-index-chart-data.php?mode=cache&cache_name=index_0";
const PSA10_URL = "https://api.pokeca-chart.com/php/get-index-chart-data.php?mode=cache&cache_name=index_2";
const BOX_PAGE = "https://pokeca-chart.com/box/chart-index/";

function latest(arr) {
  return Array.isArray(arr) && arr.length ? arr[arr.length - 1] : null;
}

function findOnOrBefore(arr, targetDate, valueKey) {
  const t = new Date(targetDate + "T00:00:00Z").getTime();
  for (let i = arr.length - 1; i >= 0; i--) {
    const d = new Date(arr[i].date + "T00:00:00Z").getTime();
    if (d <= t && Number.isFinite(Number(arr[i][valueKey]))) return arr[i];
  }
  return null;
}

function pctChange(a, b) {
  a = Number(a); b = Number(b);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return ((a - b) / b) * 100;
}

function summarize(arr, valueKey) {
  const end = latest(arr);
  if (!end) return null;
  const endDate = new Date(end.date + "T00:00:00Z");
  const prior = (days) => {
    const d = new Date(endDate);
    d.setUTCDate(d.getUTCDate() - days);
    return findOnOrBefore(arr, d.toISOString().slice(0,10), valueKey);
  };
  const p1 = prior(1), p7 = prior(7), p30 = prior(30), p90 = prior(90), p365 = prior(365);
  return {
    date: end.date,
    value: Number(end[valueKey]),
    volume: end.volume ?? null,
    box_num: end.box_num ?? null,
    change_1d_pct: pctChange(end[valueKey], p1?.[valueKey]),
    change_7d_pct: pctChange(end[valueKey], p7?.[valueKey]),
    change_30d_pct: pctChange(end[valueKey], p30?.[valueKey]),
    change_90d_pct: pctChange(end[valueKey], p90?.[valueKey]),
    change_365d_pct: pctChange(end[valueKey], p365?.[valueKey])
  };
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/151 Safari/537.36",
      "Origin": "https://pokeca-chart.com",
      "Referer": "https://pokeca-chart.com/",
      "Accept": "*/*"
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.json();
}

async function fetchBox() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/151 Safari/537.36"
    });
    await page.goto(BOX_PAGE, { waitUntil: "domcontentloaded", timeout: 120000 });

    const handle = await page.waitForFunction(() => {
      const root = document.querySelector("#__next") || document.body;
      const fk = Object.keys(root).find(k => k.startsWith("__reactFiber"));
      if (!fk) return null;

      const stack = [root[fk]];
      const seen = new Set();

      while (stack.length && seen.size < 5000) {
        const n = stack.pop();
        if (!n || seen.has(n)) continue;
        seen.add(n);

        const p = n.memoizedProps;
        if (p && Array.isArray(p.allData) && p.allData.length > 100 &&
            p.allData[0]?.date && ("value" in p.allData[0])) {
          return p.allData;
        }

        if (n.child) stack.push(n.child);
        if (n.sibling) stack.push(n.sibling);
      }
      return null;
    }, null, { timeout: 120000 });

    return await handle.jsonValue();
  } finally {
    await browser.close();
  }
}

const [raw, psa10, box] = await Promise.all([
  fetchJson(RAW_URL),
  fetchJson(PSA10_URL),
  fetchBox()
]);

if (!Array.isArray(raw)) throw new Error("raw API did not return an array");
if (!Array.isArray(psa10)) throw new Error("PSA10 API did not return an array");
if (!Array.isArray(box)) throw new Error("BOX allData was not found");

const output = {
  fetched_at: new Date().toISOString(),
  source: "pokeca-chart.com",
  latest: {
    raw: summarize(raw, "price"),
    psa10: summarize(psa10, "price"),
    box: summarize(box, "value")
  },
  counts: { raw: raw.length, psa10: psa10.length, box: box.length }
};

await fs.writeFile(path.join(OUT_DIR, "latest.json"), JSON.stringify(output, null, 2) + "\n");
await fs.writeFile(path.join(OUT_DIR, "raw-index.json"), JSON.stringify(raw, null, 2) + "\n");
await fs.writeFile(path.join(OUT_DIR, "psa10-index.json"), JSON.stringify(psa10, null, 2) + "\n");
await fs.writeFile(path.join(OUT_DIR, "box-index.json"), JSON.stringify(box, null, 2) + "\n");

console.log(JSON.stringify(output, null, 2));
