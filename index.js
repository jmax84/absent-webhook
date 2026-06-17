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

const APP_VERSION = "0.2.10";
const DATA_ROOT = path.join(__dirname, "data", "JARVIS_DATA_FINAL_2026-06-XX");

const HVAC_THERMOSTAT_IMAGE = "/kb/04_HVAC_AND_BUILDING/HVAC_thermostat_locations.png";
const EYEWASH_IMAGE = "/kb/04_HVAC_AND_BUILDING/FACILITY_eye_wash_stations.png";
const FIRE_EXTINGUISHER_IMAGE = "/kb/04_HVAC_AND_BUILDING/FACILITY_fire_extinguishers.png";

const JONATHAN_AWAY_START = "Friday evening, June 26, 2026";
const JONATHAN_TRAVEL_NOTE = "Jonathan is flying to Portland, Oregon on the evening of June 26.";
const JONATHAN_RETURN = "Monday morning, July 6, 2026";
const JONATHAN_PHONE_FALLBACK = "360-953-1794";

const pendingRequests = new Map();

let knowledgeRecords = [];
let knowledgeLoadedAt = null;
let knowledgeLoadError = null;

const SEARCH_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "could", "do", "does",
  "for", "from", "have", "how", "i", "in", "is", "it", "me", "need", "of", "on",
  "or", "our", "please", "send", "the", "there", "this", "to", "we", "what",
  "when", "where", "who", "with", "you"
]);

const SENSITIVE_FIELD_PATTERNS = [
  /cost/i,
  /unit\s*price/i,
  /total\s*price/i,
  /price/i,
  /dollar/i,
  /amount/i,
  /margin/i,
  /markup/i,
  /account/i,
  /approval/i
];

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

    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath));
    } else {
      files.push(fullPath);
    }
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

  return (
    sheet === "readme" ||
    src.includes("readme") ||
    src.includes("rules") ||
    src.includes("notes") ||
    src.includes("index") ||
    src.includes("policy") ||
    src.includes("search") ||
    src.includes("data_last_updated") ||
    title.includes("rules") ||
    title.includes("notes") ||
    title.includes("index") ||
    title.includes("policy") ||
    title.includes("search")
  );
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

  knowledgeRecords.push({
    ...record,
    normalizedText: normalizeLoose(text),
    searchKeys: [...searchKeys]
  });
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

    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
      defval: "",
      raw: false
    });

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
    body: `${titleFromFile(filePath)} PDF reference document.`
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

        addKnowledgeRecord({
          type: "load-error",
          category: categoryFromFile(filePath),
          title: titleFromFile(filePath),
          sourceFile: rel,
          url: publicKbUrl(filePath),
          body: "This file could not be loaded: " + error.message
        });
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

      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  return matrix[a.length][b.length];
}

function scoreRecord(record, query) {
  const qLoose = normalizeLoose(query);
  const terms = qLoose
    .split(" ")
    .filter((term) => term.length >= 2 && !SEARCH_STOPWORDS.has(term));

  const queryKeys = extractSearchKeys(query);
  const queryDigits = [...new Set(queryKeys.map((key) => digitsOnly(key)).filter((key) => key.length >= 3))];

  let score = 0;

  if (!qLoose) return 0;

  if (isGuidanceRecord(record)) score -= 20;

  if (record.normalizedText.includes(qLoose)) score += 75;

  let matchedTerms = 0;

  for (const term of terms) {
    if (record.normalizedText.includes(term)) matchedTerms += 1;
  }

  if (matchedTerms > 0) score += matchedTerms * 8 + (matchedTerms === terms.length ? 20 : 0);

  for (const queryKey of queryKeys) {
    for (const recordKey of record.searchKeys || []) {
      if (recordKey === queryKey) {
        score += 120;
      } else if (queryKey.length >= 4 && recordKey.length >= 4) {
        const queryDigitsOnly = digitsOnly(queryKey);
        const recordDigitsOnly = digitsOnly(recordKey);

        if (
          queryKey[0] === recordKey[0] &&
          queryDigitsOnly.length >= 4 &&
          recordDigitsOnly.length >= 4 &&
          (recordKey.includes(queryKey) || queryKey.includes(recordKey))
        ) {
          score += 60;
        } else if (levenshtein(recordKey, queryKey) <= (Math.max(queryKey.length, recordKey.length) <= 6 ? 1 : 2)) {
          score += 25;
        }
      }
    }
  }

  for (const queryDigit of queryDigits) {
    for (const recordKey of record.searchKeys || []) {
      const recordDigits = digitsOnly(recordKey);
      if (recordDigits === queryDigit) score += 90;
    }
  }

  if (record.type === "spreadsheet-row") score += 5;

  return score;
}

function searchKnowledge(query, options = {}) {
  const maxResults = options.maxResults || 5;
  const categories = options.categories || [];
  const includeGuidance = options.includeGuidance || false;
  const minScore = options.minScore ?? 25;

  let records = knowledgeRecords;

  if (categories.length) {
    records = records.filter((record) => categories.includes(record.category));
  }

  if (!includeGuidance) {
    const nonGuidance = records.filter((record) => !isGuidanceRecord(record));
    if (nonGuidance.length) records = nonGuidance;
  }

  return records
    .map((record) => ({ ...record, score: scoreRecord(record, query) }))
    .filter((record) => record.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

function getField(fields, names) {
  const entries = Object.entries(fields || {});
  const wanted = names.map((name) => lower(name));

  for (const [key, value] of entries) {
    if (wanted.includes(lower(key))) return normalize(value);
  }

  for (const [key, value] of entries) {
    const keyNorm = lower(key).replace(/[^a-z0-9]/g, "");

    for (const name of wanted) {
      if (keyNorm === name.replace(/[^a-z0-9]/g, "")) return normalize(value);
    }
  }

  return "";
}

function isBlankOrZero(value) {
  const clean = normalize(value);
  if (!clean) return true;

  const number = Number(clean.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(number) && number <= 0;
}

function safeFields(fields, limit = 12) {
  return Object.fromEntries(
    Object.entries(fields || {})
      .filter(([key, value]) => !isSensitiveField(key) && normalize(value) !== "")
      .slice(0, limit)
  );
}

function makeExcerpt(body, query, maxLen = 700) {
  const text = normalize(body).replace(/\s+/g, " ");

  if (text.length <= maxLen) return text;

  const terms = normalizeLoose(query)
    .split(" ")
    .filter((term) => term.length > 3 && !SEARCH_STOPWORDS.has(term));

  const lowerText = text.toLowerCase();
  let idx = -1;

  for (const term of terms) {
    idx = lowerText.indexOf(term);
    if (idx >= 0) break;
  }

  if (idx < 0) idx = 0;

  const start = Math.max(0, idx - 180);
  const end = Math.min(text.length, start + maxLen);

  return (start > 0 ? "..." : "") + text.slice(start, end) + (end < text.length ? "..." : "");
}

function findPdfByName(fragment) {
  const frag = lower(fragment);
  return knowledgeRecords.find((record) => record.type === "file" && lower(record.sourceFile).includes(frag));
}

function findDocumentByName(fragment) {
  const frag = lower(fragment);
  return knowledgeRecords.find((record) => record.type === "document" && lower(record.sourceFile).includes(frag));
}

function linkLine(record) {
  return record?.url ? "\n\nOpen file: " + record.url : "";
}

function imageLine(imagePath) {
  return "\n\n[image:" + imagePath + "]";
}

function buttonLine(value, label) {
  return "[button:" + value + "|" + label + "]";
}

function addMissingPartButtons() {
  return "\n\n" + buttonLine("add to po request", "Add to PO request") + "\n" + buttonLine("cancel", "Cancel");
}

function partMatchButtons() {
  return "\n\n" + buttonLine("yes", "Yes, this is it") + "\n" + buttonLine("that is not it", "No, not this item") + "\n" + buttonLine("add original part", "Add original item to PO request");
}

function dueDateButtons() {
  return "\n\n" + buttonLine("ASAP", "ASAP") + "\n" + buttonLine("today", "Today") + "\n" + buttonLine("tomorrow", "Tomorrow") + "\n" + buttonLine("within 2 weeks", "Within 2 weeks");
}

function machineAreaButtons() {
  return "\n\n" +
    buttonLine("102", "102") + "\n" +
    buttonLine("202", "202") + "\n" +
    buttonLine("627-1", "627-1") + "\n" +
    buttonLine("627-2", "627-2") + "\n" +
    buttonLine("627-3", "627-3") + "\n" +
    buttonLine("Ink Room", "Ink Room") + "\n" +
    buttonLine("WH2", "WH2") + "\n" +
    buttonLine("Maintenance", "Maintenance");
}

function formulaBatchButtons() {
  return "\n\n" +
    buttonLine("5 lb", "5 lb") + "\n" +
    buttonLine("10 lb", "10 lb") + "\n" +
    buttonLine("25 lb", "25 lb") + "\n" +
    buttonLine("50 lb", "50 lb");
}

function hasExplicitKnifeLanguage(query) {
  const q = lower(query);

  return (
    q.includes("knife") ||
    q.includes("knives") ||
    q.includes("cutoff") ||
    q.includes("cut-off") ||
    q.includes("profile") ||
    q.includes("side knife") ||
    q.includes("sharpen")
  );
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

function extractCandidatePartNumber(query) {
  const tokens = normalize(query).match(/[A-Za-z0-9][A-Za-z0-9._\-/]{1,}[A-Za-z0-9]/g) || [];

  for (const token of tokens) {
    const normalized = normalizePart(token);

    if (normalized.length < 3) continue;
    if ((/[A-Z]/.test(normalized) && /\d/.test(normalized)) || (/[._\-/]/.test(token) && /\d/.test(normalized))) return token;
  }

  return "";
}

function extractBatchSizePounds(query) {
  const q = lower(query);

  let match = q.match(/\b(\d+(?:\.\d+)?)\s*(?:pounds|pound|lbs|lb)\b/);
  if (match) return Number(match[1]);

  match = q.match(/\bmake\s+(\d+(?:\.\d+)?)\b/);
  if (match && (q.includes("ink") || q.includes("formula") || q.includes("mix"))) return Number(match[1]);

  return null;
}

function isInkFormulaQuestion(msg) {
  const q = lower(msg);

  if (q.includes("formula") || q.includes("recipe") || q.includes("ingredients") || q.includes("components") || q.includes("batch") || q.includes("ratio")) return true;
  if ((q.includes("make") || q.includes("mix")) && (q.includes("ink") || q.includes("pms") || q.includes("pantone") || q.includes("color"))) return true;
  if ((q.includes("pounds") || q.includes("pound") || q.includes("lbs") || q.includes("lb")) && (q.includes("ink") || q.includes("pms") || q.includes("pantone"))) return true;

  return false;
}

function extractInkNumber(query) {
  const q = lower(query);

  const explicit = q.match(/(?:ink\s*(?:number|#)?|pms|pantone|color)\s*#?\s*([0-9]{2,5}[a-z]?)(?:\s*(u|c))?/i);
  if (explicit) return normalizePart(explicit[1] + (explicit[2] || ""));

  const formulaFor = q.match(/(?:formula|recipe)\s+(?:for\s+)?(?:ink\s*)?#?\s*([0-9]{2,5}[a-z]?)(?:\s*(u|c))?/i);
  if (formulaFor) return normalizePart(formulaFor[1] + (formulaFor[2] || ""));

  if (isInkFormulaQuestion(q)) {
    const candidates = [...q.matchAll(/\b([0-9]{2,5}[a-z]?)(?:\s*(u|c))?\b/gi)];

    for (const candidate of candidates) {
      const full = candidate[0];
      const start = candidate.index || 0;
      const after = q.slice(start + full.length, start + full.length + 12);
      const before = q.slice(Math.max(0, start - 10), start);

      if (/^\s*(pounds|pound|lbs|lb)\b/i.test(after)) continue;
      if (/\b(make|mix)\s*$/i.test(before)) continue;

      return normalizePart(candidate[1] + (candidate[2] || ""));
    }
  }

  return "";
}

function isInkInventoryRecord(record) {
  const keys = Object.keys(record.fields || {}).join(" ").toLowerCase();

  return (
    keys.includes("total weight") ||
    keys.includes("container count") ||
    keys.includes("last count") ||
    keys.includes("weight lb")
  );
}

function isFormulaIdentifierField(fieldName) {
  const k = lower(fieldName);

  return (
    k === "pantone / color" ||
    k === "pantone" ||
    k === "pms" ||
    k === "color" ||
    k === "ink" ||
    k === "formula" ||
    k.includes("ink color number") ||
    k.includes("formula number") ||
    k.includes("pantone")
  );
}

function colorValueMatchesInkNumber(value, inkNumber) {
  const wanted = normalizePart(inkNumber);
  const raw = normalize(value).toUpperCase();

  if (!wanted || !raw) return false;

  const normalized = normalizePart(raw);

  if (new Set([wanted, "INK" + wanted, "PMS" + wanted, "PANTONE" + wanted]).has(normalized)) return true;

  const match = wanted.match(/^(\d{2,5})([A-Z]?)$/);
  if (!match) return normalized === wanted;

  const digits = match[1];
  const suffix = match[2];

  if (suffix) {
    return new RegExp("(^|[^0-9])" + digits + "\\s*" + suffix + "($|[^0-9])").test(raw);
  }

  return new RegExp("(^|[^0-9])" + digits + "\\s*(U|C)?($|[^0-9])").test(raw);
}

function recordColorMatchesInkNumber(record, inkNumber) {
  if (!record.fields) return false;

  for (const [key, value] of Object.entries(record.fields)) {
    if (isFormulaIdentifierField(key) && colorValueMatchesInkNumber(value, inkNumber)) return true;
  }

  return false;
}

function findExactInkInventoryRecord(inkNumber) {
  return knowledgeRecords.find((record) => {
    return (
      record.category === "03_INK_ROOM" &&
      record.type === "spreadsheet-row" &&
      isInkInventoryRecord(record) &&
      recordColorMatchesInkNumber(record, inkNumber)
    );
  });
}

function findExactInkFormulaRecords(inkNumber) {
  return knowledgeRecords.filter((record) => {
    return (
      record.category === "03_INK_ROOM" &&
      record.type === "spreadsheet-row" &&
      !isInkInventoryRecord(record) &&
      recordColorMatchesInkNumber(record, inkNumber)
    );
  });
}

function parsePercentNumber(value) {
  const match = normalize(value).match(/[-+]?\d+(?:\.\d+)?/);
  if (!match) return null;

  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}

function parseFormulaComponents(records) {
  const components = [];
  const seen = new Set();

  function addComponent(component, percent) {
    component = normalize(component).replace(/\s+/g, " ");
    percent = Number(percent);

    if (!component || !Number.isFinite(percent)) return;

    const key = lower(component) + "|" + percent.toFixed(4);
    if (seen.has(key)) return;

    seen.add(key);
    components.push({ component, percent });
  }

  for (const record of records) {
    const fields = record.fields || {};

    const summary = getField(fields, ["Formula Percent Components", "Percent Components", "Formula Components", "Components"]);
    if (summary) {
      const pieces = summary.split(/;|\n/).map((x) => x.trim()).filter(Boolean);

      for (const piece of pieces) {
        const match = piece.match(/^(.+?)\s*:\s*([0-9.]+)\s*%?$/);
        if (match) addComponent(match[1], Number(match[2]));
      }
    }

    const component = getField(fields, ["Component", "Ingredient", "Ink Component", "Material"]);
    const percent = parsePercentNumber(getField(fields, ["Percent", "%", "Component Percent", "Percentage"]));

    if (component && percent !== null) addComponent(component, percent);
  }

  return components;
}

function getFormulaLabel(records, inkNumber) {
  for (const record of records) {
    const fields = record.fields || {};
    const label = getField(fields, ["Pantone / Color", "Pantone", "PMS", "Color", "Ink Color Number", "Formula"]);
    if (label) return label;
  }

  return "Ink " + inkNumber;
}

function formatPounds(value) {
  return Number(value).toFixed(2);
}

function answerCalculatedInkFormula(inkNumber, batchPounds) {
  const exactFormulaRows = findExactInkFormulaRecords(inkNumber);

  if (!exactFormulaRows.length) {
    let reply = "I could not find a formula record for ink " + inkNumber + " in the current JARVIS ink files.";

    const exactInventory = findExactInkInventoryRecord(inkNumber);
    if (exactInventory) {
      reply += "\n\nI did find inventory information:\n\n" + answerInkInventoryRow(exactInventory);
      reply += "\n\nDo not guess a formula. Use the ink mixer system or contact Jonathan.";
    } else {
      reply += "\n\nI also could not confirm current inventory for that ink color.";
    }

    return reply;
  }

  const components = parseFormulaComponents(exactFormulaRows);
  const label = getFormulaLabel(exactFormulaRows, inkNumber);

  if (!components.length) {
    return "I found a formula record for " + label + ", but I could not read the component percentages cleanly. Use the ink mixer system or contact Jonathan.";
  }

  let reply = label + " — " + formatPounds(batchPounds) + " lb batch\n\n";
  let total = 0;

  for (const item of components) {
    const pounds = batchPounds * (item.percent / 100);
    total += pounds;
    reply += item.component + " = " + formatPounds(pounds) + " lb\n";
  }

  reply += "\nTotal = " + formatPounds(total) + " lb";
  reply += "\n\nFlexo note: This is a starting mix. Extender may be needed once the job is on press. That is normal.";

  return reply;
}

function answerInkFormulaQuestion(query, context = {}) {
  const inkNumber = extractInkNumber(query);
  const batchSize = extractBatchSizePounds(query);

  if (!inkNumber) {
    return "I need the exact ink/Pantone number to look up a formula safely. Example: make 10 lb of ink 186.";
  }

  const exactFormulaRows = findExactInkFormulaRecords(inkNumber);

  if (!exactFormulaRows.length) {
    return answerCalculatedInkFormula(inkNumber, batchSize || 0);
  }

  if (!batchSize) {
    if (context.from) {
      pendingRequests.set(context.from, {
        step: "awaiting_formula_batch_size",
        requesterName: context.requesterName || "",
        requesterPhone: context.from,
        inkNumber
      });
    }

    const label = getFormulaLabel(exactFormulaRows, inkNumber);

    return (
      "I found the formula for " + label + ".\n\n" +
      "How many pounds do you want to make?" +
      (context.from ? formulaBatchButtons() : "\n\nReply with something like: 10 lb")
    );
  }

  return answerCalculatedInkFormula(inkNumber, batchSize);
}

function answerInkInventoryRow(top) {
  const fields = top.fields || {};

  const color =
    getField(fields, ["Ink Color Number", "Color", "Pantone", "PMS"]) ||
    getField(fields, ["Formula Number"]) ||
    "that ink";

  const totalWeight = getField(fields, ["Total Weight lb", "Weight lb", "Weight", "Total Weight"]);
  const containerCount = getField(fields, ["Container Count", "Containers", "Count"]);
  const lastCountDate = getField(fields, ["Last Count Date", "Date Entered", "Count Date", "Last Updated"]);
  const location = getField(fields, ["Location", "Bin", "Shelf"]);
  const status = getField(fields, ["Status"]);

  if (isBlankOrZero(totalWeight) && isBlankOrZero(containerCount)) {
    let reply = "I found ink " + color + ", but the current snapshot does not show a clear usable quantity.";

    if (status) reply += "\n\nStatus: " + status;
    if (lastCountDate) reply += "\nLast counted: " + lastCountDate;

    return reply + "\n\nPlease physically verify before relying on it for production.";
  }

  let reply = "Yes — ink " + color + " is listed on hand.";

  if (totalWeight) reply += "\n\nTotal: " + totalWeight + " lb";
  if (containerCount) reply += "\nContainers: " + containerCount;
  if (location) reply += "\nLocation: " + location;
  if (lastCountDate) reply += "\nLast counted: " + lastCountDate;

  return reply + "\n\nPlease physically verify before relying on it for production.";
}

function answerInkQuestion(query) {
  const inkNumber = extractInkNumber(query);

  if (inkNumber) {
    const exactInventory = findExactInkInventoryRecord(inkNumber);
    if (exactInventory) return answerInkInventoryRow(exactInventory);
  }

  const results = searchKnowledge(query, {
    maxResults: 8,
    categories: ["03_INK_ROOM"],
    minScore: 25
  });

  const spreadsheetResults = results.filter((record) => record.type === "spreadsheet-row" && isInkInventoryRecord(record));
  if (spreadsheetResults.length) return answerInkInventoryRow(spreadsheetResults[0]);

  const guidanceResults = searchKnowledge(query, {
    maxResults: 3,
    categories: ["03_INK_ROOM"],
    includeGuidance: true,
    minScore: 25
  });

  if (guidanceResults.length) return answerFromTopResults(query, guidanceResults);

  return "I could not find that ink in the current JARVIS ink files. If this affects production, call or text Jonathan.";
}

function getPartMatchConfidence(query, record) {
  const queryKeys = extractSearchKeys(query);
  const recordKeys = record.searchKeys || [];

  for (const queryKey of queryKeys) {
    for (const recordKey of recordKeys) {
      if (queryKey === recordKey) return "exact";
    }
  }

  for (const queryKey of queryKeys) {
    for (const recordKey of recordKeys) {
      const queryDigitsOnly = digitsOnly(queryKey);
      const recordDigitsOnly = digitsOnly(recordKey);

      if (
        queryKey.length >= 4 &&
        recordKey.length >= 4 &&
        queryKey[0] === recordKey[0] &&
        queryDigitsOnly.length >= 4 &&
        recordDigitsOnly.length >= 4 &&
        (recordKey.includes(queryKey) || queryKey.includes(recordKey))
      ) {
        return "likely";
      }
    }
  }

  return "weak";
}

function answerPartsRow(top) {
  const fields = top.fields || {};

  const partNumber =
    getField(fields, ["Part Number", "Item Number", "Part", "Item", "Number"]) ||
    getField(fields, ["Normalized Search Key"]);

  const description = getField(fields, ["Description", "Part Description", "Item Description"]);
  const quantity = getField(fields, ["Quantity On Hand", "Qty On Hand", "Quantity", "Qty", "On Hand"]);
  const location = getField(fields, ["Location", "Bin", "Shelf", "Cabinet"]);
  const machine = getField(fields, ["Machine", "Machine / Area", "Area"]);
  const status = getField(fields, ["Status"]);

  let reply = partNumber || description
    ? "I found " + (partNumber || "a matching item") + (description ? " — " + description : "") + "."
    : "I found a matching item.";

  if (quantity) reply += "\n\nQuantity on hand: " + quantity;
  if (location) reply += "\nLocation: " + location;
  if (machine) reply += "\nMachine / Area: " + machine;
  if (status) reply += "\nStatus: " + status;

  return reply + "\n\nPlease physically verify before relying on it.";
}

function answerPartSearchResults(query, results, options = {}) {
  if (!results.length) {
    let reply =
      "I could not find that item in the current JARVIS parts/supplies inventory.\n\n" +
      "Would you like me to add it to Jonathan's Purchase Order Request list?";

    if (options.includeButtons) reply += addMissingPartButtons();

    return reply;
  }

  const confidence = getPartMatchConfidence(query, results[0]);

  if (confidence === "exact") return answerPartsRow(results[0]);

  let reply = "I did not find an exact match for that part/supply.\n\n";

  reply += confidence === "likely"
    ? "I found one likely match:\n\n"
    : "I found one possible loose match, but I am not confident it is the same item:\n\n";

  reply += answerPartsRow(results[0]);

  if (options.includeButtons) return reply + "\n\nIs this the item you meant?" + partMatchButtons();

  return reply + "\n\nIf this is not the item you meant, say: that is not it.";
}

function answerPartsLookup(query, context = {}) {
  const results = searchKnowledge(query, {
    maxResults: 6,
    categories: ["01_PARTS_INVENTORY"],
    minScore: looksLikePartNumber(query) ? 55 : 35
  });

  const candidatePartNumber =
    extractCandidatePartNumber(query) ||
    normalize(query).replace(/^i need (a |an |some )?/i, "").replace(/^need (a |an |some )?/i, "");

  if (!results.length) {
    if (context.from) {
      pendingRequests.set(context.from, {
        step: "confirm_add_missing_part",
        requesterName: context.requesterName || "",
        requesterPhone: context.from,
        partNumber: candidatePartNumber,
        partDescription: "",
        originalQuery: query
      });
    }

    return (
      "I could not find that item in the current JARVIS parts/supplies inventory.\n\n" +
      "Would you like me to add it to Jonathan's Purchase Order Request list?" +
      (context.from ? addMissingPartButtons() : "")
    );
  }

  const confidence = getPartMatchConfidence(query, results[0]);

  if (confidence !== "exact" && context.from) {
    pendingRequests.set(context.from, {
      step: "possible_part_match",
      requesterName: context.requesterName || "",
      requesterPhone: context.from,
      partNumber: candidatePartNumber,
      partDescription: "",
      originalQuery: query,
      possibleMatchSummary: answerPartsRow(results[0])
    });
  }

  return answerPartSearchResults(query, results, {
    includeButtons: context.from && confidence !== "exact"
  });
}

function extractSimplePartInfo(text) {
  const cleaned = normalize(text)
    .replace(/^i need (a |an |some )?/i, "")
    .replace(/^need (a |an |some )?/i, "")
    .replace(/^i need part/i, "")
    .replace(/^request part/i, "")
    .replace(/^add part/i, "")
    .replace(/^need part/i, "")
    .trim();

  const match = cleaned.match(/^([A-Za-z0-9\-_.\/]+)\s*(.*)$/);

  if (!match) return { partNumber: "", partDescription: cleaned || text };

  return {
    partNumber: match[1] || "",
    partDescription: match[2] || ""
  };
}

function answerGenericSpreadsheetRow(top) {
  const lines = [];

  for (const [key, value] of Object.entries(safeFields(top.fields || {}, 8))) {
    lines.push(key + ": " + value);
  }

  return lines.length ? lines.join("\n") : "I found a matching record, but it does not have enough clean fields to summarize clearly.";
}

function answerFromTopResults(query, results) {
  if (!results.length) {
    return (
      "I could not find that in the current JARVIS knowledge base.\n\n" +
      "I should not guess. Try giving me a part number, item name, ink color, machine/area, vendor, order clue, map location, or schedule keyword. If this still needs a human, call or text Jonathan."
    );
  }

  const top = results[0];

  if (top.type === "spreadsheet-row") {
    if (top.category === "03_INK_ROOM") return isInkInventoryRecord(top) ? answerInkInventoryRow(top) : answerGenericSpreadsheetRow(top);
    if (top.category === "01_PARTS_INVENTORY") return answerPartSearchResults(query, results);
    return answerGenericSpreadsheetRow(top);
  }

  if (top.type === "file") {
    return "I found the relevant file: " + top.title + linkLine(top) + "\n\nPlease verify the exact details in the file before relying on it.";
  }

  return makeExcerpt(top.body, query, 650);
}

function answerPoRequest() {
  const form = findPdfByName("po_request_form") || findPdfByName("po request form");

  let reply =
    "Here is the PO / POR request process:\n\n" +
    "1. Fill out the PO Request Form.\n" +
    "2. Attach the quote that supports the price used on the form.\n" +
    "3. Email the completed form and quote to POR-Richmond@wearemoore.com.\n\n" +
    "POR means Purchase Order Request / PO Request.\n\n" +
    "Important: JARVIS cannot approve purchases, create POs, or say something has been ordered unless the approved order records clearly confirm it.";

  if (form) reply += "\n\nBlank PO Request Form:\n" + form.url;

  return reply;
}

function answerPartOrderingProcess() {
  return (
    "If we do not have a part or supply item, JARVIS can help add it to Jonathan's Purchase Order Request list.\n\n" +
    "I need:\n" +
    "- Part/item name or number\n" +
    "- Description\n" +
    "- Quantity needed\n" +
    "- Machine or area\n" +
    "- Requested due date\n" +
    "- Any useful notes\n\n" +
    "Important: this does not mean the item is ordered yet. Jonathan still needs to review it."
  );
}

function getJonathanStatusDocument() {
  return findDocumentByName("JONATHAN_STATUS_AND_CONTACT") || findDocumentByName("jonathan status") || null;
}

function getJonathanPhoneNumber() {
  const doc = getJonathanStatusDocument();
  const body = doc?.body || "";

  const phoneMatch = body.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);

  if (phoneMatch) {
    const phone = normalize(phoneMatch[0]);
    if (!phone.includes("[") && !phone.toLowerCase().includes("enter")) return phone;
  }

  return JONATHAN_PHONE_FALLBACK;
}

function answerJonathanStatusQuestion(query) {
  const phone = getJonathanPhoneNumber();

  let reply =
    "Jonathan is leaving " + JONATHAN_AWAY_START + " and is expected back " + JONATHAN_RETURN + ".\n\n" +
    JONATHAN_TRAVEL_NOTE;

  if (phone) {
    reply += "\n\nFor routine questions, use JARVIS first. If JARVIS cannot help or the issue is urgent, Jonathan can be reached by call or text at " + phone + ".";
  } else {
    reply += "\n\nFor routine questions, use JARVIS first. If JARVIS cannot help, contact Jonathan when his contact number is available.";
  }

  if (!/(phone|number|contact|call|text|reach)/i.test(query)) {
    reply += "\n\nFor normal parts requests, PO/POR questions, inventory checks, ink questions, maps, and routine issues, JARVIS can help capture or answer the question here.";
  }

  return reply;
}

function answerWasteInkQuestion() {
  return (
    "Call Potomac Environmental for waste ink pickup.\n\n" +
    "Contact: Benjamin Kirby\n" +
    "Phone: 804-812-5161\n" +
    "Email: bkirby@potomacenv.com\n\n" +
    "We usually call when 6 or more waste ink totes are ready. Pickup is not automatic.\n\n" +
    "Before calling, count how many waste ink totes are ready. If storage is becoming a problem, call or text Jonathan."
  );
}

function answerVendorContactQuestion(query) {
  const q = lower(query);

  if (q.includes("crystal clean") || q.includes("heritage") || q.includes("parts washer") || q.includes("richard") || q.includes("rich hine")) {
    return (
      "Crystal Clean parts washer service:\n\n" +
      "Richard \"Rich\" Hinegardner\n" +
      "Phone: 847-836-5670\n" +
      "Cell: 804-400-6876\n\n" +
      "Text is okay for non-emergencies.\n" +
      "Emergency number: 800-424-9300"
    );
  }

  if (q.includes("potomac") || q.includes("waste ink")) return answerWasteInkQuestion();

  const results = searchKnowledge(query, {
    maxResults: 3,
    categories: ["03_INK_ROOM"],
    includeGuidance: true,
    minScore: 35
  });

  if (results.length) return makeExcerpt(results[0].body, query, 550);

  return "I could not find that vendor contact. Try the vendor name, service type, or call/text Jonathan if this is urgent.";
}

function answerHvacQuestion(query) {
  const serviceLog = findDocumentByName("HVAC_service_log") || findDocumentByName("HVAC service log");
  const q = lower(query);

  if (serviceLog) {
    return makeExcerpt(serviceLog.body, query, 900) + "\n\nIf this is urgent, production-impacting, or conditions are getting unsafe, call or text Jonathan.";
  }

  if (q.includes("james river") || q.includes("envelope") || q.includes("units down") || q.includes("unit down") || q.includes("ac") || q.includes("hvac")) {
    return (
      "Envelope Department HVAC note:\n\n" +
      "5 of the 6 main AC units over the envelope department are currently down. James River HVAC is scheduled to come out Monday, June 15, 2026 to diagnose and repair them.\n\n" +
      "If this is urgent, production-impacting, or conditions are getting unsafe, call or text Jonathan."
    );
  }

  return "I do not have a detailed HVAC service log loaded yet. Use the thermostat map for location questions, and call or text Jonathan if the issue is urgent or production-impacting.";
}

function answerMapQuestion(query) {
  const q = lower(query);

  if (q.includes("thermostat") || q.includes("temperature") || q.includes("turn the temperature") || q.includes("turn temperature")) {
    return (
      "Use the thermostat map below to find the thermostat for that area." +
      imageLine(HVAC_THERMOSTAT_IMAGE) +
      "\n\nIf the map is unclear, try the nearest labeled thermostat first. If this is urgent or affecting production, call or text Jonathan."
    );
  }

  if (q.includes("eyewash") || q.includes("eye wash")) {
    return (
      "Eye wash station locations are shown on the map below.\n\n" +
      "If this is an active chemical exposure or injury, follow emergency procedures and notify the on-shift supervisor immediately." +
      imageLine(EYEWASH_IMAGE)
    );
  }

  if (q.includes("fire extinguisher") || q.includes("extinguisher")) {
    return (
      "Fire extinguisher locations are shown on the map below.\n\n" +
      "If this is an active fire, smoke, or burning smell situation, follow emergency procedures and notify the on-shift supervisor immediately." +
      imageLine(FIRE_EXTINGUISHER_IMAGE)
    );
  }

  return "I can show maps for thermostat locations, eye wash stations, and fire extinguishers.";
}

function answerScheduleQuestion() {
  const scheduleFile = findPdfByName("2-2-3") || findPdfByName("schedule");

  return (
    "The 2-2-3 schedule is for day shift only and starts June 14, 2026. Night shift remains unchanged.\n\n" +
    "Use the schedule calendar PDF to check specific days." +
    (scheduleFile ? linkLine(scheduleFile) : "")
  );
}

function isWasteInkQuestion(msg) {
  const q = lower(msg);

  return (
    q.includes("potomac") ||
    q.includes("waste ink") ||
    q.includes("waste tote") ||
    q.includes("wastewater") ||
    q.includes("waste water") ||
    q.includes("used ink") ||
    q.includes("ink waste") ||
    q.includes("ink disposal") ||
    (
      q.includes("ink") &&
      (
        q.includes("pickup") ||
        q.includes("pick up") ||
        q.includes("picked up") ||
        q.includes("disposal") ||
        q.includes("dispose") ||
        q.includes("environmental") ||
        q.includes("who picks up") ||
        q.includes("who pick up")
      )
    )
  );
}

function isVendorContactQuestion(msg) {
  const q = lower(msg);
  const asksContact = q.includes("phone") || q.includes("number") || q.includes("cell") || q.includes("contact") || q.includes("who do i call") || q.includes("call") || q.includes("email");

  return asksContact && (
    q.includes("crystal clean") ||
    q.includes("heritage") ||
    q.includes("parts washer") ||
    q.includes("richard") ||
    q.includes("rich hine") ||
    q.includes("potomac") ||
    q.includes("waste ink")
  );
}

function isHvacQuestion(msg) {
  const q = lower(msg);

  return (
    q.includes("hvac") ||
    q.includes("a/c") ||
    q.includes(" ac ") ||
    q.startsWith("ac ") ||
    q.includes("air conditioning") ||
    q.includes("cooling") ||
    q.includes("james river") ||
    q.includes("service call") ||
    q.includes("service history") ||
    q.includes("units down") ||
    q.includes("unit down") ||
    q.includes("envelope ac") ||
    q.includes("envelope department ac")
  );
}

function isJonathanStatusQuestion(msg) {
  const q = lower(msg);

  return (
    (
      q.includes("jonathan") &&
      (
        q.includes("vacation") ||
        q.includes("back") ||
        q.includes("return") ||
        q.includes("leaving") ||
        q.includes("away") ||
        q.includes("out") ||
        q.includes("phone") ||
        q.includes("number") ||
        q.includes("contact") ||
        q.includes("call") ||
        q.includes("text") ||
        q.includes("reach")
      )
    ) ||
    q.includes("when is jonathan back") ||
    q.includes("when will jonathan be back") ||
    q.includes("how do i reach jonathan") ||
    q.includes("call jonathan") ||
    q.includes("text jonathan") ||
    q.includes("jonathan's number") ||
    q.includes("jonathan phone") ||
    q.includes("jonathan contact")
  );
}

function isCommonSupplyRequest(msg) {
  const q = normalizeLoose(msg);
  const startsLikeNeed = q.startsWith("i need ") || q.startsWith("need ") || q.startsWith("we need ") || q.startsWith("can i get ") || q.startsWith("where are ") || q.startsWith("where is ") || q.startsWith("do we have ");

  return startsLikeNeed && COMMON_SUPPLY_WORDS.some((word) => q.includes(word));
}

function isPurchaseOrderPolicyQuestion(msg) {
  const q = lower(msg);

  return (
    q.includes("po request") ||
    q.includes("por request") ||
    q.includes("purchase order request") ||
    q.includes("blank po") ||
    q.includes("blank por") ||
    q.includes("po form") ||
    q.includes("por form") ||
    q.includes("purchase order form") ||
    q.includes("por-richmond") ||
    q.includes("po process") ||
    q.includes("por process") ||
    q.includes("request a po") ||
    q.includes("request a por") ||
    q.includes("submit a po") ||
    q.includes("submit a por") ||
    q.includes("how do i request a po") ||
    q.includes("how do i request a por") ||
    (q.includes("request form") && (q.includes("po") || q.includes("por") || q.includes("purchase")))
  );
}

function isPartOrderingProcessQuestion(msg) {
  const q = lower(msg);

  return (
    (
      q.includes("how do i order") ||
      q.includes("how to order") ||
      q.includes("order a part") ||
      q.includes("part we dont have") ||
      q.includes("part we don't have") ||
      q.includes("need a part we dont have") ||
      q.includes("need a part we don't have") ||
      q.includes("request a part") ||
      q.includes("add a part")
    ) &&
    (q.includes("part") || q.includes("parts") || q.includes("bearing") || q.includes("item"))
  );
}

function isPartRequestStart(msg) {
  const q = lower(msg);

  return (
    q.startsWith("i need part") ||
    q.startsWith("need part") ||
    q.startsWith("request part") ||
    q.startsWith("add part")
  );
}

function isCancelIntent(msg) {
  const q = lower(msg);

  return ["cancel", "stop", "never mind", "nevermind", "start over", "new question", "clear", "reset", "no", "nope"].includes(q);
}

function isYesIntent(msg) {
  const q = lower(msg);

  return ["yes", "y", "yeah", "yep", "please", "please do", "do it", "go ahead"].includes(q) || q.includes("yes add") || q.includes("please add");
}

function isAddToPoIntent(msg) {
  const q = lower(msg);

  return ["add it", "add this", "add original part", "add to po request", "add to por", "add to por request"].includes(q) || q.includes("add original") || q.includes("add to po") || q.includes("add to jonathan");
}

function isWrongPartIntent(msg) {
  const q = lower(msg);

  return (
    q === "no" ||
    q === "nope" ||
    q.includes("not the right part") ||
    q.includes("wrong part") ||
    q.includes("not right") ||
    q.includes("not it") ||
    q.includes("not the same") ||
    q.includes("that is not") ||
    q.includes("that's not")
  );
}

function looksLikeDueDateOrUrgency(msg) {
  const q = lower(msg);

  if (
    q.includes("asap") ||
    q.includes("urgent") ||
    q.includes("today") ||
    q.includes("tomorrow") ||
    q.includes("this week") ||
    q.includes("next week") ||
    q.includes("within 2 weeks") ||
    q.includes("within two weeks") ||
    q.includes("next monday") ||
    q.includes("next tuesday") ||
    q.includes("next wednesday") ||
    q.includes("next thursday") ||
    q.includes("next friday") ||
    q.includes("next saturday") ||
    q.includes("next sunday")
  ) {
    return true;
  }

  return /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/.test(q) || /\b\d{4}-\d{2}-\d{2}\b/.test(q);
}

function looksLikeMachineOrArea(msg) {
  const q = lower(msg);

  if (/\b(102|202|627-1|627-2|627-3|6271|6272|6273)\b/.test(q)) return true;

  return (
    q.includes("wh1") ||
    q.includes("wh2") ||
    q.includes("wh3") ||
    q.includes("wh4") ||
    q.includes("warehouse") ||
    q.includes("ink room") ||
    q.includes("maintenance") ||
    q.includes("prepress") ||
    q.includes("pre-press") ||
    q.includes("mailshop") ||
    q.includes("shipping") ||
    q.includes("receiving") ||
    q.includes("safety") ||
    q.includes("office") ||
    q.includes("hvac") ||
    q.includes("envelope")
  );
}

function looksLikeNewQuestion(msg) {
  const q = lower(msg);

  if (q.includes("?")) return true;

  if (
    q.startsWith("where ") ||
    q.startsWith("what ") ||
    q.startsWith("who ") ||
    q.startsWith("when ") ||
    q.startsWith("how ") ||
    q.startsWith("do we ") ||
    q.startsWith("did ") ||
    q.startsWith("does ") ||
    q.startsWith("can ")
  ) {
    return true;
  }

  return (
    isPurchaseOrderPolicyQuestion(q) ||
    isWasteInkQuestion(q) ||
    isVendorContactQuestion(q) ||
    isJonathanStatusQuestion(q) ||
    isHvacQuestion(q) ||
    q.includes("ink") ||
    q.includes("thermostat") ||
    q.includes("temperature") ||
    q.includes("eyewash") ||
    q.includes("fire extinguisher")
  );
}

function classifyIntent(msg) {
  const q = lower(msg);

  if (q === "" || q === "help") return "help";
  if (isJonathanStatusQuestion(q)) return "jonathan_status";
  if (isVendorContactQuestion(q)) return "vendor_contact";
  if (isPurchaseOrderPolicyQuestion(q)) return "po_policy";
  if (isPartOrderingProcessQuestion(q)) return "part_ordering_process";
  if (isWasteInkQuestion(q)) return "waste_ink";
  if (isInkFormulaQuestion(q)) return "ink_formula";
  if (q.includes("ink") || q.includes("pantone") || q.includes("pms") || q.includes("drawdown") || q.includes("extender") || q.includes("inx")) return "ink";
  if (isPartRequestStart(q) || isCommonSupplyRequest(q)) return "part_request_start";
  if (q.includes("2-2-3") || q.includes("schedule") || q.includes("day shift") || q.includes("night shift")) return "schedule";
  if (q.includes("thermostat") || q.includes("temperature") || q.includes("eyewash") || q.includes("eye wash") || q.includes("fire extinguisher") || q.includes("extinguisher") || q.includes("map")) return "map";
  if (isHvacQuestion(q)) return "hvac";
  if (q.includes("ordered") || q.includes("open order") || q.includes("coming") || q.includes("received yet")) return "open_orders";
  if (q.includes("magna") || q.includes("motor") || q.includes("drive") || q.includes("rebuild")) return "magna";
  if (q.includes("warehouse 4") || q.includes("wh4") || q.includes("mailshop") || q.includes("building 4") || q.includes("stamper") || q.includes("fire jet")) return "mailshop";
  if (q.includes("forklift") || q.includes("certified") || q.includes("operator") || q.includes("certification") || q.includes("training")) return "safety";
  if (hasExplicitKnifeLanguage(q)) return "knives";
  if (looksLikePartNumber(q) || q.includes("do we have") || q.includes("where is") || q.includes("looking for") || q.includes("find") || q.includes("on hand") || q.includes("available") || q.includes("part")) return "parts_lookup";

  return "fallback";
}

function isHighPriorityDueDate(dueDateText) {
  const text = lower(dueDateText);

  if (["asap", "urgent", "today", "tomorrow", "this week", "next week", "within 2 weeks", "within two weeks", "down machine", "machine down", "cannot run", "production stopped"].some((phrase) => text.includes(phrase))) return true;

  const match = text.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (!match) return false;

  const now = new Date();
  let year = match[3] ? Number(match[3]) : now.getFullYear();
  if (year < 100) year += 2000;

  const due = new Date(year, Number(match[1]) - 1, Number(match[2]));

  return (due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24) <= 14;
}

async function sendTeamsAlert(message) {
  const teamsWebhook = process.env.TEAMS_WEBHOOK_URL;

  if (!teamsWebhook) return false;

  try {
    await fetch(teamsWebhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message })
    });

    return true;
  } catch (error) {
    console.error("Teams alert failed:", error);
    return false;
  }
}

async function writePartsRequestToSheet(request) {
  const webhookUrl = process.env.PARTS_REQUEST_WEBHOOK_URL;
  const secret = process.env.PARTS_REQUEST_SECRET;

  if (!webhookUrl || !secret) {
    return { ok: false, error: "Missing spreadsheet webhook configuration" };
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret, ...request })
  });

  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    return { ok: response.ok, raw: text };
  }
}

function startMissingPartRequestFromPending(from, pending, requesterName) {
  pendingRequests.set(from, {
    step: "awaiting_due_date",
    requesterName: pending.requesterName || requesterName || "",
    requesterPhone: from,
    partNumber: pending.partNumber || pending.originalQuery || "",
    partDescription: pending.partDescription || "",
    quantityRequested: "",
    notes: pending.originalQuery || pending.partNumber || ""
  });

  return (
    "Okay. I can add this to Jonathan's next Purchase Order Request list.\n\n" +
    "Item: " + (pending.partNumber || pending.originalQuery || "Not provided") + "\n" +
    "Description: " + (pending.partDescription || "Not provided") + "\n\n" +
    "What requested due date should I use?" +
    dueDateButtons() +
    "\n\nYou can also type your own date, like 6/20 or next Friday.\n\n" +
    "Type cancel if you do not want to create this request."
  );
}

async function handlePendingRequest({ pending, from, cleanBody, requesterName }) {
  const msg = lower(cleanBody);

  if (pending.step === "awaiting_formula_batch_size") {
    if (isCancelIntent(msg)) {
      pendingRequests.delete(from);
      return "Okay — I canceled that ink formula request. What can I help you with?";
    }

    const batch = extractBatchSizePounds(cleanBody);

    if (batch && batch > 0) {
      pendingRequests.delete(from);
      return answerCalculatedInkFormula(pending.inkNumber, batch);
    }

    if (looksLikeNewQuestion(cleanBody) && !lower(cleanBody).match(/\b\d+(?:\.\d+)?\s*(?:lb|lbs|pound|pounds)\b/)) {
      pendingRequests.delete(from);
      return "I cleared the pending ink formula amount and answered your new question instead.\n\n" + await getJarvisReply({ from, body: cleanBody, requesterName });
    }

    return "How many pounds do you want to make?" + formulaBatchButtons() + "\n\nYou can also type another amount, like 12 lb.";
  }

  if (pending.step === "possible_part_match") {
    if (isAddToPoIntent(msg)) return startMissingPartRequestFromPending(from, pending, requesterName);

    if (isWrongPartIntent(msg)) {
      pendingRequests.set(from, {
        ...pending,
        step: "confirm_add_missing_part"
      });

      return (
        "Got it. I will treat the original item as not found:\n\n" +
        (pending.partNumber || pending.originalQuery || "Original item not provided") +
        "\n\nWould you like me to add it to Jonathan's Purchase Order Request list?" +
        addMissingPartButtons()
      );
    }

    if (isYesIntent(msg)) {
      pendingRequests.delete(from);
      return "Okay — please physically verify that possible match before relying on it for production. What can I help you with next?";
    }

    if (isCancelIntent(msg)) {
      pendingRequests.delete(from);
      return "Okay — I cleared that possible match. What can I help you with?";
    }

    if (looksLikeNewQuestion(cleanBody)) {
      pendingRequests.delete(from);
      return "I cleared the previous possible match and answered your new question instead.\n\n" + await getJarvisReply({ from, body: cleanBody, requesterName });
    }

    return "I need to know whether that possible match is correct first." + partMatchButtons();
  }

  if (pending.step === "confirm_add_missing_part") {
    if (isYesIntent(msg) || isAddToPoIntent(msg)) return startMissingPartRequestFromPending(from, pending, requesterName);

    if (isCancelIntent(msg)) {
      pendingRequests.delete(from);
      return "Okay — I will not add that request. What can I help you with?";
    }

    if (looksLikeNewQuestion(cleanBody)) {
      pendingRequests.delete(from);
      return "I cleared the pending add-item offer and answered your new question instead.\n\n" + await getJarvisReply({ from, body: cleanBody, requesterName });
    }

    return "Please choose whether to add the missing item to Jonathan's Purchase Order Request list." + addMissingPartButtons();
  }

  if (isCancelIntent(msg)) {
    pendingRequests.delete(from);
    return "Okay — I canceled the pending request. What can I help you with?";
  }

  if (requesterName) pending.requesterName = requesterName;

  if (pending.step === "awaiting_due_date") {
    if (looksLikeDueDateOrUrgency(cleanBody)) {
      pending.requestedDueDate = cleanBody;
      pending.step = "awaiting_machine";
      pendingRequests.set(from, pending);

      return "Got it. What machine or area is this item for?" + machineAreaButtons() + "\n\nYou can also type another machine or area.";
    }

    if (looksLikeNewQuestion(cleanBody)) {
      pendingRequests.delete(from);
      return "I paused the pending request and answered your new question instead.\n\n" + await getJarvisReply({ from, body: cleanBody, requesterName });
    }

    return (
      "I am waiting for the requested due date for the pending request." +
      dueDateButtons() +
      "\n\nYou can also type something like 6/20, next Friday, ASAP, today, tomorrow, or within 2 weeks.\n\n" +
      "Or type cancel to stop this request."
    );
  }

  if (pending.step === "awaiting_machine") {
    if (looksLikeNewQuestion(cleanBody)) {
      pendingRequests.delete(from);
      return "I paused the pending request and answered your new question instead.\n\n" + await getJarvisReply({ from, body: cleanBody, requesterName });
    }

    if (!looksLikeMachineOrArea(cleanBody)) {
      return (
        "I am waiting for the machine or area for the pending request." +
        machineAreaButtons() +
        "\n\nYou can also type another machine or area.\n\n" +
        "Or type cancel to stop this request."
      );
    }

    pending.machineOrArea = cleanBody;

    const priority = isHighPriorityDueDate(pending.requestedDueDate) ? "High" : "Normal";
    let jonathanNotified = "No";

    if (priority === "High") {
      const alertSent = await sendTeamsAlert(
        "🚨 *JARVIS HIGH PRIORITY REQUEST*\n\n" +
        "Requester: " + (pending.requesterName || "Not provided") + "\n" +
        "Requester ID: " + from + "\n" +
        "Machine / Area: " + pending.machineOrArea + "\n" +
        "Item: " + (pending.partNumber || "Not provided") + "\n" +
        "Description: " + (pending.partDescription || "Not provided") + "\n" +
        "Requested Due Date: " + pending.requestedDueDate + "\n\n" +
        "Status: Added to JARVIS Parts Requests.\n\n" +
        "Important: This is not ordered yet. Jonathan still needs to review it."
      );

      jonathanNotified = alertSent ? "Yes" : "Alert Failed";
    }

    const sheetRequest = {
      requesterName: pending.requesterName || requesterName || "",
      requesterPhone: from,
      machineOrArea: pending.machineOrArea,
      partNumber: pending.partNumber,
      partDescription: pending.partDescription,
      quantityRequested: pending.quantityRequested || "",
      requestedDueDate: pending.requestedDueDate,
      priority,
      notes: pending.notes || "",
      status: "New",
      jonathanNotified
    };

    let sheetResult;

    try {
      sheetResult = await writePartsRequestToSheet(sheetRequest);
    } catch (error) {
      console.error("Failed to write parts request to sheet:", error);
      sheetResult = { ok: false, error: error.toString() };
    }

    pendingRequests.delete(from);

    if (!sheetResult.ok) {
      return (
        "I captured the request, but I could not write it to the shared spreadsheet.\n\n" +
        "Item: " + sheetRequest.partNumber + "\n" +
        "Description: " + sheetRequest.partDescription + "\n" +
        "Requested Due Date: " + sheetRequest.requestedDueDate + "\n" +
        "Machine / Area: " + sheetRequest.machineOrArea + "\n\n" +
        "Jonathan needs to check the JARVIS logs.\n\n" +
        "Important: This is not ordered yet."
      );
    }

    let reply =
      "Added to Jonathan's Purchase Order Request list.\n\n" +
      "Item: " + (sheetRequest.partNumber || "Not provided") + "\n" +
      "Description: " + (sheetRequest.partDescription || "Not provided") + "\n" +
      "Requested Due Date: " + sheetRequest.requestedDueDate + "\n" +
      "Machine / Area: " + sheetRequest.machineOrArea + "\n" +
      "Priority: " + priority + "\n\n" +
      "Important: This is not ordered yet. Jonathan still needs to review it.";

    if (priority === "High") {
      reply += "\n\nThis was marked HIGH priority because the requested due date appears to be within 2 weeks or urgent. Jonathan has been notified.";
    }

    return reply;
  }

  return null;
}

async function startPartRequest({ from, cleanBody, requesterName }) {
  const info = extractSimplePartInfo(cleanBody);
  const partNumber = info.partNumber || extractCandidatePartNumber(cleanBody) || cleanBody;

  const lookupResults = searchKnowledge(partNumber || cleanBody, {
    maxResults: 3,
    categories: ["01_PARTS_INVENTORY"],
    minScore: looksLikePartNumber(partNumber) ? 55 : 35
  });

  if (lookupResults.length) {
    const confidence = getPartMatchConfidence(partNumber || cleanBody, lookupResults[0]);

    if (confidence !== "exact") {
      pendingRequests.set(from, {
        step: "possible_part_match",
        requesterName,
        requesterPhone: from,
        partNumber: partNumber || info.partNumber,
        partDescription: info.partDescription || "",
        originalQuery: cleanBody,
        possibleMatchSummary: answerPartsRow(lookupResults[0])
      });

      return answerPartSearchResults(partNumber || cleanBody, lookupResults, { includeButtons: true });
    }

    pendingRequests.set(from, {
      step: "confirm_add_missing_part",
      requesterName,
      requesterPhone: from,
      partNumber: partNumber || info.partNumber,
      partDescription: info.partDescription || "",
      originalQuery: cleanBody
    });

    return (
      "I found an exact match in inventory:\n\n" +
      answerPartsRow(lookupResults[0]) +
      "\n\nIf you still need this added to Jonathan's PO request list, choose Add to PO request." +
      addMissingPartButtons()
    );
  }

  pendingRequests.set(from, {
    step: "confirm_add_missing_part",
    requesterName,
    requesterPhone: from,
    partNumber: partNumber || info.partNumber,
    partDescription: info.partDescription || "",
    originalQuery: cleanBody
  });

  return (
    "I could not find that item in the current JARVIS parts/supplies inventory.\n\n" +
    "Would you like me to add it to Jonathan's Purchase Order Request list?" +
    addMissingPartButtons()
  );
}

async function getJarvisReply({ from = "browser-test", body = "", requesterName = "" }) {
  const cleanBody = normalize(body);
  const msg = lower(cleanBody);

  if (knowledgeLoadError) {
    return "JARVIS had a problem loading the knowledge base. Jonathan needs to check the Render logs.";
  }

  const pending = pendingRequests.get(from);
  if (pending) {
    const pendingReply = await handlePendingRequest({ pending, from, cleanBody, requesterName });
    if (pendingReply) return pendingReply;
  }

  const intent = classifyIntent(msg);

  switch (intent) {
    case "help":
      return (
        "What can I help you with?\n\n" +
        "You can ask about parts/supplies, ink, ink formulas, waste ink pickup, vendor phone numbers, Jonathan's vacation/contact info, HVAC service calls, thermostats/maps, knives, PO/POR requests, Magna rebuilds, Warehouse 4 mailshop equipment, safety training, or the 2-2-3 schedule.\n\n" +
        "Knowledge base records loaded: " + knowledgeRecords.length + "."
      );

    case "jonathan_status":
      return answerJonathanStatusQuestion(cleanBody);

    case "vendor_contact":
      return answerVendorContactQuestion(cleanBody);

    case "po_policy":
      return answerPoRequest();

    case "part_ordering_process":
      return answerPartOrderingProcess();

    case "part_request_start":
      return startPartRequest({ from, cleanBody, requesterName });

    case "schedule":
      return answerScheduleQuestion(cleanBody);

    case "map":
      return answerMapQuestion(cleanBody);

    case "hvac":
      return answerHvacQuestion(cleanBody);

    case "waste_ink":
      return answerWasteInkQuestion(cleanBody);

    case "ink_formula":
      return answerInkFormulaQuestion(cleanBody, { from, requesterName });

    case "ink":
      return answerInkQuestion(cleanBody);

    case "parts_lookup":
      return answerPartsLookup(cleanBody, { from, requesterName });

    case "open_orders":
      return answerFromTopResults(cleanBody, searchKnowledge(cleanBody, { maxResults: 6, categories: ["02_OPEN_ORDERS"], minScore: 35 }));

    case "magna":
      return answerFromTopResults(cleanBody, searchKnowledge(cleanBody, { maxResults: 6, categories: ["07_MAGNA_REBUILDS"], minScore: 35 }));

    case "knives":
      return answerFromTopResults(cleanBody, searchKnowledge(cleanBody, { maxResults: 6, categories: ["05_KNIVES"], minScore: 50 }));

    case "mailshop":
      return answerFromTopResults(cleanBody, searchKnowledge(cleanBody, { maxResults: 6, categories: ["08_MAILSHOP_EQUIPMENT_OUTGOING"], minScore: 35 }));

    case "safety":
      return answerFromTopResults(cleanBody, searchKnowledge(cleanBody, { maxResults: 6, categories: ["10_SAFETY_TRAINING"], minScore: 35 }));

    default: {
      const results = searchKnowledge(cleanBody, { maxResults: 5, minScore: 50 });

      if (results.length) return answerFromTopResults(cleanBody, results);

      return (
        "I received your question:\n\n" +
        "\"" + cleanBody + "\"\n\n" +
        "I do not have enough information loaded to answer that confidently yet.\n\n" +
        "I should not guess. Try asking with a part number, item name, ink color, machine/area, vendor, order clue, map location, or schedule keyword. If this still needs a human, call or text Jonathan."
      );
    }
  }
}

function getAskPageHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>J.A.R.V.I.S.</title>
  <style>
    :root { --blue:#123a63; --blue2:#0f2f52; --dark:#1f2933; --border:#d6dee8; --green:#ecfdf3; --green-border:#a6d9b7; --button:#eef6ff; --button-border:#9cc4e8; }
    * { box-sizing:border-box; }
    html, body { height:100%; margin:0; font-family:Arial, Helvetica, sans-serif; background:#f6f9fc; color:var(--dark); }
    body { overflow:hidden; }
    .app { height:100dvh; max-width:860px; margin:0 auto; background:white; display:flex; flex-direction:column; border-left:1px solid var(--border); border-right:1px solid var(--border); }
    .header { flex:0 0 auto; background:linear-gradient(135deg, var(--blue), var(--blue2)); color:white; padding:15px 16px 13px; box-shadow:0 2px 10px rgba(15,23,42,0.18); z-index:2; text-align:center; }
    .header h1 { margin:0; font-size:30px; letter-spacing:3px; line-height:1; }
    .header p { margin:6px 0 0; font-size:12px; opacity:.95; }
    .version { margin-top:5px; font-size:11px; opacity:.75; }
    .chat { flex:1 1 auto; overflow-y:auto; padding:16px 14px; background:radial-gradient(circle at top left, rgba(18,58,99,.06), transparent 35%), #f7f9fc; }
    .bubble-wrap { display:flex; margin:10px 0; }
    .user-wrap { justify-content:flex-end; }
    .jarvis-wrap { justify-content:flex-start; }
    .bubble { max-width:82%; white-space:pre-wrap; line-height:1.42; border-radius:18px; padding:12px 14px; font-size:16px; box-shadow:0 1px 4px rgba(15,23,42,.06); }
    .user { background:var(--blue); color:white; border-bottom-right-radius:6px; }
    .jarvis { background:white; border:1px solid var(--border); border-bottom-left-radius:6px; }
    .system { background:var(--green); border:1px solid var(--green-border); border-bottom-left-radius:6px; }
    .chat-image { display:block; max-width:100%; height:auto; margin:10px 0 4px; border:1px solid var(--border); border-radius:12px; background:white; cursor:zoom-in; }
    .image-caption { display:block; font-size:12px; color:#64748b; margin-top:4px; }
    .quick-button { display:block; width:100%; text-align:left; margin:7px 0 0; padding:12px 13px; font-size:15px; font-weight:bold; color:var(--blue2); background:var(--button); border:1px solid var(--button-border); border-radius:12px; cursor:pointer; }
    .quick-button:hover { background:#dff0ff; }
    .quick-button:disabled { opacity:.55; cursor:default; }
    .composer { flex:0 0 auto; background:white; border-top:1px solid var(--border); padding:10px; box-shadow:0 -2px 10px rgba(15,23,42,.06); }
    .name-row { display:flex; gap:8px; margin-bottom:8px; }
    .name-row input { width:100%; border:1px solid var(--border); border-radius:12px; padding:10px 12px; font-size:15px; }
    .input-row { display:flex; gap:8px; align-items:flex-end; }
    textarea { flex:1 1 auto; min-height:48px; max-height:120px; resize:none; border:1px solid var(--border); border-radius:16px; padding:12px; font-size:16px; font-family:Arial, Helvetica, sans-serif; line-height:1.3; }
    .send { flex:0 0 auto; background:var(--blue); color:white; border:none; border-radius:16px; padding:13px 17px; font-size:16px; font-weight:bold; cursor:pointer; min-height:48px; }
    .send:disabled { background:#8aa0b7; cursor:wait; }
    .examples { font-size:12px; color:#64748b; margin-top:7px; line-height:1.35; text-align:center; }
    .fine-print { font-size:11px; color:#64748b; margin-top:6px; text-align:center; }
    @media (max-width:560px) {
      .app{border-left:none;border-right:none;}
      .header h1{font-size:26px;}
      .bubble{max-width:90%;font-size:15px;}
      .header{padding:13px 12px 10px;}
      .chat{padding:12px 10px;}
      .composer{padding:9px;}
      .send{padding-left:14px;padding-right:14px;}
    }
  </style>
</head>
<body>
  <div class="app">
    <header class="header">
      <h1>J.A.R.V.I.S.</h1>
      <p>Jonathan's Automated Resource &amp; Virtual Information System</p>
      <div class="version">v${APP_VERSION}</div>
    </header>

    <main id="chat" class="chat"></main>

    <footer class="composer">
      <div class="name-row">
        <input id="name" placeholder="Your name, example: Joe" autocomplete="name" />
      </div>

      <div class="input-row">
        <textarea id="question" placeholder="Ask JARVIS like you would ask Jonathan..."></textarea>
        <button id="askButton" class="send" type="button" onclick="askJarvis()">Ask</button>
      </div>

      <div class="examples">Examples: “make 10 lb of ink 186” • “i need AA batteries” • “what is Crystal Clean's number?”</div>
      <div class="fine-print">Parts requests are not ordered until Jonathan reviews them. JARVIS answers from the current knowledge snapshot.</div>
    </footer>
  </div>

  <script>
    function getSessionId() {
      let id = localStorage.getItem("jarvisSessionId");

      if (!id) {
        id = window.crypto && crypto.randomUUID ? crypto.randomUUID() : "session-" + Date.now() + "-" + Math.random().toString(16).slice(2);
        localStorage.setItem("jarvisSessionId", id);
      }

      return id;
    }

    function scrollChatToBottom() {
      const chat = document.getElementById("chat");
      chat.scrollTop = chat.scrollHeight;
    }

    function isSafeImagePath(src) {
      return /^\\/kb\\/.+\\.(png|jpg|jpeg|webp)$/i.test(src);
    }

    function disableButtonsNear(button) {
      const bubble = button.closest(".bubble");
      if (!bubble) return;

      bubble.querySelectorAll(".quick-button").forEach(function(btn) {
        btn.disabled = true;
      });
    }

    function renderMessageContent(container, text) {
      const lines = String(text).split("\\n");

      lines.forEach(function(line, index) {
        const trimmed = line.trim();
        const imageMatch = trimmed.match(/^\\[image:(\\/kb\\/[^\\]]+\\.(?:png|jpg|jpeg|webp))\\]$/i);
        const buttonMatch = trimmed.match(/^\\[button:([^|\\]]+)\\|([^\\]]+)\\]$/i);

        if (imageMatch && isSafeImagePath(imageMatch[1])) {
          const image = document.createElement("img");
          image.className = "chat-image";
          image.src = imageMatch[1];
          image.alt = "JARVIS map image";
          image.loading = "lazy";
          image.onclick = function() { window.open(image.src, "_blank"); };
          image.onerror = function() { image.replaceWith(document.createTextNode("Map image could not load: " + imageMatch[1])); };

          container.appendChild(image);

          const caption = document.createElement("span");
          caption.className = "image-caption";
          caption.textContent = "Tap/click the map to open it larger.";
          container.appendChild(caption);
        } else if (buttonMatch) {
          const value = buttonMatch[1].trim();
          const label = buttonMatch[2].trim();

          const button = document.createElement("button");
          button.className = "quick-button";
          button.type = "button";
          button.textContent = label;
          button.onclick = function() {
            disableButtonsNear(button);
            sendJarvisQuestion(value, label);
          };

          container.appendChild(button);
        } else {
          container.appendChild(document.createTextNode(line));
        }

        if (index < lines.length - 1) container.appendChild(document.createElement("br"));
      });
    }

    function addMessage(text, type) {
      const chat = document.getElementById("chat");

      const wrap = document.createElement("div");
      wrap.className = "bubble-wrap " + (type === "user" ? "user-wrap" : "jarvis-wrap");

      const bubble = document.createElement("div");
      bubble.className = "bubble " + type;

      renderMessageContent(bubble, String(text));

      wrap.appendChild(bubble);
      chat.appendChild(wrap);

      scrollChatToBottom();
    }

    async function sendJarvisQuestion(question, displayText) {
      const nameInput = document.getElementById("name");
      const button = document.getElementById("askButton");

      const name = nameInput.value.trim();
      const textToSend = String(question || "").trim();
      const textToShow = String(displayText || question || "").trim();

      if (!textToSend) return;

      localStorage.setItem("jarvisName", name);

      button.disabled = true;
      button.textContent = "...";

      addMessage(textToShow, "user");

      try {
        const response = await fetch("/api/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: getSessionId(), name, question: textToSend })
        });

        const data = await response.json();

        if (!response.ok) throw new Error(data.error || "Request failed");

        addMessage(data.reply, "jarvis");
      } catch (error) {
        addMessage("I had a problem answering that. Jonathan needs to check the JARVIS logs. Error: " + error.message, "system");
      } finally {
        button.disabled = false;
        button.textContent = "Ask";
        document.getElementById("question").focus();
        scrollChatToBottom();
      }
    }

    async function askJarvis() {
      const questionInput = document.getElementById("question");
      const question = questionInput.value.trim();

      if (!question) {
        questionInput.focus();
        return;
      }

      questionInput.value = "";
      await sendJarvisQuestion(question, question);
    }

    document.addEventListener("DOMContentLoaded", function() {
      const savedName = localStorage.getItem("jarvisName");
      if (savedName) document.getElementById("name").value = savedName;

      addMessage("What can I help you with?", "system");

      document.getElementById("question").addEventListener("keydown", function(event) {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          askJarvis();
        }
      });

      document.getElementById("question").focus();
    });
  </script>
</body>
</html>`;
}

app.use("/kb", express.static(DATA_ROOT));

app.get("/", (_req, res) => res.redirect("/ask"));

app.get("/ask", (_req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.type("html").send(getAskPageHtml());
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: !knowledgeLoadError,
    status: "J.A.R.V.I.S. online.",
    version: APP_VERSION,
    recordsLoaded: knowledgeRecords.length,
    loadedAt: knowledgeLoadedAt,
    dataRoot: fs.existsSync(DATA_ROOT) ? "found" : "missing",
    error: knowledgeLoadError ? knowledgeLoadError.toString() : null
  });
});

app.get("/kb-status", (_req, res) => {
  const counts = {};

  for (const record of knowledgeRecords) {
    counts[record.category] = (counts[record.category] || 0) + 1;
  }

  res.json({
    ok: !knowledgeLoadError,
    version: APP_VERSION,
    recordsLoaded: knowledgeRecords.length,
    loadedAt: knowledgeLoadedAt,
    counts,
    error: knowledgeLoadError ? knowledgeLoadError.toString() : null
  });
});

app.get("/reload-kb", (_req, res) => {
  loadKnowledgeBase();
  res.redirect("/kb-status");
});

app.post("/api/ask", async (req, res) => {
  try {
    const sessionId = normalize(req.body.sessionId) || "web-unknown";
    const name = normalize(req.body.name);
    const question = normalize(req.body.question);

    if (!question) {
      return res.status(400).json({ ok: false, error: "Missing question" });
    }

    const from = "web:" + sessionId;

    console.log("Web question received:", { from, name, question });

    const reply = await getJarvisReply({
      from,
      body: question,
      requesterName: name
    });

    res.json({
      ok: true,
      reply,
      version: APP_VERSION
    });
  } catch (error) {
    console.error("Web ask error:", error);

    res.status(500).json({
      ok: false,
      error: error.toString()
    });
  }
});

app.get("/test", async (req, res) => {
  const reply = await getJarvisReply({
    from: req.query.from || "browser-test",
    body: req.query.body || "HELP",
    requesterName: req.query.name || ""
  });

  res.type("text/plain").send(reply);
});

app.post("/sms", async (req, res) => {
  try {
    const from = req.body.From || "";
    const body = req.body.Body || "";
    const city = req.body.FromCity || "";
    const state = req.body.FromState || "";

    const reply = await getJarvisReply({
      from,
      body,
      requesterName: ""
    });

    const teamsWebhook = process.env.TEAMS_WEBHOOK_URL;

    if (teamsWebhook) {
      try {
        await fetch(teamsWebhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text:
              "🤖 *J.A.R.V.I.S. SMS*\n" +
              "**From:** " + from + " (" + city + ", " + state + ")\n" +
              "**Message:** " + body + "\n\n" +
              "**JARVIS Reply:** " + reply
          })
        });
      } catch (teamsError) {
        console.error("Teams webhook failed:", teamsError);
      }
    }

    const twiml = new Twiml.MessagingResponse();
    twiml.message(reply);

    res.type("text/xml").send(twiml.toString());
  } catch (e) {
    console.error("JARVIS SMS handler error:", e);

    const twiml = new Twiml.MessagingResponse();
    twiml.message("J.A.R.V.I.S. had an internal error while processing that message. Jonathan needs to check the logs.");

    res.type("text/xml").send(twiml.toString());
  }
});

loadKnowledgeBase();

const port = process.env.PORT || 3001;

app.listen(port, () => {
  console.log("J.A.R.V.I.S. v" + APP_VERSION + " listening on " + port);
});
