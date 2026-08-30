import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const OUT_DIR = path.resolve("data");
await fs.mkdir(OUT_DIR, { recursive: true });

const RAW_URL =
  "https://api.pokeca-chart.com/php/get-index-chart-data.php?mode=cache&cache_name=index_0";

const PSA10_URL =
  "https://api.pokeca-chart.com/php/get-index-chart-data.php?mode=cache&cache_name=index_2";

const BOX_URL =
  "https://api.pokeca-chart.com/api/v1/box/index-chart-data";


/* =========================
   共通
========================= */

function latest(arr) {
  return Array.isArray(arr) && arr.length
    ? arr[arr.length - 1]
    : null;
}

function findOnOrBefore(arr, targetDate, valueKey) {
  const t = new Date(
    targetDate + "T00:00:00Z"
  ).getTime();

  for (let i = arr.length - 1; i >= 0; i--) {
    const row = arr[i];

    const d = new Date(
      row.date + "T00:00:00Z"
    ).getTime();

    if (
      d <= t &&
      Number.isFinite(Number(row[valueKey]))
    ) {
      return row;
    }
  }

  return null;
}

function pctChange(a, b) {
  a = Number(a);
  b = Number(b);

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

  if (!end) return null;

  const endDate = new Date(
    end.date + "T00:00:00Z"
  );

  const prior = (days) => {
    const d = new Date(endDate);

    d.setUTCDate(
      d.getUTCDate() - days
    );

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

    volume:
      end.volume ?? null,

    box_num:
      end.box_num ?? null,

    change_1d_pct:
      pctChange(
        end[valueKey],
        p1?.[valueKey]
      ),

    change_7d_pct:
      pctChange(
        end[valueKey],
        p7?.[valueKey]
      ),

    change_30d_pct:
      pctChange(
        end[valueKey],
        p30?.[valueKey]
      ),

    change_90d_pct:
      pctChange(
        end[valueKey],
        p90?.[valueKey]
      ),

    change_365d_pct:
      pctChange(
        end[valueKey],
        p365?.[valueKey]
      )
  };
}


/* =========================
   HTTP
========================= */

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/151 Safari/537.36",

      "Origin":
        "https://pokeca-chart.com",

      "Referer":
        "https://pokeca-chart.com/",

      "Accept":
        "*/*"
    }
  });

  if (!res.ok) {
    throw new Error(
      `HTTP ${res.status} for ${url}`
    );
  }

  return await res.json();
}


/* =========================
   JST日付
========================= */

function jstDate(offsetDays = 0) {
  /*
    Date.now() に9時間足して
    UTCとして日付部分だけ取得
  */

  const d = new Date(
    Date.now() +
    9 * 60 * 60 * 1000
  );

  d.setUTCDate(
    d.getUTCDate() + offsetDays
  );

  return d
    .toISOString()
    .slice(0, 10);
}


/* =========================
   BOX復号
========================= */

function decryptBoxData(
  ciphertext,
  saltHex,
  ivHex,
  date
) {
  const password =
    "vQpUc4ej" + date;

  /*
    CryptoJS側:

    PBKDF2(
      password,
      Hex.parse(salt),
      {
        SHA512,
        iterations: 100,
        keySize: 8
      }
    )

    CryptoJS keySize 8
    = 8 × 32bit
    = 256bit
    = 32byte
  */

  const key = crypto.pbkdf2Sync(
    password,
    Buffer.from(
      saltHex,
      "hex"
    ),
    100,
    32,
    "sha512"
  );

  const iv = Buffer.from(
    ivHex,
    "hex"
  );

  const decipher =
    crypto.createDecipheriv(
      "aes-256-cbc",
      key,
      iv
    );

  let decrypted =
    decipher.update(
      ciphertext,
      "base64",
      "utf8"
    );

  decrypted +=
    decipher.final("utf8");

  return JSON.parse(
    decrypted
  );
}


/* =========================
   BOX取得
========================= */

async function fetchBox() {
  const json =
    await fetchJson(BOX_URL);

  if (
    json?.code !== 0 &&
    json?.code !== 200
  ) {
    throw new Error(
      `BOX API error: ` +
      `${json?.code} ` +
      `${json?.message}`
    );
  }

  const c = json?.data?.c;
  const s = json?.data?.s;
  const i = json?.data?.i;

  if (!c || !s || !i) {
    throw new Error(
      "BOX API encrypted data missing"
    );
  }

  let lastError;

  /*
    サイト本体と同じ挙動

    今日のJST日付で復号
    ↓
    失敗
    ↓
    昨日のJST日付で復号
  */

  for (const offset of [0, -1]) {
    const date =
      jstDate(offset);

    try {
      const data =
        decryptBoxData(
          c,
          s,
          i,
          date
        );

      if (!Array.isArray(data)) {
        throw new Error(
          "BOX decrypted data is not an array"
        );
      }

      console.log(
        `BOX decrypt succeeded: ${date}`
      );

      return data;

    } catch (err) {
      lastError = err;

      console.warn(
        `BOX decrypt failed: ${date}`
      );
    }
  }

  throw new Error(
    "BOX decrypt failed: " +
    String(
      lastError?.message ||
      lastError
    )
  );
}


/* =========================
   データ取得
========================= */

const results =
  await Promise.allSettled([
    fetchJson(RAW_URL),
    fetchJson(PSA10_URL),
    fetchBox()
  ]);

const [
  rawResult,
  psa10Result,
  boxResult
] = results;


/* =========================
   RAW
========================= */

if (
  rawResult.status !== "fulfilled" ||
  !Array.isArray(rawResult.value)
) {
  throw new Error(
    "RAW API fetch failed: " +
    String(
      rawResult.reason ||
      "not array"
    )
  );
}

const raw =
  rawResult.value;


/* =========================
   PSA10
========================= */

if (
  psa10Result.status !== "fulfilled" ||
  !Array.isArray(psa10Result.value)
) {
  throw new Error(
    "PSA10 API fetch failed: " +
    String(
      psa10Result.reason ||
      "not array"
    )
  );
}

const psa10 =
  psa10Result.value;


/* =========================
   BOX
========================= */

let box = null;
let boxStatus = "ok";
let boxError = null;

if (
  boxResult.status === "fulfilled" &&
  Array.isArray(boxResult.value)
) {
  box =
    boxResult.value;

} else {

  boxStatus =
    "previous_data";

  boxError =
    String(
      boxResult.reason?.message ||
      boxResult.reason ||
      "unknown"
    );

  console.error(
    "BOX fetch failed:",
    boxError
  );

  /*
    BOXだけ失敗した場合は
    前回保存データを使う
  */

  try {
    const previous =
      JSON.parse(
        await fs.readFile(
          path.join(
            OUT_DIR,
            "box-index.json"
          ),
          "utf8"
        )
      );

    if (
      Array.isArray(previous)
    ) {
      box =
        previous;

      console.warn(
        "Using previous BOX data."
      );
    }

  } catch (err) {

    console.warn(
      "Previous BOX data not available."
    );

    box = [];
  }
}


/* =========================
   latest.json
========================= */

const output = {

  fetched_at:
    new Date().toISOString(),

  source:
    "pokeca-chart.com",

  status: {

    raw:
      "ok",

    psa10:
      "ok",

    box:
      boxStatus,

    box_error:
      boxError
  },

  latest: {

    raw:
      summarize(
        raw,
        "price"
      ),

    psa10:
      summarize(
        psa10,
        "price"
      ),

    box:
      Array.isArray(box) &&
      box.length
        ? summarize(
            box,
            "value"
          )
        : null
  },

  counts: {

    raw:
      raw.length,

    psa10:
      psa10.length,

    box:
      Array.isArray(box)
        ? box.length
        : 0
  }
};


/* =========================
   保存
========================= */

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

/*
  BOXが今回正常取得できた場合だけ
  box-index.json を更新

  失敗時に前回データで
  上書きしない
*/

if (
  boxStatus === "ok" &&
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
