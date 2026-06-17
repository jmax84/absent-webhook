import express from "express";
import fetch from "node-fetch";
import twilioPkg from "twilio";
import XLSX from "xlsx";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const { twiml: Twiml } = twilioPkg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "2mb" }));

const APP_VERSION = "0.2.11";
const DATA_ROOT = path.join(__dirname, "data", "JARVIS_DATA_FINAL_2026-06-XX");
const pendingRequests = new Map();

let knowledgeRecords = [];
let knowledgeLoadedAt = null;
let knowledgeLoadError = null;

const HVAC_THERMOSTAT_IMAGE = "/kb/04_HVAC_AND_BUILDING/HVAC_thermostat_locations.png";
const EYEWASH_IMAGE = "/kb/04_HVAC_AND_BUILDING/FACILITY_eye_wash_stations.png";
const FIRE_EXTINGUISHER_IMAGE = "/kb/04_HVAC_AND_BUILDING/FACILITY_fire_extinguishers.png";

const JONATHAN_AWAY_START = "Friday evening, June 26, 2026";
const JONATHAN_TRAVEL_NOTE = "Jonathan is flying to Portland, Oregon on the evening of June 26.";
const JONATHAN_RETURN = "Monday morning, July 6, 2026";
const JONATHAN_PHONE_FALLBACK = "360-953-1794";

const SENSITIVE_FIELD_PATTERNS = [/cost/i, /unit\s*price/i, /total\s*price/i, /price/i, /dollar/i, /amount/i, /margin/i, /markup/i, /account/i, /approval/i];
const SEARCH_STOPWORDS = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "can", "could", "do", "does", "for", "from", "have", "how", "i", "in", "is", "it", "me", "need", "of", "on", "or", "our", "please", "send", "the", "there", "this", "to", "we", "what", "when", "where", "who", "with", "you"]);

const COMMON_SUPPLY_WORDS = [
  "battery", "batteries", "aa battery", "aaa battery", "9v battery", "9 volt battery",
  "tape", "zip tie", "zip ties", "cable tie", "cable ties", "glove", "gloves",
  "light bulb", "bulb", "screw", "screws", "bolt", "bolts", "nut", "nuts",
  "marker", "markers", "sharpie", "shop towel", "shop towels", "wipes", "rag", "rags",
  "pen", "pens", "pencil", "pencils", "knife blade", "razor", "box cutter"
];

function normalize(text) {
  return (text || "").toString().trim();
}

function lower(text) {
  return normalize(text).toLowerCase();
}

function normalizeLoose(text) {
  return normalize(text)
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePart(text) {
  return normalize(text).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function digitsOnly(text) {
  return normalize(text).replace(/\D/g, "");
}

function isSensitiveField(fieldName) {
  return SENSITIVE_FIELD_PATTERNS.some((pattern) => pattern.test(fieldName || ""));
}

function getFileType(filePath) {
  return path.extname(filePath).toLowerCase().replace(".", "");
}

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(fullPath));
    else files.push(fullPath);
  }
  return files;
}

function relativeDataPath(filePath) {
  return path.relative(DATA_ROOT, filePath).split(path.sep).join("/");
}

function publicKbUrl(filePath) {
  return "/kb/" + encodeURI(relativeDataPath(filePath));
}

function categoryFromFile(filePath) {
  return relativeDataPath(filePath).split("/")[0] || "UNKNOWN";
}

function titleFromFile(filePath) {
  return path.basename(filePath).replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
}

function isGuidanceRecord(record) {
  const src = lower(record.sourceFile || "");
  const title = lower(record.title || "");
  const sheet = lower(record.sheetName || "");
  return sheet === "readme" || src.includes("readme") || src.includes("rules") || src.includes("notes") || src.includes("index") || src.includes("policy") || src.includes("search") || src.includes("data_last_updated") || title.includes("rules") || title.includes("notes") || title.includes("index") || title.includes("policy") || title.includes("search");
}

function extractSearchKeys(text) {
  const keys = new Set();
  const rawTokens = normalize(text).match(/[A-Za-z0-9][A-Za-z0-9._\-/]{1,}[A-Za-z0-9]/g) || [];
  for (const token of rawTokens) {
    const part = normalizePart(token);
    if (part.length >= 3 && /\d/.test(part)) keys.add(part);
    const digits = digitsOnly(token);
    if (digits.length >= 3) keys.add(digits);
  }
  return [...keys];
}

function recordSearchText(record) {
  const pieces = [record.title, record.category, record.sourceFile, record.body, record.sheetName];
  if (record.fields) {
    for (const [key, value] of Object.entries(record.fields)) {
      if (isSensitiveField(key)) continue;
      pieces.push(key, value);
    }
  }
  return pieces.filter(Boolean).join(" ");
}

function addKnowledgeRecord(record) {
  const text = recordSearchText(record);
  const searchKeys = new Set(extractSearchKeys(text));
  if (record.fields) {
    for (const [key, value] of Object.entries(record.fields)) {
      if (/(part|item|number|model|serial|quote|knife|color|pantone|pms|machine|id|formula|ink|vendor|phone|contact)/i.test(key)) {
        for (const searchKey of extractSearchKeys(value)) searchKeys.add(searchKey);
      }
    }
  }
  knowledgeRecords.push({ ...record, normalizedText: normalizeLoose(text), searchKeys: [...searchKeys] });
}

function loadMarkdownFile(filePath) {
  addKnowledgeRecord({
    type: "document",
    category: categoryFromFile(filePath),
    title: titleFromFile(filePath),
    sourceFile: relativeDataPath(filePath),
    url: publicKbUrl(filePath),
    body: fs.readFileSync(filePath, "utf8")
  });
}

function cleanCellValue(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return normalize(value);
}

function loadWorkbookFile(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  for (const sheetName of workbook.SheetNames) {
    if (/^README$/i.test(sheetName)) continue;
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "", raw: false });
    rows.forEach((row, index) => {
      const fields = {};
      for (const [key, value] of Object.entries(row)) {
        const cleanKey = normalize(key);
        const cleanValue = cleanCellValue(value);
        if (!cleanKey || cleanKey.startsWith("__EMPTY")) continue;
        fields[cleanKey] = cleanValue;
      }
      if (!Object.values(fields).some((value) => normalize(value))) return;
      addKnowledgeRecord({
        type: "spreadsheet-row",
        category: categoryFromFile(filePath),
        title: titleFromFile(filePath),
        sourceFile: relativeDataPath(filePath),
        url: publicKbUrl(filePath),
        sheetName,
        rowNumber: index + 2,
        fields
      });
    });
  }
}

function loadPdfFile(filePath) {
  addKnowledgeRecord({
    type: "file",
    category: categoryFromFile(filePath),
    title: titleFromFile(filePath),
    sourceFile: relativeDataPath(filePath),
    url: publicKbUrl(filePath),
    body: titleFromFile(filePath) + " PDF reference document."
  });
}

function loadKnowledgeBase() {
  knowledgeRecords = [];
  knowledgeLoadError = null;
  try {
    const files = walkFiles(DATA_ROOT);
    for (const filePath of files) {
      const rel = relativeDataPath(filePath);
      if (rel.startsWith("99_DO_NOT_USE_YET/")) continue;
      const ext = getFileType(filePath);
      try {
        if (["md", "txt"].includes(ext)) loadMarkdownFile(filePath);
        else if (["xlsx", "xls"].includes(ext)) loadWorkbookFile(filePath);
        else if (ext === "pdf") loadPdfFile(filePath);
      } catch (error) {
        console.error("Failed to load " + rel + ":", error);
        addKnowledgeRecord({ type: "load-error", category: categoryFromFile(filePath), title: titleFromFile(filePath), sourceFile: rel, url: publicKbUrl(filePath), body: "This file could not be loaded: " + error.message });
      }
    }
    knowledgeLoadedAt = new Date();
    console.log("JARVIS knowledge loaded: " + knowledgeRecords.length + " records from " + files.length + " files.");
  } catch (error) {
    knowledgeLoadError = error;
    console.error("JARVIS knowledge load failed:", error);
  }
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  const matrix = Array.from({ length: a.length + 1 }, () => []);
  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }
  return matrix[a.length][b.length];
}

function hasExplicitKnifeLanguage(query) {
  const q = lower(query);
  return q.includes("knife") || q.includes("knives") || q.includes("cutoff") || q.includes("cut-off") || q.includes("profile") || q.includes("side knife") || q.includes("sharpen");
}

function looksLikePartNumber(query) {
  const q = normalize(query);
  const tokens = q.match(/[A-Za-z0-9][A-Za-z0-9._\-/]{1,}[A-Za-z0-9]/g) || [];
  for (const token of tokens) {
    const normalized = normalizePart(token);
    if (normalized.length < 3) continue;
    if (/[A-Z]/.test(normalized) && /\d/.test(normalized)) return true;
    if (/[._\-/]/.test(token) && /\d/.test(normalized) && normalized.length >= 4) return true;
  }
  if (/\b\d{3,6}\s*(zz|z|rs|c3|c4|2rs|rsr|llu|llb)\b/i.test(q)) return true;
  if (/\b(k|v|p|m|a|b|c|d|db|wd|w)\s*\.?\s*\d{2,}[\d.a-z\-\/]*\b/i.test(q)) return true;
  return false;
}
function containsCommonSupplyWord(query) {
  const q = normalizeLoose(query);
  return COMMON_SUPPLY_WORDS.some((word) => {
    const w = normalizeLoose(word);
    if (!w) return false;
    return q === w || q.includes(w);
  });
}

function extractCommonSupplyName(query) {
  const q = normalizeLoose(query);

  if (/\baa\s+batter(y|ies)\b/.test(q) || /\baa\s+size\s+batter(y|ies)\b/.test(q)) return "AA batteries";
  if (/\baaa\s+batter(y|ies)\b/.test(q) || /\baaa\s+size\s+batter(y|ies)\b/.test(q)) return "AAA batteries";
  if (/\b9\s*v\s+batter(y|ies)\b/.test(q) || /\b9v\s+batter(y|ies)\b/.test(q) || /\b9\s*volt\s+batter(y|ies)\b/.test(q)) return "9V batteries";
  if (/\bbatter(y|ies)\b/.test(q)) return "batteries";
  if (/\bzip\s+ties?\b/.test(q) || /\bcable\s+ties?\b/.test(q)) return "zip ties";
  if (/\bgloves?\b/.test(q)) return "gloves";
  if (/\btape\b/.test(q)) return "tape";
  if (/\bshop\s+towels?\b/.test(q)) return "shop towels";
  if (/\bmarkers?\b/.test(q) || /\bsharpies?\b/.test(q)) return "markers";
  if (/\blight\s+bulbs?\b/.test(q) || /\bbulbs?\b/.test(q)) return "light bulbs";
  if (/\bknife\s+blades?\b/.test(q) || /\brazors?\b/.test(q)) return "knife blades";

  const cleaned = q
    .replace(/\b(i|we|they)\b/g, "")
    .replace(/\b(need|needs|needed|want|looking|for|part|supply|supplies|some|a|an|the|do|we|have|any|get|find)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || normalize(query);
}

function isVagueInkRequest(query) {
  const q = normalizeLoose(query);
  return [
    "ink",
    "i need ink",
    "need ink",
    "help with ink",
    "ink help",
    "i need help with ink",
    "can you help with ink"
  ].includes(q);
}

function hasInkLanguage(query) {
  const q = normalizeLoose(query);
  return /\b(ink|pantone|pms|color|formula|make|mix)\b/.test(q);
}

function extractInkNumber(query) {
  const raw = normalize(query);

  const patterns = [
    /\b(?:ink|pms|pantone|color|colour|formula)\s*(?:number|#|no\.?)?\s*([0-9]{1,4})(?:\s*[- ]?\s*([uc]))?\b/i,
    /\b(?:make|mix)\s+(?:me\s+)?(?:ink\s+)?(?:number\s+)?([0-9]{1,4})(?:\s*[- ]?\s*([uc]))?\b/i,
    /\b([0-9]{1,4})\s*[- ]?\s*([uc])\b/i
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match) {
      const number = match[1];
      const suffix = match[2] ? match[2].toUpperCase() : "";
      return suffix ? `${number} ${suffix}` : number;
    }
  }

  if (hasInkLanguage(raw)) {
    const simple = raw.match(/\b([0-9]{2,4})\b/);
    if (simple) return simple[1];
  }

  return "";
}

function extractBatchPounds(query) {
  const raw = normalize(query);
  const patterns = [
    /\b(\d+(?:\.\d+)?)\s*(?:lb|lbs|pound|pounds)\b/i,
    /\bmake\s+(\d+(?:\.\d+)?)\b/i
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0 && value <= 10000) return value;
    }
  }

  return null;
}

function canonicalInkParts(inkText) {
  const raw = normalize(inkText).toUpperCase();
  const match = raw.match(/\b0*([0-9]{1,4})(?:\s*[- ]?\s*([UC]))?\b/);
  if (!match) return null;
  return {
    numberRaw: (raw.match(/\b([0-9]{1,4})(?:\s*[- ]?\s*[UC])?\b/) || [null, match[1]])[1],
    numberNoLeadingZeros: match[1],
    suffix: match[2] || ""
  };
}

function canonicalInkLabel(inkText) {
  const parts = canonicalInkParts(inkText);
  if (!parts) return normalize(inkText).toUpperCase();
  return parts.suffix ? `${parts.numberNoLeadingZeros} ${parts.suffix}` : parts.numberNoLeadingZeros;
}

function exactInkLabel(inkText) {
  const raw = normalize(inkText).toUpperCase();
  const match = raw.match(/\b([0-9]{1,4})(?:\s*[- ]?\s*([UC]))?\b/);
  if (!match) return raw;
  return match[2] ? `${match[1]} ${match[2]}` : match[1];
}

function inkNumberHasLeadingZero(inkText) {
  const raw = normalize(inkText);
  const match = raw.match(/\b(0+[0-9]{1,4})(?:\s*[- ]?\s*[uc])?\b/i);
  return !!match;
}

function stripLeadingZerosInk(inkText) {
  const raw = normalize(inkText).toUpperCase();
  const match = raw.match(/\b(0*[0-9]{1,4})(?:\s*[- ]?\s*([UC]))?\b/);
  if (!match) return raw;
  const num = String(Number(match[1]));
  return match[2] ? `${num} ${match[2]}` : num;
}

function colorValueMatchesExactInk(value, requestedInk) {
  const requested = exactInkLabel(requestedInk);
  const requestedParts = requested.match(/^([0-9]{1,4})(?:\s+([UC]))?$/);
  if (!requestedParts) return false;

  const reqNum = requestedParts[1];
  const reqSuffix = requestedParts[2] || "";

  const text = normalize(value).toUpperCase();

  const colorMatches = [...text.matchAll(/\b(?:PMS|PANTONE|INK|COLOR|COLOUR)?\s*0*([0-9]{1,4})(?:\s*[- ]?\s*([UC]))?\b/g)];

  for (const match of colorMatches) {
    const foundFull = match[0].trim();
    const foundNumRaw = match[1];
    const foundSuffix = match[2] || "";

    const rawNumberFromText = (foundFull.match(/\b([0-9]{1,4})(?:\s*[- ]?\s*[UC])?\b/) || [null, foundNumRaw])[1];

    if (rawNumberFromText !== reqNum) continue;
    if (reqSuffix && foundSuffix && foundSuffix !== reqSuffix) continue;
    if (reqSuffix && !foundSuffix) continue;
    return true;
  }

  return false;
}

function colorValueMatchesCanonicalInk(value, requestedInk) {
  const requested = canonicalInkParts(requestedInk);
  if (!requested) return false;

  const text = normalize(value).toUpperCase();
  const matches = [...text.matchAll(/\b(?:PMS|PANTONE|INK|COLOR|COLOUR)?\s*0*([0-9]{1,4})(?:\s*[- ]?\s*([UC]))?\b/g)];

  for (const match of matches) {
    const foundNum = String(Number(match[1]));
    const foundSuffix = match[2] || "";
    if (foundNum !== requested.numberNoLeadingZeros) continue;
    if (requested.suffix && foundSuffix && foundSuffix !== requested.suffix) continue;
    if (requested.suffix && !foundSuffix) continue;
    return true;
  }

  return false;
}

function getFieldValue(record, patterns) {
  if (!record.fields) return "";
  for (const [key, value] of Object.entries(record.fields)) {
    if (patterns.some((pattern) => pattern.test(key))) return normalize(value);
  }
  return "";
}

function getAllFieldText(record, includeSensitive = false) {
  if (!record.fields) return "";
  return Object.entries(record.fields)
    .filter(([key]) => includeSensitive || !isSensitiveField(key))
    .map(([key, value]) => `${key}: ${value}`)
    .join(" | ");
}

function getRecordDescription(record) {
  return getFieldValue(record, [/description/i, /item/i, /part\s*name/i, /name/i, /material/i, /component/i]) || record.title || "";
}

function getRecordPartNumber(record) {
  return getFieldValue(record, [/part\s*(number|#|no)/i, /^part$/i, /item\s*(number|#|no)/i, /^item$/i, /stock/i, /sku/i, /mfg/i, /model/i]) || "";
}

function getRecordLocation(record) {
  return getFieldValue(record, [/location/i, /bin/i, /shelf/i, /cabinet/i, /drawer/i, /area/i]);
}

function getRecordQuantity(record) {
  return getFieldValue(record, [/qty/i, /quantity/i, /on\s*hand/i, /count/i]);
}

function getInkColorText(record) {
  if (!record.fields) return "";
  const fields = [];
  for (const [key, value] of Object.entries(record.fields)) {
    if (/(pantone|pms|color|colour|ink|formula)/i.test(key)) fields.push(value);
  }
  return fields.join(" | ");
}

function isInkRecord(record) {
  return record.category === "03_INK_ROOM" || /ink/i.test(record.sourceFile || "") || /ink/i.test(record.title || "") || /pantone|pms|formula|color/i.test(getAllFieldText(record));
}

function isFormulaRecord(record) {
  if (!isInkRecord(record)) return false;
  const text = getAllFieldText(record, true) + " " + recordSearchText(record);
  return /(formula|percent|component|blue|red|yellow|black|extender|varnish|violet|rubine|warm|process|eclipse)/i.test(text);
}

function isInventoryRecord(record) {
  if (!isInkRecord(record)) return false;
  const text = getAllFieldText(record, true) + " " + record.sourceFile;
  return /(inventory|count|on\s*hand|container|containers|lb|lbs|pounds|quantity|qty)/i.test(text);
}

function findExactInkFormulaRecords(inkNumber) {
  return knowledgeRecords.filter((record) => {
    if (!isFormulaRecord(record)) return false;
    return colorValueMatchesExactInk(getInkColorText(record) + " | " + getAllFieldText(record), inkNumber);
  });
}

function findCanonicalInkFormulaRecords(inkNumber) {
  return knowledgeRecords.filter((record) => {
    if (!isFormulaRecord(record)) return false;
    return colorValueMatchesCanonicalInk(getInkColorText(record) + " | " + getAllFieldText(record), inkNumber);
  });
}

function findExactInkInventoryRecords(inkNumber) {
  return knowledgeRecords.filter((record) => {
    if (!isInventoryRecord(record)) return false;
    return colorValueMatchesExactInk(getInkColorText(record) + " | " + getAllFieldText(record), inkNumber);
  });
}

function findCanonicalInkInventoryRecords(inkNumber) {
  return knowledgeRecords.filter((record) => {
    if (!isInventoryRecord(record)) return false;
    return colorValueMatchesCanonicalInk(getInkColorText(record) + " | " + getAllFieldText(record), inkNumber);
  });
}

function findNearbyInkRecords(inkNumber) {
  const requestedParts = canonicalInkParts(inkNumber);
  if (!requestedParts) return [];

  const candidates = [];
  for (const record of knowledgeRecords) {
    if (!isInkRecord(record)) continue;
    const text = getInkColorText(record) + " | " + getAllFieldText(record);
    const matches = [...normalize(text).toUpperCase().matchAll(/\b(?:PMS|PANTONE|INK|COLOR|COLOUR)?\s*([0-9]{1,4})(?:\s*[- ]?\s*([UC]))?\b/g)];
    for (const match of matches) {
      const candidateNum = match[1];
      const candidateSuffix = match[2] || "";
      if (candidateNum === requestedParts.numberRaw) continue;
      const distance = levenshtein(requestedParts.numberNoLeadingZeros, String(Number(candidateNum)));
      const contains = candidateNum.includes(requestedParts.numberNoLeadingZeros) || requestedParts.numberNoLeadingZeros.includes(candidateNum);
      if (distance <= 1 || contains) {
        candidates.push({
          record,
          label: candidateSuffix ? `${candidateNum} ${candidateSuffix}` : candidateNum,
          distance: contains ? 2 : distance
        });
      }
    }
  }

  const seen = new Set();
  return candidates
    .sort((a, b) => a.distance - b.distance)
    .filter((item) => {
      const key = item.label + "|" + item.record.sourceFile + "|" + item.record.rowNumber;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 3);
}

function parsePercentNumber(value) {
  if (value === null || value === undefined) return null;
  const text = normalize(value).replace("%", "");
  const num = Number(text);
  return Number.isFinite(num) ? num : null;
}

function extractFormulaComponents(record) {
  if (!record.fields) return [];

  const components = [];

  for (const [key, value] of Object.entries(record.fields)) {
    const k = normalize(key);
    const v = normalize(value);
    if (!v) continue;

    if (/component/i.test(k) && /percent/i.test(k)) continue;

    const directPercent = parsePercentNumber(v);
    if (/(blue|red|yellow|black|extender|varnish|violet|rubine|warm|process|eclipse|methyl|orange|green|opaque|white)/i.test(k) && directPercent !== null && directPercent > 0 && directPercent <= 100) {
      components.push({ name: k, percent: directPercent });
    }
  }

  if (components.length) return components;

  const text = getAllFieldText(record, true) + " | " + (record.body || "");
  const pattern = /([A-Za-z0-9 :.\-\/]+?)\s*[:=]\s*(\d+(?:\.\d+)?)\s*%/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const name = normalize(match[1]).replace(/.*\|\s*/, "").trim();
    const percent = Number(match[2]);
    if (name && Number.isFinite(percent) && percent > 0 && percent <= 100) {
      components.push({ name, percent });
    }
  }

  return components;
}

function formatFormula(record, inkNumber, batchPounds) {
  const components = extractFormulaComponents(record);
  const label = exactInkLabel(inkNumber);
  const title = getFieldValue(record, [/pantone/i, /pms/i, /color/i, /colour/i, /ink/i]) || label;

  if (!components.length) {
    return [
      `${title}`,
      "",
      "I found a formula record, but I could not safely parse the component percentages.",
      "",
      "Use the ink mixer system or flag this for Jonathan before mixing."
    ].join("\n");
  }

  const totalPercent = components.reduce((sum, component) => sum + component.percent, 0);
  const lines = [];
  lines.push(`${title} — ${batchPounds.toFixed(2)} lb batch`);
  lines.push("");

  let total = 0;
  for (const component of components) {
    const pounds = batchPounds * (component.percent / 100);
    total += pounds;
    lines.push(`${component.name} = ${pounds.toFixed(2)} lb`);
  }

  lines.push("");
  lines.push(`Total = ${total.toFixed(2)} lb`);

  if (Math.abs(totalPercent - 100) > 0.5) {
    lines.push("");
    lines.push(`Note: Formula percentages total ${totalPercent.toFixed(3)}%. Verify before mixing.`);
  }

  lines.push("");
  lines.push("Flexo note: This is a starting mix. Extender may be needed once the job is on press. That is normal.");

  return lines.join("\n");
}

function formatInkInventory(records, inkNumber) {
  if (!records.length) return "";

  let total = 0;
  let containers = 0;
  let lastCounted = "";
  const detailLines = [];

  for (const record of records) {
    const qty = getFieldValue(record, [/total/i, /weight/i, /lb/i, /lbs/i, /pounds/i, /quantity/i, /qty/i, /on\s*hand/i]);
    const numeric = Number(String(qty).replace(/[^\d.]/g, ""));
    if (Number.isFinite(numeric)) total += numeric;

    const cont = getFieldValue(record, [/container/i, /bucket/i, /count/i]);
    const contNum = Number(String(cont).replace(/[^\d.]/g, ""));
    if (Number.isFinite(contNum)) containers += contNum;

    const counted = getFieldValue(record, [/last\s*count/i, /counted/i, /date/i]);
    if (counted && (!lastCounted || counted > lastCounted)) lastCounted = counted;

    const desc = getAllFieldText(record);
    if (desc) detailLines.push(desc);
  }

  const label = exactInkLabel(inkNumber);
  const lines = [`Yes — ink ${label} is listed on hand.`, ""];

  if (total > 0) lines.push(`Total: ${total.toFixed(2)} lb`);
  if (containers > 0) lines.push(`Containers: ${containers}`);
  if (lastCounted) lines.push(`Last counted: ${lastCounted}`);

  if (lines.length === 2 && detailLines.length) {
    lines.push(detailLines[0]);
  }

  lines.push("");
  lines.push("Please physically verify before relying on it for production.");

  return lines.join("\n");
}

function summarizeRecord(record) {
  if (record.fields) {
    const part = getRecordPartNumber(record);
    const desc = getRecordDescription(record);
    const loc = getRecordLocation(record);
    const qty = getRecordQuantity(record);

    const lines = [];
    if (part || desc) lines.push(`I found ${part || "a matching item"}${desc ? " — " + desc : ""}.`);
    if (loc) lines.push(`Location: ${loc}`);
    if (qty) lines.push(`Quantity: ${qty}`);
    if (!lines.length) lines.push(getAllFieldText(record));
    return lines.join("\n");
  }

  return normalize(record.body || record.title || "I found a matching record.").slice(0, 900);
}

function scoreRecordForQuery(record, query) {
  const q = normalizeLoose(query);
  const tokens = q.split(" ").filter((token) => token.length > 1 && !SEARCH_STOPWORDS.has(token));
  const text = record.normalizedText || normalizeLoose(recordSearchText(record));
  let score = 0;

  for (const token of tokens) {
    if (text.includes(token)) score += token.length >= 4 ? 3 : 1;
  }

  const keys = extractSearchKeys(query);
  for (const key of keys) {
    if (record.searchKeys?.includes(key)) score += 15;
    else if (normalizePart(text).includes(key)) score += 5;
  }

  if (record.category === "01_PARTS_INVENTORY") score += 1;
  if (record.category === "03_INK_ROOM" && hasInkLanguage(query)) score += 4;
  if (record.category === "04_HVAC_AND_BUILDING" && /\b(hvac|thermostat|ac|air|heat|cool|cooling)\b/i.test(query)) score += 5;
  if (record.category === "09_MAPS" && /\b(map|where|location|eyewash|extinguisher|thermostat)\b/i.test(query)) score += 4;

  return score;
}

function searchKnowledge(query, options = {}) {
  const scored = [];
  for (const record of knowledgeRecords) {
    if (options.category && record.category !== options.category) continue;
    if (options.predicate && !options.predicate(record)) continue;
    const score = scoreRecordForQuery(record, query);
    if (score > 0) scored.push({ record, score });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, options.limit || 8);
}

function findExactPartMatches(query) {
  const queryKeys = extractSearchKeys(query);
  if (!queryKeys.length) return [];

  return knowledgeRecords.filter((record) => {
    if (record.category !== "01_PARTS_INVENTORY" && !/part|inventory/i.test(record.sourceFile || "")) return false;
    const recordPart = normalizePart(getRecordPartNumber(record));
    const recordTextPartKeys = record.searchKeys || [];
    return queryKeys.some((key) => recordPart === key || recordTextPartKeys.includes(key));
  });
}

function findNormalizedPartMatches(query) {
  const queryKeys = extractSearchKeys(query);
  if (!queryKeys.length) return [];

  return knowledgeRecords.filter((record) => {
    if (record.category !== "01_PARTS_INVENTORY" && !/part|inventory/i.test(record.sourceFile || "")) return false;
    const recordPart = normalizePart(getRecordPartNumber(record));
    if (!recordPart) return false;
    return queryKeys.some((key) => recordPart === key);
  });
}

function findFuzzyPartMatches(query) {
  const queryKeys = extractSearchKeys(query).filter((key) => key.length >= 4);
  if (!queryKeys.length) return [];

  const candidates = [];

  for (const record of knowledgeRecords) {
    if (record.category !== "01_PARTS_INVENTORY" && !/part|inventory/i.test(record.sourceFile || "")) continue;

    const part = normalizePart(getRecordPartNumber(record));
    if (!part || part.length < 4) continue;

    for (const key of queryKeys) {
      const distance = levenshtein(key, part);
      const maxAllowed = key.length <= 5 ? 1 : 2;
      const containsPenalty = part.includes(key) || key.includes(part) ? 1 : 999;
      const best = Math.min(distance, containsPenalty);

      if (best <= maxAllowed) {
        candidates.push({ record, score: best, requested: key, found: part });
      }
    }
  }

  const seen = new Set();
  return candidates
    .sort((a, b) => a.score - b.score)
    .filter((item) => {
      const key = getRecordPartNumber(item.record) + "|" + item.record.sourceFile + "|" + item.record.rowNumber;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 3);
}

function findCommonSupplyMatches(query) {
  const supplyName = extractCommonSupplyName(query);
  const q = normalizeLoose(supplyName);
  const qTokens = q.split(" ").filter(Boolean);

  const matches = [];

  for (const record of knowledgeRecords) {
    if (record.category !== "01_PARTS_INVENTORY" && !/part|inventory|supply/i.test(record.sourceFile || "")) continue;

    const desc = normalizeLoose(getRecordDescription(record));
    const full = normalizeLoose(getRecordDescription(record) + " " + getAllFieldText(record));
    const part = normalizePart(getRecordPartNumber(record));

    let score = 0;

    if (desc.includes(q)) score += 20;
    else if (full.includes(q)) score += 12;

    for (const token of qTokens) {
      if (token.length <= 1) continue;
      if (desc.includes(token)) score += 5;
      else if (full.includes(token)) score += 2;
    }

    if (/\baa\b/.test(q) && /\b(aa|double a)\b/.test(full) && /batter/.test(full)) score += 20;
    if (/\baaa\b/.test(q) && /\b(aaa|triple a)\b/.test(full) && /batter/.test(full)) score += 20;
    if (/9v|9 volt/.test(q) && /9\s*v|9\s*volt/.test(full) && /batter/.test(full)) score += 20;

    // Important guardrail:
    // For common supplies, do NOT count random part-number matches as evidence.
    if (score > 0 && part && qTokens.some((token) => token.length <= 3 && part.includes(token.toUpperCase()))) {
      score -= 0;
    }

    if (score > 8) matches.push({ record, score });
  }

  return matches.sort((a, b) => b.score - a.score).slice(0, 5);
}

function wantsToAddToPO(query) {
  const q = normalizeLoose(query);
  return q.includes("add to po") || q.includes("add original item") || q.includes("add it") || q.includes("order it") || q.includes("request it") || q.includes("purchase request") || q.includes("po request");
}

function isAffirmative(query) {
  const q = normalizeLoose(query);
  return ["yes", "y", "yeah", "yep", "correct", "that is it", "thats it", "this is it", "yes this is it", "use that", "yes use that"].includes(q);
}

function isNegative(query) {
  const q = normalizeLoose(query);
  return ["no", "n", "nope", "not this", "not it", "wrong", "no not this item", "i meant something else"].includes(q);
}

function getUserKey(req) {
  return req.body?.From || req.ip || "web-user";
}

function makeButton(label, value) {
  return `[button:${value}|${label}]`;
}

function withButtons(text, buttons) {
  return `${text}\n\n${buttons.join("\n")}`;
}

function parseButtonMessage(message) {
  const text = normalize(message);
  const match = text.match(/^\[button:([^|\]]+)\|([^\]]+)\]$/);
  if (match) return match[1];
  return text;
}
const REQUEST_WEBHOOK_URL =
  process.env.REQUEST_WEBHOOK_URL ||
  process.env.PO_REQUEST_WEBHOOK_URL ||
  process.env.GOOGLE_APPS_SCRIPT_URL ||
  process.env.SHEET_WEBHOOK_URL ||
  "";

async function postToRequestSheet(payload) {
  const finalPayload = {
    timestamp: new Date().toISOString(),
    source: "JARVIS",
    appVersion: APP_VERSION,
    ...payload
  };

  if (!REQUEST_WEBHOOK_URL) {
    console.warn("No request webhook configured. Would have posted:", finalPayload);
    return { ok: false, reason: "REQUEST_WEBHOOK_URL not configured", payload: finalPayload };
  }

  try {
    const response = await fetch(REQUEST_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(finalPayload)
    });

    const text = await response.text();

    if (!response.ok) {
      console.error("Request webhook failed:", response.status, text);
      return { ok: false, reason: `Webhook returned ${response.status}`, body: text, payload: finalPayload };
    }

    return { ok: true, body: text, payload: finalPayload };
  } catch (error) {
    console.error("Request webhook error:", error);
    return { ok: false, reason: error.message, payload: finalPayload };
  }
}

function classifyUrgency(query) {
  const q = normalizeLoose(query);
  if (/\b(urgent|asap|right now|immediately|down|stopped|cannot run|cant run|can't run|line down|machine down|production stopped|emergency|unsafe|injury|spill|fire|smoke)\b/.test(q)) {
    return "URGENT";
  }
  return "NORMAL";
}

function shouldEscalateUrgent(query) {
  return classifyUrgency(query) === "URGENT";
}

async function createEscalation(issue, details = {}) {
  const priority = details.priority || classifyUrgency(issue);

  return await postToRequestSheet({
    requestType: "JARVIS ESCALATION",
    priority,
    status: "Needs Jonathan review",
    item: details.item || "",
    issue,
    requester: details.requester || "JARVIS user",
    machineOrArea: details.machineOrArea || "",
    dueDate: details.dueDate || "",
    notes: details.notes || "JARVIS could not solve this confidently. Escalate to Jonathan only."
  });
}

async function createPORequest(item, details = {}) {
  return await postToRequestSheet({
    requestType: "PO REQUEST",
    priority: details.priority || classifyUrgency(item),
    status: "Needs Jonathan review",
    item,
    issue: details.issue || `User requested: ${item}`,
    requester: details.requester || "JARVIS user",
    machineOrArea: details.machineOrArea || "",
    dueDate: details.dueDate || "",
    notes: details.notes || "This does not mean the item has been ordered or approved. Jonathan must review."
  });
}

function escalationConfirmationText(issue, result) {
  if (result.ok) {
    return [
      "I flagged this for Jonathan to review.",
      "",
      "This does not mean anything has been ordered or approved yet. Jonathan will review it."
    ].join("\n");
  }

  return [
    "I tried to flag this for Jonathan, but I could not confirm that the request was written to the spreadsheet.",
    "",
    "Please try again or specifically ask for Jonathan’s number if this is urgent.",
    "",
    `Issue: ${issue}`
  ].join("\n");
}

function shouldGiveJonathanPhone(query) {
  const q = normalizeLoose(query);
  return (
    /\b(what is|whats|what's|give me|need|show me|tell me)\b.*\bjonathan\b.*\b(number|phone|cell|contact)\b/.test(q) ||
    /\bjonathan\b.*\b(number|phone|cell)\b/.test(q) ||
    /\b(call|text)\s+jonathan\b/.test(q) ||
    /\bhow do i reach jonathan\b/.test(q)
  );
}

function isJonathanEscalationIntent(query) {
  const q = normalizeLoose(query);
  return (
    /\b(ask|contact|get|tell|notify|flag|escalate|send|message)\s+jonathan\b/.test(q) ||
    /\bjonathan\s+(help|review|needs to know)\b/.test(q) ||
    /\bneed\s+jonathan\b/.test(q) ||
    /\bask jonathan for help\b/.test(q)
  );
}

function answerJonathanStatus(query) {
  const q = normalizeLoose(query);

  if (shouldGiveJonathanPhone(query)) {
    return `Jonathan can be reached by call or text at ${JONATHAN_PHONE_FALLBACK}.`;
  }

  if (/\b(vacation|away|gone|out|back|return|coming back|where is jonathan|when is jonathan)\b/.test(q)) {
    return [
      `Jonathan is leaving ${JONATHAN_AWAY_START}.`,
      JONATHAN_TRAVEL_NOTE,
      `Jonathan is expected back ${JONATHAN_RETURN}.`,
      "",
      "Use JARVIS first. If JARVIS cannot solve the issue, it will flag the issue for Jonathan to review."
    ].join("\n");
  }

  return "";
}

function isActiveEmergency(query) {
  const q = normalizeLoose(query);
  return /\b(fire|smoke|injury|bleeding|chemical exposure|chemical in eye|eyes|burn|explosion|active leak|gas smell|evacuate|emergency)\b/.test(q);
}

function answerActiveEmergency(query) {
  if (!isActiveEmergency(query)) return "";

  return [
    "This sounds like an immediate safety issue.",
    "",
    "Follow site emergency procedures now.",
    "",
    "After the immediate situation is controlled, JARVIS can flag the issue for Jonathan."
  ].join("\n");
}

function answerVagueInkRequest() {
  return withButtons(
    [
      "What ink help do you need?",
      "",
      "You can ask like:",
      "- Do we have ink 186?",
      "- Make 10 lb of ink 186",
      "- Formula for Pantone 2935 U",
      "- Who do I call at INX?",
      "- Who do I call for waste ink pickup?"
    ].join("\n"),
    [
      makeButton("Check ink inventory", "check ink inventory"),
      makeButton("Make ink formula", "make ink formula"),
      makeButton("INX contact", "inx contact"),
      makeButton("Waste ink pickup", "waste ink pickup")
    ]
  );
}

function answerWasteInkPickup(query) {
  const q = normalizeLoose(query);
  if (!/\b(waste ink|potomac|pickup|pick up|picked up|tote|totes|disposal)\b/.test(q)) return "";

  if (q.includes("potomac") || q.includes("waste ink") || /\bpick\s*up\b/.test(q) || q.includes("pickup") || q.includes("tote")) {
    return [
      "Call Potomac Environmental for waste ink pickup.",
      "",
      "Contact: Benjamin Kirby",
      "Phone: 804-812-5161",
      "Email: bkirby@potomacenv.com",
      "",
      "We usually call when 6 or more waste ink totes are ready. Pickup is not automatic.",
      "",
      "Before calling, count how many waste ink totes are ready. If storage is becoming a problem, JARVIS can flag it for Jonathan."
    ].join("\n");
  }

  return "";
}

function answerVendorContact(query) {
  const q = normalizeLoose(query);

  if (/\b(crystal clean|heritage crystal|heritage-crystal|parts washer|rich hine|hinegardner|richard)\b/.test(q)) {
    return [
      "Crystal Clean / Heritage-Crystal Clean contact:",
      "",
      'Richard "Rich" Hinegardner',
      "Phone: 847-836-5670",
      "Cell: 804-400-6876",
      "",
      "Text is okay for non-emergencies.",
      "Emergency number: 800-424-9300"
    ].join("\n");
  }

  if (/\b(inx|ink vendor|premade ink|pre made ink|pre-made ink)\b/.test(q)) {
    const results = searchKnowledge("INX ink vendor premade contact", {
      category: "03_INK_ROOM",
      limit: 4,
      predicate: (record) => /vendor|contact|inx|premade/i.test(recordSearchText(record))
    });

    if (results.length) {
      const best = results[0].record;
      return [
        "Here is the INX / ink vendor information I found:",
        "",
        summarizeRecord(best),
        "",
        "If this does not answer the question, JARVIS can flag it for Jonathan."
      ].join("\n");
    }
  }

  return "";
}

function answerCopperWastewater(query) {
  const q = normalizeLoose(query);
  if (!/\b(copper|henrico|wastewater|wash up|wash-up|discharge|water test|copper test)\b/.test(q)) return "";

  const copperRecords = searchKnowledge("Henrico copper wastewater wash-up discharge 24 48 72 test", {
    category: "03_INK_ROOM",
    limit: 3,
    predicate: (record) => /copper|henrico|wastewater|discharge|wash/i.test(recordSearchText(record))
  });

  if (copperRecords.length) {
    const excerpt = summarizeRecord(copperRecords[0].record);
    return [
      excerpt,
      "",
      "Important: this is an active testing/remediation project. Do not treat it as final approval to discharge water.",
      "",
      "If this is urgent or about what to do with wastewater right now, JARVIS will flag it for Jonathan."
    ].join("\n");
  }

  return [
    "Henrico County warned that the wash-up discharge water contains too much copper.",
    "",
    "Jonathan is testing whether copper stays bound to ink solids and settles to the bottom. The current test uses a 5-gallon bucket and a large wash-up tote, with copper tests on the top 50% of the water column after 24, 48, and 72 hours.",
    "",
    "If settling alone is not enough, the next steps are another gravity-fed stage and then active filtration if needed.",
    "",
    "Final results need lab confirmation before anything is submitted to Henrico County.",
    "",
    "JARVIS should flag urgent wastewater questions for Jonathan."
  ].join("\n");
}

function answerMapQuestion(query) {
  const q = normalizeLoose(query);

  if (/\b(thermostat|thermostats)\b/.test(q)) {
    return [
      "Here is the thermostat location map:",
      "",
      `[image:${HVAC_THERMOSTAT_IMAGE}]`,
      "",
      "If this does not answer the question, JARVIS can flag it for Jonathan."
    ].join("\n");
  }

  if (/\b(eyewash|eye wash|eye station|eye stations)\b/.test(q)) {
    return [
      "Here is the eyewash station map:",
      "",
      `[image:${EYEWASH_IMAGE}]`,
      "",
      "If this does not answer the question, JARVIS can flag it for Jonathan."
    ].join("\n");
  }

  if (/\b(fire extinguisher|extinguisher|extinguishers)\b/.test(q)) {
    return [
      "Here is the fire extinguisher map:",
      "",
      `[image:${FIRE_EXTINGUISHER_IMAGE}]`,
      "",
      "If this does not answer the question, JARVIS can flag it for Jonathan."
    ].join("\n");
  }

  return "";
}

function answerHvacQuestion(query) {
  const q = normalizeLoose(query);
  if (!/\b(hvac|thermostat|ac|a c|air conditioning|cooling|hot|heat|james river|rtu|unit|units)\b/.test(q)) return "";

  if (q.includes("thermostat")) return answerMapQuestion(query);

  const logRecords = searchKnowledge("HVAC service log James River 5 of 6 AC units down envelope department", {
    category: "04_HVAC_AND_BUILDING",
    limit: 3,
    predicate: (record) => /hvac|service|james river|ac|cooling|unit/i.test(recordSearchText(record))
  });

  if (logRecords.length) {
    return [
      summarizeRecord(logRecords[0].record),
      "",
      "If this is urgent, unsafe, or production-impacting, JARVIS can flag it for Jonathan."
    ].join("\n");
  }

  return [
    "Current HVAC note:",
    "",
    "5 of the 6 main AC units over the envelope department are currently down. James River HVAC is scheduled to come out Monday, June 15, 2026 to diagnose and repair them.",
    "",
    "If this is urgent, unsafe, or production-impacting, JARVIS can flag it for Jonathan."
  ].join("\n");
}

function answerKnifeQuestion(query) {
  if (!hasExplicitKnifeLanguage(query)) return "";

  const results = searchKnowledge(query, {
    category: "05_KNIVES",
    limit: 5
  });

  if (!results.length) return "";

  return [
    "Here is what I found in the knife records:",
    "",
    ...results.slice(0, 3).map((result) => summarizeRecord(result.record)),
    "",
    "Please physically verify before relying on it for production."
  ].join("\n\n");
}

function answerMagnaQuestion(query) {
  const q = normalizeLoose(query);
  if (!/\b(magna|motor|drive|rebuild|rebuilt|resurfacing|repair)\b/.test(q)) return "";

  const results = searchKnowledge(query, {
    category: "07_MAGNA_REBUILDS",
    limit: 5
  });

  if (!results.length) return "";

  return [
    "Here is what I found in the Magna rebuild records:",
    "",
    ...results.slice(0, 3).map((result) => summarizeRecord(result.record)),
    "",
    "If this does not answer the question, JARVIS can flag it for Jonathan."
  ].join("\n\n");
}

function answerScheduleQuestion(query) {
  const q = normalizeLoose(query);
  if (!/\b(2 2 3|223|schedule|shift|sunday|saturday|calendar|pierre|joe|jerry)\b/.test(q)) return "";

  const results = searchKnowledge(query, {
    category: "11_2-2-3_Schedule",
    limit: 5
  });

  if (!results.length) return "";

  return [
    "Here is what I found in the schedule notes:",
    "",
    ...results.slice(0, 3).map((result) => summarizeRecord(result.record)),
    "",
    "If this does not answer the question, JARVIS can flag it for Jonathan."
  ].join("\n\n");
}

function answerAniloxQuestion(query) {
  const q = normalizeLoose(query);
  if (!/\b(anilox|roller|rollers|volume|lpi|lines per inch|resurface|resurfacing)\b/.test(q)) return "";

  const results = searchKnowledge(query, {
    category: "03_INK_ROOM",
    limit: 5,
    predicate: (record) => /anilox|roller|volume|lpi|lines per inch|resurface/i.test(recordSearchText(record))
  });

  if (!results.length) {
    return [
      "I do not have the Anilox roller spreadsheet loaded yet.",
      "",
      "JARVIS needs the Anilox roller list before it can answer roller ID, volume, lines-per-inch, or resurfacing status questions.",
      "",
      "I flagged this as a reminder for Jonathan."
    ].join("\n");
  }

  return [
    "Here is what I found in the Anilox roller records:",
    "",
    ...results.slice(0, 4).map((result) => summarizeRecord(result.record)),
    "",
    "Please physically verify before relying on it for production."
  ].join("\n\n");
}

function answerPartsOrSupplyQuestion(query, userKey) {
  const q = normalizeLoose(query);

  const partSupplyLanguage = /\b(part|parts|bearing|belt|sensor|switch|relay|motor|gear|chain|sprocket|valve|cylinder|hose|filter|supply|supplies|need|have|stock|inventory|where is|where are)\b/.test(q);
  const commonSupply = containsCommonSupplyWord(query);

  if (!partSupplyLanguage && !looksLikePartNumber(query) && !commonSupply) return "";

  if (commonSupply) {
    const supplyName = extractCommonSupplyName(query);
    const matches = findCommonSupplyMatches(query);

    if (matches.length) {
      const best = matches[0].record;
      return [
        `${supplyName} may be listed in inventory:`,
        "",
        summarizeRecord(best),
        "",
        "Please physically verify before relying on it."
      ].join("\n");
    }

    pendingRequests.set(userKey, {
      step: "confirm_add_supply_to_po",
      item: supplyName,
      originalQuery: query
    });

    return withButtons(
      [
        `I could not find ${supplyName} in the current parts/supplies inventory.`,
        "",
        `Would you like me to add ${supplyName} to Jonathan’s Purchase Order Request list?`
      ].join("\n"),
      [
        makeButton("Add to PO request", "add to po"),
        makeButton("Cancel", "cancel")
      ]
    );
  }

  if (looksLikePartNumber(query)) {
    const exact = findExactPartMatches(query);
    if (exact.length) {
      return [
        "I found an exact or normalized part match:",
        "",
        summarizeRecord(exact[0]),
        "",
        "Please physically verify before relying on it."
      ].join("\n");
    }

    const normalized = findNormalizedPartMatches(query);
    if (normalized.length) {
      return [
        "I found a normalized part match:",
        "",
        summarizeRecord(normalized[0]),
        "",
        "Please physically verify before relying on it."
      ].join("\n");
    }

    const fuzzy = findFuzzyPartMatches(query);
    if (fuzzy.length) {
      const item = fuzzy[0];
      pendingRequests.set(userKey, {
        step: "confirm_fuzzy_part",
        originalQuery: query,
        suggestedRecord: item.record,
        requested: item.requested,
        found: item.found
      });

      return withButtons(
        [
          "I did not find an exact match for that part.",
          "",
          "I found one possible close match, but I am not confident it is the same item:",
          "",
          summarizeRecord(item.record),
          "",
          "Please physically verify before relying on it.",
          "",
          "Is this the item you meant?"
        ].join("\n"),
        [
          makeButton("Yes, this is it", "yes fuzzy part"),
          makeButton("No, not this item", "no fuzzy part"),
          makeButton("Add original item to PO request", "add original item to po")
        ]
      );
    }
  }

  const results = searchKnowledge(query, {
    category: "01_PARTS_INVENTORY",
    limit: 6
  });

  const strong = results.filter((result) => result.score >= 8);

  if (strong.length) {
    return [
      "Here is the closest parts/supplies information I found:",
      "",
      ...strong.slice(0, 3).map((result) => summarizeRecord(result.record)),
      "",
      "Please physically verify before relying on it."
    ].join("\n\n");
  }

  pendingRequests.set(userKey, {
    step: "confirm_add_part_to_po",
    item: query,
    originalQuery: query
  });

  return withButtons(
    [
      "I could not find that in the current parts/supplies inventory.",
      "",
      "Would you like me to add the original request to Jonathan’s Purchase Order Request list?"
    ].join("\n"),
    [
      makeButton("Add to PO request", "add to po"),
      makeButton("Cancel", "cancel")
    ]
  );
}

function makeInkClarificationPrompt(originalInk, alternateInk, batchPounds, reason = "leading-zero") {
  const originalLabel = exactInkLabel(originalInk);
  const alternateLabel = exactInkLabel(alternateInk);

  const pending = {
    step: "clarify_ink_number",
    originalInk: originalLabel,
    alternateInk: alternateLabel,
    batchPounds,
    reason
  };

  const text =
    reason === "both-exist"
      ? [
          `I found records for both ink ${originalLabel} and ink ${alternateLabel}.`,
          "",
          "Which one do you mean?"
        ].join("\n")
      : [
          `I did not find a formula for ink ${originalLabel}, but I found a possible match for ink ${alternateLabel}.`,
          "",
          `Ink ${originalLabel} and ink ${alternateLabel} may not be the same color.`,
          "",
          "Which one do you mean?"
        ].join("\n");

  return { pending, text };
}

function answerInkQuestion(query, userKey, forcedInkNumber = "", forcedBatchPounds = null) {
  if (isVagueInkRequest(query)) {
    return answerVagueInkRequest();
  }

  const q = normalizeLoose(query);
  if (!hasInkLanguage(query) && !forcedInkNumber) return "";

  const inkNumber = forcedInkNumber || extractInkNumber(query);

  if (!inkNumber) {
    if (/\b(make ink formula|make formula|mix ink|check ink inventory|ink inventory)\b/.test(q)) {
      return "What ink number or Pantone color do you need?";
    }
    return "";
  }

  const batchPounds = forcedBatchPounds || extractBatchPounds(query);

  const wantsFormula =
    forcedBatchPounds ||
    /\b(make|mix|formula|batch|pounds|lbs|lb)\b/.test(q);

  const exactFormula = findExactInkFormulaRecords(inkNumber);
  const exactInventory = findExactInkInventoryRecords(inkNumber);

  let alternateInk = "";
  let alternateFormula = [];
  let alternateInventory = [];

  if (inkNumberHasLeadingZero(inkNumber)) {
    alternateInk = stripLeadingZerosInk(inkNumber);
    alternateFormula = findExactInkFormulaRecords(alternateInk);
    alternateInventory = findExactInkInventoryRecords(alternateInk);

    if ((exactFormula.length || exactInventory.length) && (alternateFormula.length || alternateInventory.length)) {
      const clarification = makeInkClarificationPrompt(inkNumber, alternateInk, batchPounds, "both-exist");
      pendingRequests.set(userKey, clarification.pending);
      return withButtons(clarification.text, [
        makeButton(`Use ink ${exactInkLabel(inkNumber)}`, `use ink ${exactInkLabel(inkNumber)}`),
        makeButton(`Use ink ${exactInkLabel(alternateInk)}`, `use ink ${exactInkLabel(alternateInk)}`)
      ]);
    }

    if (!exactFormula.length && !exactInventory.length && (alternateFormula.length || alternateInventory.length)) {
      const clarification = makeInkClarificationPrompt(inkNumber, alternateInk, batchPounds, "leading-zero");
      pendingRequests.set(userKey, clarification.pending);
      return withButtons(clarification.text, [
        makeButton(`Yes, use ink ${exactInkLabel(alternateInk)}`, `use ink ${exactInkLabel(alternateInk)}`),
        makeButton(`No, I meant ink ${exactInkLabel(inkNumber)}`, `use ink ${exactInkLabel(inkNumber)}`)
      ]);
    }
  }

  if (wantsFormula) {
    if (exactFormula.length) {
      if (!batchPounds) {
        pendingRequests.set(userKey, {
          step: "awaiting_formula_batch_size",
          inkNumber,
          formulaRecord: exactFormula[0]
        });

        return withButtons(
          `I found a formula for ink ${exactInkLabel(inkNumber)}. How many pounds do you want to make?`,
          [
            makeButton("5 lb", "5 lb"),
            makeButton("10 lb", "10 lb"),
            makeButton("25 lb", "25 lb"),
            makeButton("50 lb", "50 lb")
          ]
        );
      }

      return formatFormula(exactFormula[0], inkNumber, batchPounds);
    }

    const nearby = findNearbyInkRecords(inkNumber);
    if (nearby.length) {
      pendingRequests.set(userKey, {
        step: "clarify_nearby_ink",
        originalInk: exactInkLabel(inkNumber),
        nearbyInk: nearby[0].label,
        batchPounds,
        record: nearby[0].record
      });

      return withButtons(
        [
          `I could not find a formula record for ink ${exactInkLabel(inkNumber)} in the current JARVIS ink files.`,
          "",
          `I did find a nearby ink/color record: ${nearby[0].label}.`,
          "",
          `Ink ${exactInkLabel(inkNumber)} and ink ${nearby[0].label} may not be the same color.`,
          "",
          `Do you mean ink ${nearby[0].label}?`
        ].join("\n"),
        [
          makeButton(`Yes, use ${nearby[0].label}`, `use ink ${nearby[0].label}`),
          makeButton(`No, I meant ${exactInkLabel(inkNumber)}`, `use ink ${exactInkLabel(inkNumber)}`),
          makeButton("Flag this for Jonathan", "flag for jonathan")
        ]
      );
    }

    if (exactInventory.length) {
      return [
        `I could not find a formula record for ink ${exactInkLabel(inkNumber)} in the current JARVIS ink files.`,
        "",
        "I did find inventory information:",
        "",
        formatInkInventory(exactInventory, inkNumber),
        "",
        "Do not guess a formula. JARVIS can flag this for Jonathan if you need help."
      ].join("\n");
    }

    pendingRequests.set(userKey, {
      step: "confirm_escalate",
      issue: `Need formula/help for ink ${exactInkLabel(inkNumber)}. JARVIS could not find a formula or confirmed inventory.`,
      priority: "URGENT"
    });

    return withButtons(
      [
        `I could not find a formula record for ink ${exactInkLabel(inkNumber)} in the current JARVIS ink files.`,
        "",
        "I also could not confirm current inventory for that ink color.",
        "",
        "Would you like me to flag this for Jonathan?"
      ].join("\n"),
      [
        makeButton("Flag this for Jonathan", "flag for jonathan"),
        makeButton("Cancel", "cancel")
      ]
    );
  }

  if (exactInventory.length) {
    return formatInkInventory(exactInventory, inkNumber);
  }

  const nearby = findNearbyInkRecords(inkNumber);
  if (nearby.length) {
    pendingRequests.set(userKey, {
      step: "clarify_nearby_ink",
      originalInk: exactInkLabel(inkNumber),
      nearbyInk: nearby[0].label,
      batchPounds,
      record: nearby[0].record
    });

    return withButtons(
      [
        `I could not find ink ${exactInkLabel(inkNumber)} in the current inventory.`,
        "",
        `I did find a nearby color, ink ${nearby[0].label}, but that is not the same as ${exactInkLabel(inkNumber)}.`,
        "",
        `Do you mean ink ${nearby[0].label}?`
      ].join("\n"),
      [
        makeButton(`Yes, use ${nearby[0].label}`, `use ink ${nearby[0].label}`),
        makeButton(`No, I meant ${exactInkLabel(inkNumber)}`, `use ink ${exactInkLabel(inkNumber)}`),
        makeButton("Flag this for Jonathan", "flag for jonathan")
      ]
    );
  }

  pendingRequests.set(userKey, {
    step: "confirm_escalate",
    issue: `User asked about ink ${exactInkLabel(inkNumber)}, but JARVIS could not find formula or inventory.`,
    priority: "NORMAL"
  });

  return withButtons(
    [
      `I could not find ink ${exactInkLabel(inkNumber)} in the current JARVIS ink files.`,
      "",
      "Would you like me to flag this for Jonathan?"
    ].join("\n"),
    [
      makeButton("Flag this for Jonathan", "flag for jonathan"),
      makeButton("Cancel", "cancel")
    ]
  );
}

async function handlePendingRequest(userKey, message) {
  const pending = pendingRequests.get(userKey);
  if (!pending) return "";

  const command = normalizeLoose(parseButtonMessage(message));

  if (command === "cancel") {
    pendingRequests.delete(userKey);
    return "Canceled.";
  }

  if (pending.step === "confirm_add_supply_to_po" || pending.step === "confirm_add_part_to_po") {
    if (command.includes("add to po") || wantsToAddToPO(command) || isAffirmative(command)) {
      pendingRequests.delete(userKey);
      const result = await createPORequest(pending.item, {
        priority: "NORMAL",
        issue: pending.originalQuery,
        notes: "User asked JARVIS to add this missing item to the PO request list."
      });

      if (result.ok) {
        return [
          `I added this to Jonathan’s Purchase Order Request list:`,
          "",
          pending.item,
          "",
          "This does not mean it has been ordered or approved yet. Jonathan will review it."
        ].join("\n");
      }

      return [
        "I tried to add this to the PO request list, but I could not confirm the spreadsheet update.",
        "",
        `Item: ${pending.item}`,
        "",
        "Please try again later or ask for Jonathan’s number if this is urgent."
      ].join("\n");
    }

    if (isNegative(command)) {
      pendingRequests.delete(userKey);
      return "Okay, I did not add it.";
    }

    return withButtons(
      "Do you want me to add this to Jonathan’s Purchase Order Request list?",
      [
        makeButton("Add to PO request", "add to po"),
        makeButton("Cancel", "cancel")
      ]
    );
  }

  if (pending.step === "confirm_fuzzy_part") {
    if (command.includes("yes fuzzy part") || isAffirmative(command)) {
      pendingRequests.delete(userKey);
      return [
        "Okay. Here is the possible matching item:",
        "",
        summarizeRecord(pending.suggestedRecord),
        "",
        "Please physically verify before relying on it."
      ].join("\n");
    }

    if (command.includes("add original item") || wantsToAddToPO(command)) {
      pendingRequests.delete(userKey);
      const result = await createPORequest(pending.originalQuery, {
        priority: "NORMAL",
        issue: `User did not confirm fuzzy match. Original request: ${pending.originalQuery}`,
        notes: `JARVIS suggested ${pending.found}, but user chose to request original item.`
      });

      if (result.ok) {
        return [
          "I added the original item/request to Jonathan’s Purchase Order Request list.",
          "",
          pending.originalQuery,
          "",
          "This does not mean it has been ordered or approved yet. Jonathan will review it."
        ].join("\n");
      }

      return "I tried to add the original request to the PO list, but I could not confirm the spreadsheet update.";
    }

    if (command.includes("no fuzzy part") || isNegative(command)) {
      return withButtons(
        "Okay. Do you want me to add the original item/request to Jonathan’s Purchase Order Request list?",
        [
          makeButton("Add original item to PO request", "add original item to po"),
          makeButton("Cancel", "cancel")
        ]
      );
    }

    return withButtons(
      "Is the possible close match the item you meant?",
      [
        makeButton("Yes, this is it", "yes fuzzy part"),
        makeButton("No, not this item", "no fuzzy part"),
        makeButton("Add original item to PO request", "add original item to po")
      ]
    );
  }

  if (pending.step === "awaiting_formula_batch_size") {
    const pounds = extractBatchPounds(command);
    if (!pounds) {
      return withButtons(
        "How many pounds do you want to make?",
        [
          makeButton("5 lb", "5 lb"),
          makeButton("10 lb", "10 lb"),
          makeButton("25 lb", "25 lb"),
          makeButton("50 lb", "50 lb")
        ]
      );
    }

    pendingRequests.delete(userKey);
    return formatFormula(pending.formulaRecord, pending.inkNumber, pounds);
  }

  if (pending.step === "clarify_ink_number") {
    const useMatch = command.match(/\buse ink\s+([0-9]{1,4}(?:\s*[uc])?)\b/i);
    if (!useMatch) {
      return withButtons(
        `Which ink do you mean?`,
        [
          makeButton(`Use ink ${pending.originalInk}`, `use ink ${pending.originalInk}`),
          makeButton(`Use ink ${pending.alternateInk}`, `use ink ${pending.alternateInk}`)
        ]
      );
    }

    const selectedInk = useMatch[1].toUpperCase().replace(/\s*([UC])$/, " $1");
    pendingRequests.delete(userKey);

    return answerInkQuestion(
      `make ink ${selectedInk}${pending.batchPounds ? " " + pending.batchPounds + " lb" : ""}`,
      userKey,
      selectedInk,
      pending.batchPounds
    );
  }

  if (pending.step === "clarify_nearby_ink") {
    if (command.includes("flag for jonathan")) {
      pendingRequests.delete(userKey);
      const result = await createEscalation(
        `User needs help with ink ${pending.originalInk}. Nearby record found: ${pending.nearbyInk}, but user requested escalation.`,
        { priority: "URGENT", item: `Ink ${pending.originalInk}` }
      );
      return escalationConfirmationText(`Ink ${pending.originalInk}`, result);
    }

    const useMatch = command.match(/\buse ink\s+([0-9]{1,4}(?:\s*[uc])?)\b/i);
    if (useMatch) {
      const selectedInk = useMatch[1].toUpperCase().replace(/\s*([UC])$/, " $1");
      const selectedIsNearby = canonicalInkLabel(selectedInk) === canonicalInkLabel(pending.nearbyInk);

      pendingRequests.delete(userKey);

      if (!selectedIsNearby) {
        const result = await createEscalation(
          `User confirmed they meant ink ${pending.originalInk}, but JARVIS only found nearby ink ${pending.nearbyInk}.`,
          { priority: "URGENT", item: `Ink ${pending.originalInk}` }
        );
        return [
          `Okay. I will not use ink ${pending.nearbyInk}.`,
          "",
          escalationConfirmationText(`Ink ${pending.originalInk}`, result)
        ].join("\n");
      }

      return answerInkQuestion(
        `make ink ${selectedInk}${pending.batchPounds ? " " + pending.batchPounds + " lb" : ""}`,
        userKey,
        selectedInk,
        pending.batchPounds
      );
    }

    if (isNegative(command)) {
      pendingRequests.delete(userKey);
      const result = await createEscalation(
        `User said nearby ink ${pending.nearbyInk} is not correct. Original request: ink ${pending.originalInk}.`,
        { priority: "URGENT", item: `Ink ${pending.originalInk}` }
      );
      return escalationConfirmationText(`Ink ${pending.originalInk}`, result);
    }

    return withButtons(
      `Do you mean ink ${pending.nearbyInk}?`,
      [
        makeButton(`Yes, use ${pending.nearbyInk}`, `use ink ${pending.nearbyInk}`),
        makeButton(`No, I meant ${pending.originalInk}`, `use ink ${pending.originalInk}`),
        makeButton("Flag this for Jonathan", "flag for jonathan")
      ]
    );
  }

  if (pending.step === "confirm_escalate") {
    if (command.includes("flag for jonathan") || isAffirmative(command) || isJonathanEscalationIntent(command)) {
      pendingRequests.delete(userKey);
      const result = await createEscalation(pending.issue, {
        priority: pending.priority || "NORMAL"
      });
      return escalationConfirmationText(pending.issue, result);
    }

    if (isNegative(command)) {
      pendingRequests.delete(userKey);
      return "Okay. I did not flag it for Jonathan.";
    }

    return withButtons(
      "Do you want me to flag this for Jonathan?",
      [
        makeButton("Flag this for Jonathan", "flag for jonathan"),
        makeButton("Cancel", "cancel")
      ]
    );
  }

  return "";
}
async function processUserMessage(message, userKey = "web-user") {
  const originalMessage = normalize(message);
  if (!originalMessage) {
    return "What can I help you with?";
  }

  const parsedMessage = parseButtonMessage(originalMessage);

  const pendingResponse = await handlePendingRequest(userKey, parsedMessage);
  if (pendingResponse) return pendingResponse;

  const emergency = answerActiveEmergency(parsedMessage);
  if (emergency) return emergency;

  const jonathanStatus = answerJonathanStatus(parsedMessage);
  if (jonathanStatus) return jonathanStatus;

  if (isJonathanEscalationIntent(parsedMessage)) {
    const result = await createEscalation(`User asked JARVIS to flag/contact Jonathan. Message: ${originalMessage}`, {
      priority: "NORMAL",
      notes: "User specifically asked JARVIS to contact or flag Jonathan. Do not escalate beyond Jonathan."
    });
    return escalationConfirmationText(originalMessage, result);
  }

  const mapAnswer = answerMapQuestion(parsedMessage);
  if (mapAnswer) return mapAnswer;

  const wasteInkAnswer = answerWasteInkPickup(parsedMessage);
  if (wasteInkAnswer) return wasteInkAnswer;

  const vendorAnswer = answerVendorContact(parsedMessage);
  if (vendorAnswer) return vendorAnswer;

  const copperAnswer = answerCopperWastewater(parsedMessage);
  if (copperAnswer) return copperAnswer;

  const hvacAnswer = answerHvacQuestion(parsedMessage);
  if (hvacAnswer) return hvacAnswer;

  const aniloxAnswer = answerAniloxQuestion(parsedMessage);
  if (aniloxAnswer) return aniloxAnswer;

  const inkAnswer = answerInkQuestion(parsedMessage, userKey);
  if (inkAnswer) return inkAnswer;

  const knifeAnswer = answerKnifeQuestion(parsedMessage);
  if (knifeAnswer) return knifeAnswer;

  const magnaAnswer = answerMagnaQuestion(parsedMessage);
  if (magnaAnswer) return magnaAnswer;

  const scheduleAnswer = answerScheduleQuestion(parsedMessage);
  if (scheduleAnswer) return scheduleAnswer;

  const partsAnswer = answerPartsOrSupplyQuestion(parsedMessage, userKey);
  if (partsAnswer) return partsAnswer;

  const results = searchKnowledge(parsedMessage, { limit: 5 });
  const strongResults = results.filter((result) => result.score >= 8);

  if (strongResults.length) {
    return [
      "Here is what I found:",
      "",
      ...strongResults.slice(0, 3).map((result) => summarizeRecord(result.record)),
      "",
      "Please physically verify before relying on it."
    ].join("\n\n");
  }

  pendingRequests.set(userKey, {
    step: "confirm_escalate",
    issue: `JARVIS could not answer this question confidently: ${originalMessage}`,
    priority: shouldEscalateUrgent(originalMessage) ? "URGENT" : "NORMAL"
  });

  return withButtons(
    [
      `I received your question:`,
      "",
      `"${originalMessage}"`,
      "",
      "I do not have enough information loaded to answer that confidently.",
      "",
      "Would you like me to flag this for Jonathan?"
    ].join("\n"),
    [
      makeButton("Flag this for Jonathan", "flag for jonathan"),
      makeButton("Cancel", "cancel")
    ]
  );
}

function escapeHtml(text) {
  return normalize(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderMessageHtml(text) {
  const raw = normalize(text);
  const lines = raw.split("\n");
  const htmlParts = [];

  for (const line of lines) {
    const imageMatch = line.match(/^\[image:(.+?)\]$/);
    if (imageMatch) {
      const src = imageMatch[1];
      htmlParts.push(
        `<a href="${escapeHtml(src)}" target="_blank" rel="noopener"><img class="kb-image" src="${escapeHtml(src)}" alt="JARVIS map image"></a>`
      );
      continue;
    }

    const buttonMatch = line.match(/^\[button:([^|\]]+)\|([^\]]+)\]$/);
    if (buttonMatch) {
      const value = escapeHtml(`[button:${buttonMatch[1]}|${buttonMatch[2]}]`);
      const label = escapeHtml(buttonMatch[2]);
      htmlParts.push(`<button class="quick-button" data-value="${value}">${label}</button>`);
      continue;
    }

    if (!line.trim()) {
      htmlParts.push("<br>");
      continue;
    }

    htmlParts.push(`<div>${escapeHtml(line)}</div>`);
  }

  return htmlParts.join("");
}

function renderAskPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>J.A.R.V.I.S.</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f3f5f8;
      --card: #ffffff;
      --text: #111827;
      --muted: #6b7280;
      --blue: #2563eb;
      --blue-dark: #1d4ed8;
      --border: #d1d5db;
      --bot: #eef2ff;
      --user: #dcfce7;
      --danger: #b91c1c;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      font-family: Arial, Helvetica, sans-serif;
      background: var(--bg);
      color: var(--text);
    }

    .page {
      width: min(900px, 100%);
      margin: 0 auto;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      padding: 18px;
    }

    header {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 18px;
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08);
      margin-bottom: 14px;
    }

    h1 {
      margin: 0 0 4px 0;
      font-size: clamp(28px, 6vw, 44px);
      letter-spacing: 0.03em;
    }

    .subtitle {
      font-size: clamp(14px, 3vw, 18px);
      color: var(--muted);
      margin-bottom: 8px;
    }

    .version {
      color: var(--muted);
      font-size: 13px;
    }

    .chat {
      flex: 1;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 14px;
      overflow-y: auto;
      min-height: 420px;
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08);
    }

    .message {
      max-width: 86%;
      margin: 10px 0;
      padding: 12px 14px;
      border-radius: 16px;
      line-height: 1.38;
      white-space: normal;
      overflow-wrap: anywhere;
    }

    .message.bot {
      background: var(--bot);
      border-bottom-left-radius: 4px;
      margin-right: auto;
    }

    .message.user {
      background: var(--user);
      border-bottom-right-radius: 4px;
      margin-left: auto;
    }

    .message.error {
      background: #fee2e2;
      color: var(--danger);
    }

    .composer {
      display: flex;
      gap: 10px;
      padding: 14px 0 0 0;
    }

    textarea {
      flex: 1;
      min-height: 54px;
      max-height: 150px;
      resize: vertical;
      border-radius: 16px;
      border: 1px solid var(--border);
      padding: 14px;
      font: inherit;
      background: #fff;
      color: var(--text);
    }

    button {
      font: inherit;
    }

    .send {
      min-width: 86px;
      border: 0;
      border-radius: 16px;
      padding: 0 18px;
      color: white;
      background: var(--blue);
      cursor: pointer;
      font-weight: 700;
    }

    .send:hover {
      background: var(--blue-dark);
    }

    .send:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

    .quick-button {
      display: block;
      width: fit-content;
      max-width: 100%;
      margin: 8px 0;
      border: 1px solid var(--blue);
      border-radius: 999px;
      padding: 9px 13px;
      color: var(--blue);
      background: #fff;
      cursor: pointer;
      font-weight: 700;
      text-align: left;
    }

    .quick-button:hover {
      background: #eff6ff;
    }

    .examples {
      margin-top: 10px;
      color: var(--muted);
      font-size: 13px;
    }

    .kb-image {
      max-width: 100%;
      border-radius: 12px;
      border: 1px solid var(--border);
      margin: 8px 0;
      background: #fff;
    }

    footer {
      color: var(--muted);
      font-size: 12px;
      padding: 10px 4px 0 4px;
      text-align: center;
    }

    @media (max-width: 600px) {
      .page {
        padding: 10px;
      }

      .composer {
        gap: 8px;
      }

      .send {
        min-width: 72px;
        padding: 0 12px;
      }

      .message {
        max-width: 94%;
      }
    }
  </style>
</head>
<body>
  <main class="page">
    <header>
      <h1>J.A.R.V.I.S.</h1>
      <div class="subtitle">Jonathan's Automated Resource &amp; Virtual Information System</div>
      <div class="version">v${APP_VERSION}</div>
      <div class="examples">Try: “Do we have ink 186?”, “Make 10 lb of ink 2935 U”, “I need AA batteries”, “Where are the thermostats?”, “Who do I call for waste ink pickup?”</div>
    </header>

    <section id="chat" class="chat" aria-live="polite">
      <div class="message bot">What can I help you with?</div>
    </section>

    <form id="form" class="composer">
      <textarea id="input" placeholder="Type your question..." autofocus></textarea>
      <button id="send" class="send" type="submit">Send</button>
    </form>

    <footer>
      JARVIS gives best-effort help from loaded facility notes. Verify critical production information before relying on it.
    </footer>
  </main>

  <script>
    const chat = document.getElementById("chat");
    const form = document.getElementById("form");
    const input = document.getElementById("input");
    const send = document.getElementById("send");

    function scrollToBottom() {
      chat.scrollTop = chat.scrollHeight;
    }

    function addMessage(role, html, isHtml = false) {
      const div = document.createElement("div");
      div.className = "message " + role;
      if (isHtml) div.innerHTML = html;
      else div.textContent = html;
      chat.appendChild(div);
      scrollToBottom();
      return div;
    }

    async function sendMessage(text) {
      const message = (text || "").trim();
      if (!message) return;

      addMessage("user", message);
      input.value = "";
      send.disabled = true;

      const thinking = addMessage("bot", "Thinking...");

      try {
        const response = await fetch("/api/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message })
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || "Request failed");
        }

        thinking.innerHTML = data.html || "";
      } catch (error) {
        thinking.className = "message bot error";
        thinking.textContent = "JARVIS had trouble answering. Please try again.";
      } finally {
        send.disabled = false;
        input.focus();
        scrollToBottom();
      }
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      sendMessage(input.value);
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendMessage(input.value);
      }
    });

    chat.addEventListener("click", (event) => {
      const button = event.target.closest(".quick-button");
      if (!button) return;
      sendMessage(button.dataset.value);
    });
  </script>
</body>
</html>`;
}

app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

app.use("/kb", express.static(DATA_ROOT, {
  setHeaders: (res) => {
    res.setHeader("Cache-Control", "no-store");
  }
}));

app.get("/", (req, res) => {
  res.redirect("/ask");
});

app.get("/ask", (req, res) => {
  res.type("html").send(renderAskPage());
});

app.post("/api/ask", async (req, res) => {
  try {
    const message = normalize(req.body?.message);
    const userKey = getUserKey(req);
    const answer = await processUserMessage(message, userKey);
    res.json({
      ok: true,
      version: APP_VERSION,
      answer,
      html: renderMessageHtml(answer)
    });
  } catch (error) {
    console.error("API ask error:", error);
    res.status(500).json({
      ok: false,
      version: APP_VERSION,
      error: "JARVIS had trouble answering."
    });
  }
});

app.post("/sms", async (req, res) => {
  const message = normalize(req.body?.Body);
  const userKey = getUserKey(req);

  let answer = "";
  try {
    answer = await processUserMessage(message, userKey);
  } catch (error) {
    console.error("SMS error:", error);
    answer = "JARVIS had trouble answering. Please try again.";
  }

  const response = new Twiml.MessagingResponse();
  response.message(answer.replace(/\[button:[^\]]+\]/g, "").replace(/\[image:[^\]]+\]/g, ""));
  res.type("text/xml").send(response.toString());
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    version: APP_VERSION,
    records: knowledgeRecords.length,
    loadedAt: knowledgeLoadedAt,
    loadError: knowledgeLoadError ? knowledgeLoadError.message : null,
    requestWebhookConfigured: !!REQUEST_WEBHOOK_URL
  });
});

app.get("/kb-status", (req, res) => {
  const byCategory = {};
  for (const record of knowledgeRecords) {
    byCategory[record.category] = (byCategory[record.category] || 0) + 1;
  }

  res.json({
    ok: !knowledgeLoadError,
    version: APP_VERSION,
    dataRoot: DATA_ROOT,
    records: knowledgeRecords.length,
    loadedAt: knowledgeLoadedAt,
    loadError: knowledgeLoadError ? knowledgeLoadError.message : null,
    byCategory,
    sampleFiles: [...new Set(knowledgeRecords.map((record) => record.sourceFile))].slice(0, 100)
  });
});

app.post("/reload-kb", (req, res) => {
  loadKnowledgeBase();
  res.json({
    ok: !knowledgeLoadError,
    version: APP_VERSION,
    records: knowledgeRecords.length,
    loadedAt: knowledgeLoadedAt,
    loadError: knowledgeLoadError ? knowledgeLoadError.message : null
  });
});

app.get("/debug/search", (req, res) => {
  const q = normalize(req.query.q);
  const results = searchKnowledge(q, { limit: 15 }).map((result) => ({
    score: result.score,
    title: result.record.title,
    category: result.record.category,
    sourceFile: result.record.sourceFile,
    sheetName: result.record.sheetName,
    rowNumber: result.record.rowNumber,
    summary: summarizeRecord(result.record)
  }));

  res.json({
    version: APP_VERSION,
    query: q,
    results
  });
});

app.get("/debug/ink", (req, res) => {
  const ink = normalize(req.query.ink);
  res.json({
    version: APP_VERSION,
    ink,
    exactLabel: exactInkLabel(ink),
    canonicalLabel: canonicalInkLabel(ink),
    hasLeadingZero: inkNumberHasLeadingZero(ink),
    stripped: stripLeadingZerosInk(ink),
    exactFormula: findExactInkFormulaRecords(ink).map((record) => ({
      sourceFile: record.sourceFile,
      sheetName: record.sheetName,
      rowNumber: record.rowNumber,
      summary: summarizeRecord(record)
    })),
    exactInventory: findExactInkInventoryRecords(ink).map((record) => ({
      sourceFile: record.sourceFile,
      sheetName: record.sheetName,
      rowNumber: record.rowNumber,
      summary: summarizeRecord(record)
    })),
    nearby: findNearbyInkRecords(ink).map((item) => ({
      label: item.label,
      sourceFile: item.record.sourceFile,
      sheetName: item.record.sheetName,
      rowNumber: item.record.rowNumber,
      summary: summarizeRecord(item.record)
    }))
  });
});

const PORT = process.env.PORT || 3000;

loadKnowledgeBase();

app.listen(PORT, () => {
  console.log(`JARVIS v${APP_VERSION} listening on port ${PORT}`);
});
