const { chromium } = require("playwright");
const fs = require("fs");
const https = require("https");
const http = require("http");
const readline = require("readline");
const path = require("path");

const USER_DATA_DIR = "./pinterest-profile";
const CONCURRENCY = 6; // safe to go higher now — no per-pin tabs

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(r => rl.question(q, r));

// ---------------- SAFE JSON ----------------
function loadJSON(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : fallback; }
  catch { return fallback; }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ---------------- DOWNLOAD (with timeout + redirect) ----------------
function download(url, filePath, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Download timeout")), timeout);

    const lib = url.startsWith("https") ? https : http;

    const req = lib.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        clearTimeout(timer);
        return resolve(download(res.headers.location, filePath, timeout));
      }
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const file = fs.createWriteStream(filePath);
      res.pipe(file);
      file.on("finish", () => { clearTimeout(timer); file.close(resolve); });
      file.on("error", (e) => { clearTimeout(timer); reject(e); });
    });

    req.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

// ---------------- PROGRESS ----------------
function progressBar(done, total) {
  const width = 32;
  const percent = Math.min(100, Math.floor((done / Math.max(total, 1)) * 100));
  const filled = Math.floor((percent / 100) * width);
  process.stdout.write(
    `\r[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${percent}% (${done}/${total})`
  );
}

// ---------------- PICK BEST IMAGE URL FROM PIN DATA ----------------
// Pinterest JSON returns images as { "736x": { url, width, height }, "orig": { url }, ... }
// We walk from highest to lowest preference
function pickBestImage(images) {
  if (!images) return null;

  const preference = ["orig", "736x", "474x", "236x", "60x60"];
  for (const key of preference) {
    if (images[key] && images[key].url) return images[key].url;
  }

  // fallback: take whatever key exists with a url
  for (const key of Object.keys(images)) {
    if (images[key] && images[key].url) return images[key].url;
  }

  return null;
}

// ---------------- EXTRACT PINS FROM INTERCEPTED RESPONSES ----------------
// Pinterest fires XHR to URLs like:
//   /resource/BoardFeedResource/get/?...
//   /resource/BoardImpressions/get/?...
// The JSON contains resource_response.data[] with pin objects
function extractPinsFromJson(json) {
  const pins = [];

  try {
    // standard board feed shape
    const data = json?.resource_response?.data;
    if (Array.isArray(data)) {
      for (const item of data) {
        // pins have an "images" key directly, pinJoin wraps them
        const pin = item?.pin || item;
        if (pin?.images && pin?.id) {
          const img = pickBestImage(pin.images);
          if (img) pins.push({ id: pin.id, url: img });
        }
      }
    }
  } catch {}

  return pins;
}

// ---------------- DETECT SECTIONS IN A BOARD (via network intercept) ----------------
// Pinterest loads section data via BoardSectionResource XHR — we intercept it
// and extract section slugs, then build section URLs from them.
async function getBoardSections(browser, boardUrl) {
  const urlParsed = new URL(boardUrl);
  const segments = urlParsed.pathname.split("/").filter(Boolean);
  const username = segments[0];
  const boardSlug = segments[1];

  const page = await browser.newPage();
  const sections = [];

  page.on("response", async (response) => {
    const url = response.url();
    if (!url.includes("pinterest.com") || !url.includes("/resource/")) return;
    const ct = response.headers()["content-type"] || "";
    if (!ct.includes("json")) return;

    try {
      const json = await response.json();
      const data = json?.resource_response?.data;
      if (!Array.isArray(data)) return;

      for (const item of data) {
        // Section objects have a "slug" and "type" === "boardsection"
        if (item?.slug && item?.type === "boardsection") {
          sections.push(item.slug);
        }
        // Some responses nest them under .section
        if (item?.section?.slug && item?.section?.type === "boardsection") {
          sections.push(item.section.slug);
        }
      }
    } catch {}
  });

  await page.goto(boardUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500); // give XHRs time to fire

  await page.close();

  // Dedupe slugs and build full URLs
  const seen = new Set();
  const result = [];
  for (const slug of sections) {
    if (!seen.has(slug)) {
      seen.add(slug);
      result.push(`https://www.pinterest.com/${username}/${boardSlug}/section/${slug}/`);
    }
  }
  return result;
}

// ---------------- SCRAPE ONE BOARD (NETWORK INTERCEPT MODE) ----------------
async function scrapeBoard(browser, boardUrl, index, total, rootDir = ".") {
  let urlParsed;
  try { urlParsed = new URL(boardUrl); } catch {
    console.log(`Skipping invalid URL: ${boardUrl}`);
    return;
  }

  const segments = urlParsed.pathname.split("/").filter(Boolean);
  const boardName = segments[segments.length - 1];

  if (!boardName || boardName.length < 2) {
    console.log(`Skipping invalid board: ${boardUrl}`);
    return;
  }

  if (!fs.existsSync(rootDir)) fs.mkdirSync(rootDir, { recursive: true });
  const dir = path.join(rootDir, boardName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const STATE_FILE = path.join(dir, "state.json");
  const META_FILE  = path.join(dir, "metadata.json");

  let state = loadJSON(STATE_FILE, { done: [] });
  let meta  = loadJSON(META_FILE, []);

  console.log(`\n[${index}/${total}] BOARD: ${boardName}`);

  let page;
  try {
    page = await browser.newPage();
  } catch (e) {
    console.log(`  Cannot open page: ${e.message}`);
    return;
  }

  // ---- INTERCEPT NETWORK RESPONSES ----
  const collectedPins = new Map(); // id → url, deduped
  let boardDone = false; // set true when sentinel detected — stops interceptor from adding more pins

  page.on("response", async (response) => {
    if (boardDone) return; // ignore anything arriving after the board ended

    const url = response.url();

    // match Pinterest's internal feed/board API calls
    if (
      !url.includes("/resource/") ||
      !url.includes("pinterest.com")
    ) return;

    // only JSON responses
    const ct = response.headers()["content-type"] || "";
    if (!ct.includes("json")) return;

    try {
      const json = await response.json();
      const pins = extractPinsFromJson(json);
      for (const p of pins) {
        if (!collectedPins.has(p.id)) {
          collectedPins.set(p.id, p.url);
        }
      }
    } catch {}
  });

  // helper: check DOM for the "Find more ideas" sentinel
  const isBoardEnded = () => page.evaluate(() => {
    const text = document.body.innerText || "";
    return (
      text.includes("More ideas") ||
      text.includes("Find more ideas") ||
      text.includes("Explore more") ||
      !!document.querySelector('[data-test-id="moreIdeasSection"]') ||
      !!document.querySelector('[data-test-id="more-ideas-section"]')
    );
  });

  // navigate and scroll
  await page.goto(boardUrl, { waitUntil: "domcontentloaded" });

  // check sentinel immediately after load — short boards hit it before first scroll
  if (await isBoardEnded()) boardDone = true;

  if (!boardDone) await page.waitForTimeout(2000);

  let lastSize = 0;
  let stagnant = 0;

  for (let i = 0; i < 120; i++) {
    if (boardDone) break;

    // check sentinel BEFORE scrolling further so we don't trigger more XHRs
    if (await isBoardEnded()) {
      boardDone = true;
      break;
    }

    await page.mouse.wheel(0, 600);

    // poll every 300ms instead of one big wait — catches the sentinel as soon as it appears
    for (let t = 0; t < 6; t++) {
      await page.waitForTimeout(300);
      if (await isBoardEnded()) { boardDone = true; break; }
    }

    if (boardDone) break;

    if (collectedPins.size === lastSize) stagnant++;
    else stagnant = 0;
    lastSize = collectedPins.size;

    // bail if scrolling with zero pins — likely a sections-only board
    if (stagnant >= 5 && i >= 4 && collectedPins.size === 0) break;
    // bail on stagnation after a few batches
    if (stagnant >= 6 && i >= 5 && collectedPins.size > 0) break;
  }

  await page.close();

  if (collectedPins.size === 0) {
    console.log("  No pins captured via network — board may be empty or Pinterest changed response format");
    return;
  }

  // filter already downloaded
  const queue = [...collectedPins.entries()].filter(([id]) => !state.done.includes(id));

  console.log(`  → ${collectedPins.size} pins found, ${queue.length} to download`);

  if (queue.length === 0) {
    console.log("  Already up to date.");
    return;
  }

  let saved = 0;
  let cursor = 0;
  progressBar(0, queue.length);

  async function worker() {
    while (cursor < queue.length) {
      const [pinId, imgUrl] = queue[cursor++];

      try {
        const clean = imgUrl.split("?")[0];
        let ext = path.extname(clean);
        if (!ext || ext.length > 6) {
          ext = clean.includes(".gif") ? ".gif" : clean.includes(".webp") ? ".webp" : ".jpg";
        }

        const filename = `pin_${pinId}${ext}`;
        const filePath = path.join(dir, filename);

        await download(imgUrl, filePath);

        state.done.push(pinId);
        meta.push({ pinId, imgUrl, filename });
        saveJSON(STATE_FILE, state);
        saveJSON(META_FILE, meta);

        saved++;
        progressBar(saved, queue.length);
      } catch (e) {
        // silently skip failed downloads — they'll retry on next run
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`\n  Done: ${boardName} (${saved} saved)`);
}

// ---------------- BOARD DISCOVERY ----------------
async function getAllBoards(browser, profileUrl) {
  const urlObj = new URL(profileUrl.startsWith("http") ? profileUrl : "https://" + profileUrl);
  const username = urlObj.pathname.split("/").filter(Boolean)[0];

  if (!username) { console.error("Cannot extract username"); process.exit(1); }
  console.log(`\nUsername: ${username}`);
  console.log("Collecting boards...");

  const boardsUrl = `https://www.pinterest.com/${username}/boards/`;
  const page = await browser.newPage();
  await page.goto(boardsUrl, { waitUntil: "domcontentloaded" });

  const boards = new Set();
  let lastSize = 0;
  let stagnant = 0;

  for (let i = 0; i < 120; i++) {
    await page.mouse.wheel(0, 800);
    await page.waitForTimeout(1500);

    const found = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a")).map(a => a.href).filter(Boolean)
    );

    for (const url of found) {
      const clean = url.split("?")[0].replace(/\/$/, "");
      let parsed;
      try { parsed = new URL(clean); } catch { continue; }

      const segs = parsed.pathname.split("/").filter(Boolean);

      if (
        segs.length === 2 &&
        segs[0] === username &&
        !segs[1].startsWith("_") &&
        !["boards", "pins", "following", "followers", "created", "saved"].includes(segs[1]) &&
        !clean.includes("/pin/") &&
        !clean.includes("/section/") &&
        !clean.includes("/search/") &&
        !clean.includes("/explore/")
      ) {
        boards.add(clean);
      }
    }

    if (boards.size === lastSize) stagnant++;
    else stagnant = 0;
    lastSize = boards.size;

    // only stop if truly stagnant for a long stretch — boards page is finite
    if (stagnant >= 20 && i >= 10) break;
  }

  await page.close();
  return [...boards];
}

// ---------------- EXTRACT USERNAME FROM BOARD URL ----------------
function extractUsername(boardUrl) {
  try {
    const url = new URL(boardUrl.startsWith("http") ? boardUrl : "https://" + boardUrl);
    return url.pathname.split("/").filter(Boolean)[0] || null;
  } catch {
    return null;
  }
}

// ---------------- MAIN ----------------
(async () => {
  console.log("\nSelect mode:");
  console.log("1 = One board");
  console.log("2 = Multiple boards (comma separated)");
  console.log("3 = Full profile (your boards only)");

  const mode = (await ask("\nChoice: ")).trim();

  let boards = [];
  let profileUrl = null;

  if (mode === "1") {
    boards = [(await ask("Board URL: ")).trim()];
  } else if (mode === "2") {
    boards = (await ask("Board URLs (comma separated): ")).split(",").map(s => s.trim());
  } else if (mode === "3") {
    profileUrl = (await ask("Profile URL: ")).trim();
  } else {
    console.log("Invalid choice."); process.exit(1);
  }

  const browser = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 }
  });

  console.log("\nLog in if needed, then press ENTER...");
  await ask("Press ENTER when ready...");

  let rootDir = ".";

  if (mode === "3") {
    const urlObj = new URL(profileUrl.startsWith("http") ? profileUrl : "https://" + profileUrl);
    const username = urlObj.pathname.split("/").filter(Boolean)[0];
    rootDir = `./${username}`;

    boards = await getAllBoards(browser, profileUrl);
    console.log(`\nFound ${boards.length} boards (saving to ./${username}/<boardname>/):`);
    boards.forEach((b, i) => console.log(`  ${i + 1}. ${b}`));
    await ask("\nPress ENTER to start or Ctrl+C to abort...");
  } else {
    // Modes 1 & 2: extract username from the first board URL, use same folder structure as mode 3
    const username = extractUsername(boards[0]);
    if (username) {
      rootDir = `./${username}`;
      console.log(`\nSaving to ./${username}/<boardname>/`);
    } else {
      console.log("\nCould not extract username from URL, saving to current directory.");
    }
  }

  for (let i = 0; i < boards.length; i++) {
    try {
      const sections = await getBoardSections(browser, boards[i]);

      if (sections.length > 0) {
        console.log(`\n[${i + 1}/${boards.length}] Board has ${sections.length} section(s) — scraping each:`);
        sections.forEach((s, j) => console.log(`  ${j + 1}. ${s}`));

        for (let j = 0; j < sections.length; j++) {
          await scrapeBoard(browser, sections[j], `${i + 1}.${j + 1}`, boards.length, rootDir);
        }
      } else {
        await scrapeBoard(browser, boards[i], i + 1, boards.length, rootDir);
      }
    } catch (e) {
      console.log(`\n  Skipping board due to error: ${e.message}`);
    }
  }

  console.log("\nALL DONE");
  rl.close();
  try { await browser.close(); } catch {}
})();