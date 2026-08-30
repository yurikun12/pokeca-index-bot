import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const OUT_DIR = path.resolve("data");

const RAW_URL =
  "https://api.pokeca-chart.com/php/get-index-chart-data.php?mode=cache&cache_name=index_0";

const PSA10_URL =
  "https://api.pokeca-chart.com/php/get-index-chart-data.php?mode=cache&cache_name=index_2";

const BOX_URL =
  "https://api.pokeca-chart.com/api/v1/box/index-chart-data";

const API_HEADERS = {
  Accept: "*/*",
  Origin: "https://pokeca-chart.com",
  Referer: "https://pokeca-chart.com/",
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/151 Safari/537.36"
};

await fs.mkdir(OUT_DIR, { recursive: true });


/* =========================================================
   HTTP
========================================================= */

async function fetchJson(url, attempts = 3) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        headers: API_HEADERS,
        signal: AbortSignal.timeout(30_000)
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }

      return await res.json();
    } catch (error) {
      lastError = error;

      console.warn(
        `Fetch failed (${attempt}/${attempts}): ${url}`
      );

      if (attempt < attempts) {
        const waitMs = 500 * 2 ** (attempt - 1);
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }
    }
  }

  throw lastError;
}


/* =========================================================
   日付
========================================================= */

function jstDate(offsetDays = 0) {
  const date = new Date(
    Date.now() + 9 * 60 * 60 * 1000
  );

  date.setUTCDate(
    date.getUTCDate() + offsetDays
  );

  return date.toISOString().slice(0, 10);
}


/* =========================================================
   BOX API 復号
========================================================= */

function decryptBoxData(
  ciphertext,
  saltHex,
  ivHex,
  date
) {
  const password = `vQpUc4ej${date}`;

  const key = crypto.pbkdf2Sync(
    password,
    Buffer.from(saltHex, "hex"),
    100,
    32,
    "sha512"
  );

  const iv = Buffer.from(ivHex, "hex");

  const decipher = crypto.createDecipheriv(
    "aes-256-cbc",
    key,
    iv
  );

  let decrypted = decipher.update(
    ciphertext,
    "base64",
    "utf8"
  );

  decrypted += decipher.final("utf8");

  return JSON.parse(decrypted);
}

async function fetchBox() {
  const json = await fetchJson(BOX_URL);

  if (
    json?.code !== 0 &&
    json?.code !== 200
  ) {
    throw new Error(
      `BOX API error: ${json?.code} ${json?.message ?? ""}`
    );
  }

  const ciphertext = json?.data?.c;
  const salt = json?.data?.s;
  const iv = json?.data?.i;

  if (!ciphertext || !salt || !iv) {
    throw new Error(
      "BOX API encrypted data is missing"
    );
  }

  let lastError;

  // サイト本体と同じく、
  // JSTの当日 → 前日の順で復号を試す
  for (const offset of [0, -1]) {
    const date = jstDate(offset);

    try {
      const data = decryptBoxData(
        ciphertext,
        salt,
        iv,
        date
      );

      if (!Array.isArray(data)) {
        throw new Error(
          "Decrypted BOX data is not an array"
        );
      }

      console.log(
        `BOX decrypt succeeded: ${date}`
      );

      return data;
    } catch (error) {
      lastError = error;

      console.warn(
        `BOX decrypt failed: ${date}`
      );
    }
  }

  throw new Error(
    `BOX decrypt failed: ${
      lastError?.message ?? String(lastError)
    }`
  );
}


/* =========================================================
   指数計算
========================================================= */

function latest(arr) {
  if (!Array.isArray(arr) || arr.length === 0) {
    return null;
  }

  return arr[arr.length - 1];
}

function findOnOrBefore(
  arr,
  targetDate,
  valueKey
) {
  const targetTime = new Date(
    `${targetDate}T00:00:00Z`
  ).getTime();

  for (let i = arr.length - 1; i >= 0; i--) {
    const row = arr[i];

    const rowTime = new Date(
      `${row.date}T00:00:00Z`
    ).getTime();

    if (
      rowTime <= targetTime &&
      Number.isFinite(Number(row[valueKey]))
    ) {
      return row;
    }
  }

  return null;
}

function pctChange(current, previous) {
  const a = Number(current);
  const b = Number(previous);

  if (
    !Number.isFinite(a) ||
    !Number.isFinite(b) ||
    b === 0
  ) {
    return null;
  }

  return ((a - b) / b) * 100;
}

function summarize(arr, valueKey) {
  const end = latest(arr);

  if (!end) {
    return null;
  }

  const endDate = new Date(
    `${end.date}T00:00:00Z`
  );

  function prior(days) {
    const date = new Date(endDate);

    date.setUTCDate(
      date.getUTCDate() - days
    );

    return findOnOrBefore(
      arr,
      date.toISOString().slice(0, 10),
      valueKey
    );
  }

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

    change_1d_pct:
      pctChange(end[valueKey], p1?.[valueKey]),

    change_7d_pct:
      pctChange(end[valueKey], p7?.[valueKey]),

    change_30d_pct:
      pctChange(end[valueKey], p30?.[valueKey]),

    change_90d_pct:
      pctChange(end[valueKey], p90?.[valueKey]),

    change_365d_pct:
      pctChange(end[valueKey], p365?.[valueKey])
  };
}


/* =========================================================
   前回BOXデータ
========================================================= */

async function loadPreviousBoxData() {
  try {
    const text = await fs.readFile(
      path.join(OUT_DIR, "box-index.json"),
      "utf8"
    );

    const data = JSON.parse(text);

    if (Array.isArray(data) && data.length > 0) {
      return data;
    }
  } catch {
    // 前回データがなければ null
  }

  return null;
}


/* =========================================================
   データ取得
========================================================= */

console.log("Fetching Pokeca indices...");

const [
  rawResult,
  psa10Result,
  boxResult
] = await Promise.allSettled([
  fetchJson(RAW_URL),
  fetchJson(PSA10_URL),
  fetchBox()
]);


/* =========================================================
   RAW
========================================================= */

if (
  rawResult.status !== "fulfilled" ||
  !Array.isArray(rawResult.value)
) {
  throw new Error(
    `RAW fetch failed: ${
      rawResult.reason?.message ??
      String(rawResult.reason)
    }`
  );
}

const raw = rawResult.value;


/* =========================================================
   PSA10
========================================================= */

if (
  psa10Result.status !== "fulfilled" ||
  !Array.isArray(psa10Result.value)
) {
  throw new Error(
    `PSA10 fetch failed: ${
      psa10Result.reason?.message ??
      String(psa10Result.reason)
    }`
  );
}

const psa10 = psa10Result.value;


/* =========================================================
   BOX
========================================================= */

let box;
let boxStatus = "ok";
let boxError = null;

if (
  boxResult.status === "fulfilled" &&
  Array.isArray(boxResult.value)
) {
  box = boxResult.value;
} else {
  boxStatus = "previous_data";

  boxError =
    boxResult.reason?.message ??
    String(boxResult.reason);

  console.error(
    `BOX fetch failed: ${boxError}`
  );

  box = await loadPreviousBoxData();

  if (box) {
    console.warn(
      "Using previous BOX data."
    );
  } else {
    console.warn(
      "Previous BOX data is not available."
    );

    box = [];
  }
}


/* =========================================================
   latest.json
========================================================= */

const output = {
  fetched_at: new Date().toISOString(),

  source: "pokeca-chart.com",

  status: {
    raw: "ok",
    psa10: "ok",
    box: boxStatus,
    box_error: boxError
  },

  latest: {
    raw: summarize(raw, "price"),
    psa10: summarize(psa10, "price"),
    box:
      box.length > 0
        ? summarize(box, "value")
        : null
  },

  counts: {
    raw: raw.length,
    psa10: psa10.length,
    box: box.length
  }
};


/* =========================================================
   ファイル保存
========================================================= */

await fs.writeFile(
  path.join(OUT_DIR, "latest.json"),
  JSON.stringify(output, null, 2) + "\n"
);

await fs.writeFile(
  path.join(OUT_DIR, "raw-index.json"),
  JSON.stringify(raw, null, 2) + "\n"
);

await fs.writeFile(
  path.join(OUT_DIR, "psa10-index.json"),
  JSON.stringify(psa10, null, 2) + "\n"
);

// 新しいBOXデータを正常取得できたときだけ更新
if (
  boxStatus === "ok" &&
  box.length > 0
) {
  await fs.writeFile(
    path.join(OUT_DIR, "box-index.json"),
    JSON.stringify(box, null, 2) + "\n"
  );
}


/* =========================================================
   完了
========================================================= */

console.log("Pokeca indices updated.");

console.log(
  JSON.stringify(output, null, 2)
);
