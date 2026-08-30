import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const OUT_DIR = path.resolve("data");
await fs.mkdir(OUT_DIR, { recursive: true });

const RAW_URL =
  "https://api.pokeca-chart.com/php/get-index-chart-data.php?mode=cache&cache_name=index_0";

const PSA10_URL =
  "https://api.pokeca-chart.com/php/get-index-chart-data.php?mode=cache&cache_name=index_2";

const BOX_PAGE =
  "https://pokeca-chart.com/box/chart-index/";

function latest(arr) {
  return Array.isArray(arr) && arr.length ? arr[arr.length - 1] : null;
}

function findOnOrBefore(arr, targetDate, valueKey) {
  const t = new Date(targetDate + "T00:00:00Z").getTime();

  for (let i = arr.length - 1; i >= 0; i--) {
    const d = new Date(arr[i].date + "T00:00:00Z").getTime();

    if (
      d <= t &&
      Number.isFinite(Number(arr[i][valueKey]))
    ) {
      return arr[i];
    }
  }

  return null;
}

function pctChange(a, b) {
  a = Number(a);
  b = Number(b);

  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) {
    return null;
  }

  return ((a - b) / b) * 100;
}

function summarize(arr, valueKey) {
  const end = latest(arr);

  if (!end) return null;

  const endDate = new Date(end.date + "T00:00:00Z");

  const prior = (days) => {
    const d = new Date(endDate);
    d.setUTCDate(d.getUTCDate() - days);

    return findOnOrBefore(
      arr,
      d.toISOString().slice(0, 10),
      valueKey
    );
  };

  const p1 = prior(1);
  const p7 = prior(7);
  const p30 = prior(30);
  const p90 = prior(90);
  const p365 = prior(365);

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
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/151 Safari/537.36",
      "Origin": "https://pokeca-chart.com",
      "Referer": "https://pokeca-chart.com/",
      "Accept": "*/*"
    }
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }

  return await res.json();
}

async function fetchBox() {
  const browser = await chromium.launch({
    headless: true
  });

  try {
    const page = await browser.newPage({
      viewport: {
        width: 1280,
        height: 900
      },

      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/151 Safari/537.36"
    });

    const possibleData = [];

    page.on("response", async (response) => {
      try {
        const contentType =
          response.headers()["content-type"] || "";

        if (!contentType.includes("application/json")) {
          return;
        }

        const json = await response.json();

        if (
          Array.isArray(json) &&
          json.length > 10 &&
          json[0]?.date
        ) {
          possibleData.push(json);
        }

        if (
          json &&
          Array.isArray(json.allData) &&
          json.allData[0]?.date
        ) {
          possibleData.push(json.allData);
        }

        if (
          json?.data &&
          Array.isArray(json.data) &&
          json.data[0]?.date
        ) {
          possibleData.push(json.data);
        }
      } catch {
        // JSONでなければ無視
      }
    });

    await page.goto(BOX_PAGE, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(10000);

    const candidates = possibleData.filter((arr) =>
      arr.some(
        (row) =>
          row?.date &&
          (
            Number.isFinite(Number(row.value)) ||
            Number.isFinite(Number(row.price))
          )
      )
    );

    if (!candidates.length) {
      throw new Error(
        "BOX JSON data was not found in network responses"
      );
    }

    candidates.sort(
      (a, b) => b.length - a.length
    );

    return candidates[0];

  } finally {
    await browser.close();
  }
}

const rawPromise = fetchJson(RAW_URL);
const psa10Promise = fetchJson(PSA10_URL);

let box = null;
let boxError = null;

try {
  box = await fetchBox();
} catch (err) {
  boxError = String(err?.message || err);

  console.error(
    "BOX fetch failed:",
    boxError
  );
}

const [raw, psa10] = await Promise.all([
  rawPromise,
  psa10Promise
]);

if (!Array.isArray(raw)) {
  throw new Error(
    "raw API did not return an array"
  );
}

if (!Array.isArray(psa10)) {
  throw new Error(
    "PSA10 API did not return an array"
  );
}

/*
  BOX取得に失敗した場合は
  前回保存済みのbox-index.jsonを利用
*/

if (!Array.isArray(box)) {
  try {
    const oldBox = JSON.parse(
      await fs.readFile(
        path.join(OUT_DIR, "box-index.json"),
        "utf8"
      )
    );

    if (Array.isArray(oldBox)) {
      box = oldBox;

      console.warn(
        "Using previous BOX data."
      );
    }
  } catch {
    box = [];
  }
}

const output = {
  fetched_at: new Date().toISOString(),

  source: "pokeca-chart.com",

  status: {
    raw: "ok",
    psa10: "ok",

    box:
      boxError === null
        ? "ok"
        : "previous_data",

    box_error:
      boxError
  },

  latest: {
    raw: summarize(raw, "price"),

    psa10: summarize(
      psa10,
      "price"
    ),

    box:
      box.length
        ? summarize(
            box,
            "value"
          )
        : null
  },

  counts: {
    raw: raw.length,
    psa10: psa10.length,
    box: box.length
  }
};

await fs.writeFile(
  path.join(
    OUT_DIR,
    "latest.json"
  ),

  JSON.stringify(
    output,
    null,
    2
  ) + "\n"
);

await fs.writeFile(
  path.join(
    OUT_DIR,
    "raw-index.json"
  ),

  JSON.stringify(
    raw,
    null,
    2
  ) + "\n"
);

await fs.writeFile(
  path.join(
    OUT_DIR,
    "psa10-index.json"
  ),

  JSON.stringify(
    psa10,
    null,
    2
  ) + "\n"
);

if (
  boxError === null &&
  Array.isArray(box) &&
  box.length
) {
  await fs.writeFile(
    path.join(
      OUT_DIR,
      "box-index.json"
    ),

    JSON.stringify(
      box,
      null,
      2
    ) + "\n"
  );
}

console.log(
  JSON.stringify(
    output,
    null,
    2
  )
);
