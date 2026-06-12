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

const DATA_ROOT = path.join(__dirname, "data", "JARVIS_DATA_FINAL_2026-06-XX");
const pendingRequests = new Map();

let knowledgeRecords = [];
let knowledgeLoadedAt = null;
let knowledgeLoadError = null;

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

const CATEGORY_HINTS = [
  { category: "01_PARTS_INVENTORY", terms: ["part", "parts", "bearing", "bin", "inventory", "stock", "do we have", "on hand", "available"] },
  { category: "02_OPEN_ORDERS", terms: ["ordered", "order", "po", "purchase", "delivery", "received", "vendor", "open order", "coming"] },
  { category: "03_INK_ROOM", terms: ["ink", "pantone", "pms", "formula", "drawdown", "extender", "inx", "anilox", "waste tote", "color"] },
  { category: "04_HVAC_AND_BUILDING", terms: ["hvac", "ac", "air conditioning", "thermostat", "cooling", "heat", "pre-press", "prepress"] },
  { category: "05_KNIVES", terms: ["knife", "knives", "cutoff", "cut-off", "profile", "side knife", "sharpen", "sharpening"] },
  { category: "06_PURCHASING_PO_REQUESTS", terms: ["po request", "por request", "purchase order request", "blank po", "po form", "por form", "por-richmond"] },
  { category: "07_MAGNA_REBUILDS", terms: ["magna", "motor", "drive", "rebuild", "repair", "quote"] },
  { category: "08_MAILSHOP_EQUIPMENT_OUTGOING", terms: ["mailshop", "warehouse 4", "wh4", "building 4", "folder", "stamper", "fire jet", "pickup", "picked up"] },
  { category: "09_MAPS", terms: ["map", "where", "eyewash", "eye wash", "fire extinguisher", "extinguisher", "thermostat"] },
  { category: "10_SAFETY_TRAINING", terms: ["safety", "training", "forklift", "certified", "operator", "certification", "clamp truck"] },
  { category: "11_2-2-3_Schedule", terms: ["2-2-3", "schedule", "dayshift", "day shift", "nightshift", "night shift", "calendar"] }
];

const SEARCH_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "could", "do", "does",
  "for", "from", "have", "how", "i", "in", "is", "it", "me", "need", "of", "on",
  "or", "our", "please", "send", "the", "there", "this", "to", "we", "what",
  "when", "where", "who", "with", "you"
]);

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
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
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
  const normalizedText = normalizeLoose(text);
  const searchKeys = new Set(extractSearchKeys(text));

  if (record.fields) {
    for (const [key, value] of Object.entries(record.fields)) {
      const k = lower(key);
      if (/(part|item|number|model|serial|quote|knife|color|pantone|pms|machine|id)/.test(k)) {
        for (const searchKey of extractSearchKeys(value)) searchKeys.add(searchKey);
      }
    }
  }

  knowledgeRecords.push({
    ...record,
    normalizedText,
    searchKeys: [...searchKeys]
  });
}

function loadMarkdownFile(filePath) {
  const body = fs.readFileSync(filePath, "utf8");

  addKnowledgeRecord({
    type: "document",
    category: categoryFromFile(filePath),
    title: titleFromFile(filePath),
    sourceFile: relativeDataPath(filePath),
    url: publicKbUrl(filePath),
    body
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

    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });

    rows.forEach((row, index) => {
      const fields = {};

      for (const [key, value] of Object.entries(row)) {
        const cleanKey = normalize(key);
        const cleanValue = cleanCellValue(value);

        if (!cleanKey || cleanKey.startsWith("__EMPTY")) continue;
        fields[cleanKey] = cleanValue;
      }

      const nonEmptyValues = Object.values(fields).filter((value) => normalize(value)).length;
      if (nonEmptyValues === 0) return;

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
    body: `${titleFromFile(filePath)} PDF reference document. Use category notes for how to interpret this file.`
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
        console.error(`Failed to load ${rel}:`, error);

        addKnowledgeRecord({
          type: "load-error",
          category: categoryFromFile(filePath),
          title: titleFromFile(filePath),
          sourceFile: relativeDataPath(filePath),
          url: publicKbUrl(filePath),
          body: `This file could not be loaded: ${error.message}`
        });
      }
    }

    knowledgeLoadedAt = new Date();
    console.log(`JARVIS knowledge loaded: ${knowledgeRecords.length} records from ${files.length} files.`);
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

function hasExplicitKnifeLanguage(query) {
  const q = lower(query);

  return (
    q.includes("knife") ||
    q.includes("knives") ||
    q.includes("profile knife") ||
    q.includes("profile knives") ||
    q.includes("side knife") ||
    q.includes("side knives") ||
    q.includes("cutoff knife") ||
    q.includes("cut-off knife") ||
    q.includes("cut off knife") ||
    q.includes("straight cutoff") ||
    q.includes("straight cut-off") ||
    q.includes("straight cut off") ||
    q.includes("sharpen") ||
    q.includes("sharpening")
  );
}

function looksLikePartNumber(query) {
  const q = normalize(query);
  if (!q) return false;

  const tokens = q.match(/[A-Za-z0-9][A-Za-z0-9._\-/]{1,}[A-Za-z0-9]/g) || [];

  for (const token of tokens) {
    const normalized = normalizePart(token);
    if (normalized.length < 3) continue;

    const hasLetter = /[A-Z]/.test(normalized);
    const hasDigit = /\d/.test(normalized);
    const hasSeparator = /[._\-/]/.test(token);

    if (hasLetter && hasDigit) return true;
    if (hasSeparator && hasDigit && normalized.length >= 4) return true;
  }

  const lowerQ = lower(query);

  if (/\b\d{3,6}\s*(zz|z|rs|c3|c4|2rs|rsr|llu|llb)\b/i.test(lowerQ)) return true;
  if (/\b(k|v|p|m|a|b|c|d|db|wd|w)\s*\.?\s*\d{2,}[\d.a-z\-\/]*\b/i.test(lowerQ)) return true;

  return false;
}

function extractCandidatePartNumber(query) {
  const tokens = normalize(query).match(/[A-Za-z0-9][A-Za-z0-9._\-/]{1,}[A-Za-z0-9]/g) || [];

  for (const token of tokens) {
    const normalized = normalizePart(token);
    if (normalized.length < 3) continue;

    const hasLetter = /[A-Z]/.test(normalized);
    const hasDigit = /\d/.test(normalized);
    const hasSeparator = /[._\-/]/.test(token);

    if ((hasLetter && hasDigit) || (hasSeparator && hasDigit)) return token;
  }

  return "";
}

function categoriesForQuery(query) {
  const q = lower(query);
  const categories = new Set();

  for (const hint of CATEGORY_HINTS) {
    if (hint.terms.some((term) => q.includes(term))) categories.add(hint.category);
  }

  if (looksLikePartNumber(q) && !hasExplicitKnifeLanguage(q)) categories.add("01_PARTS_INVENTORY");

  if (q.includes("where") || q.includes("thermostat") || q.includes("eyewash") || q.includes("fire extinguisher")) {
    categories.add("09_MAPS");
  }

  if (q.includes("ink") || q.includes("pms") || q.includes("pantone")) categories.add("03_INK_ROOM");

  if (q.includes("po") || q.includes("por") || q.includes("ordered") || q.includes("order")) {
    categories.add("02_OPEN_ORDERS");
    categories.add("06_PURCHASING_PO_REQUESTS");
  }

  return [...categories];
}

function categoryBoost(query, category) {
  const q = lower(query);
  let boost = 0;

  for (const hint of CATEGORY_HINTS) {
    if (hint.category !== category) continue;
    for (const term of hint.terms) {
      if (q.includes(term)) boost += 15;
    }
  }

  if (category === "01_PARTS_INVENTORY" && looksLikePartNumber(query) && !hasExplicitKnifeLanguage(query)) boost += 60;
  if (category === "05_KNIVES" && !hasExplicitKnifeLanguage(query)) boost -= 80;

  return boost;
}

function scoreRecord(record, query) {
  const qLoose = normalizeLoose(query);
  const terms = qLoose
    .split(" ")
    .filter((term) => term.length >= 2 && !SEARCH_STOPWORDS.has(term));

  const queryKeys = extractSearchKeys(query);
  const queryDigits = [...new Set(queryKeys.map((key) => digitsOnly(key)).filter((key) => key.length >= 3))];

  let score = categoryBoost(query, record.category);
  const reason = [];

  if (!qLoose) return { score: 0, reason };

  if (isGuidanceRecord(record)) score -= 35;

  if (record.normalizedText.includes(qLoose)) {
    score += 75;
    reason.push("phrase match");
  }

  let matchedTerms = 0;

  for (const term of terms) {
    if (record.normalizedText.includes(term)) matchedTerms += 1;
  }

  if (matchedTerms > 0) {
    score += matchedTerms * 8;
    if (matchedTerms === terms.length) score += 20;
    reason.push(`${matchedTerms} term match`);
  }

  for (const queryKey of queryKeys) {
    for (const recordKey of record.searchKeys || []) {
      if (recordKey === queryKey) {
        score += 120;
        reason.push("exact normalized key match");
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
          reason.push("strong partial key match");
        } else {
          const maxLen = Math.max(queryKey.length, recordKey.length);
          const distance = levenshtein(recordKey, queryKey);
          const limit = maxLen <= 6 ? 1 : 2;

          if (distance <= limit) {
            score += 25;
            reason.push("weak fuzzy key match");
          }
        }
      }
    }
  }

  for (const queryDigit of queryDigits) {
    for (const recordKey of record.searchKeys || []) {
      const recordDigits = digitsOnly(recordKey);

      if (recordDigits === queryDigit) {
        score += 90;
        reason.push("digits-only match");
      } else if (
        queryDigit.length >= 5 &&
        recordDigits.length >= 5 &&
        (recordDigits.includes(queryDigit) || queryDigit.includes(recordDigits))
      ) {
        score += 30;
        reason.push("partial digits match");
      }
    }
  }

  if (record.type === "spreadsheet-row") score += 5;

  return { score, reason };
}

function searchKnowledge(query, options = {}) {
  const maxResults = options.maxResults || 5;
  const preferredCategories = options.categories || categoriesForQuery(query);
  const includeGuidance = options.includeGuidance || false;
  const minScore = options.minScore ?? 25;

  let records = knowledgeRecords;

  if (preferredCategories.length) {
    const preferred = knowledgeRecords.filter((record) => preferredCategories.includes(record.category));
    if (preferred.length) records = preferred;
  }

  if (!includeGuidance) {
    const nonGuidance = records.filter((record) => !isGuidanceRecord(record));
    if (nonGuidance.length) records = nonGuidance;
  }

  const scored = records
    .map((record) => {
      const result = scoreRecord(record, query);
      return { ...record, score: result.score, reason: result.reason };
    })
    .filter((record) => record.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.filter((record) => record.score >= minScore).slice(0, maxResults);
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
      const nameNorm = name.replace(/[^a-z0-9]/g, "");
      if (keyNorm === nameNorm) return normalize(value);
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

function safeFields(fields) {
  const entries = Object.entries(fields || {})
    .filter(([key, value]) => !isSensitiveField(key) && normalize(value) !== "")
    .slice(0, 12);

  return Object.fromEntries(entries);
}

function makeExcerpt(body, query, maxLen = 700) {
  const text = normalize(body).replace(/\s+/g, " ");
  if (text.length <= maxLen) return text;

  const qTerms = normalizeLoose(query)
    .split(" ")
    .filter((term) => term.length > 3 && !SEARCH_STOPWORDS.has(term));

  const lowerText = text.toLowerCase();
  let idx = -1;

  for (const term of qTerms) {
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

function linkLine(record) {
  if (!record?.url) return "";
  return `\n\nOpen file: ${record.url}`;
}

function extractInkNumber(query) {
  const q = lower(query);
  const match = q.match(/(?:ink|pms|pantone|color)\s*#?\s*([0-9]{2,5}[a-z]?)/i);
  if (match) return normalizePart(match[1]);

  const anyNumber = q.match(/\b([0-9]{2,5}[a-z]?)\b/i);
  if (q.includes("ink") && anyNumber) return normalizePart(anyNumber[1]);

  return "";
}

function extractSimplePartInfo(text) {
  const cleaned = normalize(text)
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

function findBestExactFieldMatch(records, fieldNames, value) {
  const wanted = normalizePart(value);
  if (!wanted) return null;

  for (const record of records) {
    if (!record.fields) continue;

    for (const fieldName of fieldNames) {
      const fieldValue = getField(record.fields, [fieldName]);
      if (normalizePart(fieldValue) === wanted) return record;
    }
  }

  return null;
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
    let reply = `I found ink ${color}, but the current snapshot does not show a clear usable quantity.`;

    if (status) reply += `\n\nStatus: ${status}`;
    if (lastCountDate) reply += `\nLast counted: ${lastCountDate}`;

    reply += "\n\nPlease physically verify before relying on it for production.";
    return reply;
  }

  let reply = `Yes — ink ${color} is listed on hand.`;

  if (totalWeight) reply += `\n\nTotal: ${totalWeight} lb`;
  if (containerCount) reply += `\nContainers: ${containerCount}`;
  if (location) reply += `\nLocation: ${location}`;
  if (lastCountDate) reply += `\nLast counted: ${lastCountDate}`;

  reply += "\n\nPlease physically verify before relying on it for production.";

  return reply;
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

  let reply = "I found a matching part.";

  if (partNumber || description) {
    reply = `I found ${partNumber || "a matching part"}${description ? " — " + description : ""}.`;
  }

  if (quantity) reply += `\n\nQuantity on hand: ${quantity}`;
  if (location) reply += `\nLocation: ${location}`;
  if (machine) reply += `\nMachine / Area: ${machine}`;
  if (status) reply += `\nStatus: ${status}`;

  reply += "\n\nPlease physically verify before relying on it for production.";

  return reply;
}

function answerPartSearchResults(query, results) {
  if (!results.length) {
    return (
      "I could not find that part in the current JARVIS parts inventory.\n\n" +
      "Would you like me to add it to Jonathan's Purchase Order Request list?"
    );
  }

  const top = results[0];
  const confidence = getPartMatchConfidence(query, top);

  if (confidence === "exact") return answerPartsRow(top);
  if (confidence === "likely") return "I found a likely match:\n\n" + answerPartsRow(top);

  return (
    "I did not find an exact match for that part number.\n\n" +
    "I found one possible loose match, but I am not confident it is the same part:\n\n" +
    answerPartsRow(top) +
    "\n\nIf this is not the item you meant, say: that is not it."
  );
}

function answerKnifeRow(top) {
  const fields = top.fields || {};

  const knifeId =
    getField(fields, ["Knife ID", "Knife Number", "Knife", "Item Number", "Part Number"]) ||
    getField(fields, ["Number"]);

  const type = getField(fields, ["Knife Type", "Type"]);
  const status = getField(fields, ["Status", "Current Status"]);
  const location = getField(fields, ["Location", "Current Location"]);
  const timesSent = getField(fields, ["Times Sent Out", "Sharpen Count", "Sharpening Count", "Sent Out Count"]);
  const notes = getField(fields, ["Notes"]);

  let reply = `I found ${knifeId || "a matching knife"}${type ? " — " + type : ""}.`;

  if (status) reply += `\n\nStatus: ${status}`;
  if (location) reply += `\nLocation: ${location}`;
  if (timesSent) reply += `\nTimes sent out for sharpening: ${timesSent}`;
  if (notes) reply += `\nNotes: ${notes}`;

  reply += "\n\nPlease physically verify before relying on it for production.";

  return reply;
}

function answerMailshopRow(top) {
  const fields = top.fields || {};

  const item =
    getField(fields, ["Item", "Equipment", "Machine", "Description", "Name"]) ||
    "that item";

  const status = getField(fields, ["Status"]);
  const destination = getField(fields, ["Destination"]);
  const serial = getField(fields, ["Serial Number", "Serial"]);
  const model = getField(fields, ["Model Number", "Model"]);
  const notes = getField(fields, ["Notes"]);

  let reply = `I found ${item} in the Warehouse 4 / Mailshop equipment list.`;

  if (status) reply += `\n\nStatus: ${status}`;
  if (destination) reply += `\nDestination: ${destination}`;
  if (model) reply += `\nModel: ${model}`;
  if (serial) reply += `\nSerial: ${serial}`;
  if (notes) reply += `\nNotes: ${notes}`;

  reply += "\n\nPlease physically verify before relying on this for pickup/staging decisions.";

  return reply;
}

function answerMagnaRow(top) {
  const fields = top.fields || {};

  const item =
    getField(fields, ["Motor / Drive ID", "Motor ID", "Drive ID", "Item", "Model", "Serial Number"]) ||
    "that Magna item";

  const type = getField(fields, ["Item Type", "Type"]);
  const status = getField(fields, ["Status", "Repair Status"]);
  const quote = getField(fields, ["Quote Number", "Quote #", "Quote"]);
  const poStatus = getField(fields, ["PO Status"]);
  const nextAction = getField(fields, ["Next Action"]);
  const notes = getField(fields, ["Notes"]);

  let reply = `I found ${item}${type ? " — " + type : ""} in the Magna rebuild data.`;

  if (status) reply += `\n\nStatus: ${status}`;
  if (quote) reply += `\nQuote: ${quote}`;
  if (poStatus) reply += `\nPO Status: ${poStatus}`;
  if (nextAction) reply += `\nNext action: ${nextAction}`;
  if (notes) reply += `\nNotes: ${notes}`;

  reply += "\n\nJARVIS cannot approve repairs or choose repair priority. Confirm with Gerard or Jonathan before sending a PO.";

  return reply;
}

function answerOpenOrderRow(top) {
  const fields = top.fields || {};

  const item =
    getField(fields, ["Item", "Item Number", "Part Number", "Description", "Item Description"]) ||
    "that item";

  const vendor = getField(fields, ["Vendor", "Vendor Name"]);
  const po = getField(fields, ["PO Number", "PO", "Purchase Order"]);
  const status = getField(fields, ["Status", "Order Status"]);
  const expected = getField(fields, ["Expected Delivery Date", "Expected Date", "ETA"]);
  const received = getField(fields, ["Received Date", "Date Received"]);
  const notes = getField(fields, ["Notes"]);

  let reply = `I found an open order/history record for ${item}.`;

  if (vendor) reply += `\n\nVendor: ${vendor}`;
  if (po) reply += `\nPO: ${po}`;
  if (status) reply += `\nStatus: ${status}`;
  if (expected) reply += `\nExpected delivery: ${expected}`;
  if (received) reply += `\nReceived: ${received}`;
  if (notes) reply += `\nNotes: ${notes}`;

  reply += "\n\nJARVIS can only report what the sanitized order records show.";

  return reply;
}

function answerSafetyRow(top) {
  const fields = top.fields || {};

  const name = getField(fields, ["Employee Name", "Name", "Operator"]);
  const equipment = getField(fields, ["Equipment Type", "Equipment", "Vehicle"]);
  const status = getField(fields, ["Certified / Not Certified", "Certification Status", "Status", "Certified"]);
  const expiration = getField(fields, ["Expiration Date", "Expires", "Certification Expiration"]);
  const notes = getField(fields, ["Notes"]);

  let reply = "I found a safety/training record.";

  if (name || equipment) {
    reply = `I found ${name || "this person"}${equipment ? " — " + equipment : ""}.`;
  }

  if (status) reply += `\n\nStatus: ${status}`;
  if (expiration) reply += `\nExpiration: ${expiration}`;
  if (notes) reply += `\nNotes: ${notes}`;

  reply += "\n\nJARVIS cannot certify or authorize equipment operation. Verify with supervision before live equipment use.";

  return reply;
}

function answerGenericSpreadsheetRow(top) {
  const fields = safeFields(top.fields || {});
  const lines = [];

  for (const [key, value] of Object.entries(fields)) {
    lines.push(`${key}: ${value}`);
  }

  if (!lines.length) return "I found a matching record, but it does not have enough clean fields to summarize clearly.";

  return lines.slice(0, 6).join("\n");
}

function answerFromTopResults(query, results) {
  if (!results.length) {
    return (
      "I could not find that in the current JARVIS knowledge base.\n\n" +
      "I should not guess. Try giving me a part number, machine/area, vendor name, ink color, PO/order clue, or location keyword."
    );
  }

  const top = results[0];

  if (top.type === "spreadsheet-row") {
    if (top.category === "03_INK_ROOM") return answerInkInventoryRow(top);
    if (top.category === "01_PARTS_INVENTORY") return answerPartSearchResults(query, results);
    if (top.category === "02_OPEN_ORDERS") return answerOpenOrderRow(top);
    if (top.category === "05_KNIVES") return answerKnifeRow(top);
    if (top.category === "07_MAGNA_REBUILDS") return answerMagnaRow(top);
    if (top.category === "08_MAILSHOP_EQUIPMENT_OUTGOING") return answerMailshopRow(top);
    if (top.category === "10_SAFETY_TRAINING") return answerSafetyRow(top);

    return answerGenericSpreadsheetRow(top);
  }

  if (top.type === "file") {
    let reply = `I found the relevant file: ${top.title}.`;
    if (top.url) reply += `\n\nOpen file: ${top.url}`;
    reply += "\n\nPlease verify the exact details in the file before relying on it.";
    return reply;
  }

  return makeExcerpt(top.body, query, 650) + linkLine(top);
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
    "If we do not have a part, JARVIS can help add it to Jonathan's Purchase Order Request list.\n\n" +
    "I need:\n" +
    "- Part number, if known\n" +
    "- Description\n" +
    "- Quantity needed\n" +
    "- Machine or area\n" +
    "- Requested due date\n" +
    "- Any useful notes\n\n" +
    "Important: this does not mean the part is ordered yet. Jonathan still needs to review it.\n\n" +
    "If you are submitting the PO / POR request yourself, fill out the PO Request Form, attach the quote that supports the price on the form, and email both to POR-Richmond@wearemoore.com."
  );
}

function answerThermostatQuestion(query) {
  const mapFile =
    findPdfByName("thermostat") ||
    findPdfByName("facility_thermostats") ||
    findPdfByName("maps");

  const q = lower(query);
  let area = "";

  if (q.includes("envelope") || q.includes("wh2") || q.includes("warehouse 2")) {
    area = "For the envelope department / WH2, use the thermostat map on page 1 and look in the Warehouse 2 / Envelopes area near the envelope machines.";
  } else if (q.includes("wh1") || q.includes("warehouse 1") || q.includes("ink")) {
    area = "Use the thermostat map on page 1 and look in the Warehouse 1 / Ink Department side of the map.";
  } else if (q.includes("wh3") || q.includes("warehouse 3") || q.includes("prepress") || q.includes("pre-press")) {
    area = "Use the thermostat map on page 1 and look around Warehouse 3 / Pre-Press / Maintenance.";
  } else if (q.includes("wh4") || q.includes("warehouse 4") || q.includes("mailshop") || q.includes("building 4")) {
    area = "Use the thermostat map on page 1 and look in Warehouse 4 / Mailshop.";
  } else {
    area = "Use the thermostat map on page 1 to find the thermostat for that area.";
  }

  return area + "\n\nIf the map is unclear, physically verify or ask supervision/Jonathan." + (mapFile ? linkLine(mapFile) : "");
}

function answerMapQuestion(query) {
  const q = lower(query);
  const mapFile = findPdfByName("facility") || findPdfByName("thermostat") || findPdfByName("map");

  if (q.includes("thermostat")) return answerThermostatQuestion(query);

  if (q.includes("eyewash") || q.includes("eye wash")) {
    return (
      "Eye wash station locations are shown on page 2 of the facility map.\n\n" +
      "If this is an active chemical exposure or injury, follow emergency/safety procedures immediately and notify supervision." +
      (mapFile ? linkLine(mapFile) : "")
    );
  }

  if (q.includes("fire extinguisher") || q.includes("extinguisher")) {
    return (
      "Fire extinguisher locations are shown on page 3 of the facility map.\n\n" +
      "If this is an active fire, smoke, or burning smell situation, follow emergency procedures immediately and notify supervision/emergency services as appropriate." +
      (mapFile ? linkLine(mapFile) : "")
    );
  }

  return "I can use the facility maps for thermostat locations, eye wash stations, and fire extinguishers." + (mapFile ? linkLine(mapFile) : "");
}

function answerScheduleQuestion(query) {
  const q = lower(query);
  const scheduleFile = findPdfByName("2-2-3") || findPdfByName("schedule");

  if (q.includes("night")) {
    return (
      "No — the 2-2-3 schedule applies to day shift only. Night shift remains unchanged.\n\n" +
      "The 2-2-3 day shift schedule starts June 14, 2026." +
      (scheduleFile ? linkLine(scheduleFile) : "")
    );
  }

  if (q.includes("start") || q.includes("begin")) {
    return (
      "The 2-2-3 schedule starts June 14, 2026.\n\n" +
      "It applies to day shift only. Night shift remains unchanged." +
      (scheduleFile ? linkLine(scheduleFile) : "")
    );
  }

  return (
    "The 2-2-3 schedule is for day shift only and starts June 14, 2026. Night shift remains unchanged.\n\n" +
    "Use the schedule calendar PDF to check specific days. If the calendar does not clearly answer a person-specific question, check with supervision/Jonathan." +
    (scheduleFile ? linkLine(scheduleFile) : "")
  );
}

function answerInkQuestion(query) {
  const inkNumber = extractInkNumber(query);

  const results = searchKnowledge(query, {
    maxResults: 8,
    categories: ["03_INK_ROOM"],
    minScore: 25
  });

  const spreadsheetResults = results.filter((record) => record.type === "spreadsheet-row");

  if (inkNumber) {
    const exact = findBestExactFieldMatch(
      spreadsheetResults,
      ["Ink Color Number", "Color", "Pantone", "PMS", "Formula Number"],
      inkNumber
    );

    if (exact) return answerInkInventoryRow(exact);
  }

  if (spreadsheetResults.length) return answerInkInventoryRow(spreadsheetResults[0]);

  const guidanceResults = searchKnowledge(query, {
    maxResults: 3,
    categories: ["03_INK_ROOM"],
    includeGuidance: true,
    minScore: 25
  });

  if (guidanceResults.length) return answerFromTopResults(query, guidanceResults);

  return "I could not find that ink in the current JARVIS ink files. Please physically verify or ask Jonathan/INX if this affects production.";
}

function answerPartsLookup(query, context = {}) {
  const results = searchKnowledge(query, {
    maxResults: 6,
    categories: ["01_PARTS_INVENTORY"],
    minScore: looksLikePartNumber(query) ? 55 : 80
  });

  const candidatePartNumber = extractCandidatePartNumber(query) || query;

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
      "I could not find that part in the current JARVIS parts inventory.\n\n" +
      "Would you like me to add it to Jonathan's Purchase Order Request list?"
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

  return answerPartSearchResults(query, results);
}

function answerOpenOrdersLookup(query) {
  const results = searchKnowledge(query, {
    maxResults: 6,
    categories: ["02_OPEN_ORDERS"],
    minScore: 35
  });

  if (results.length) return answerFromTopResults(query, results);

  return (
    "I could not find that item in the current sanitized open orders data.\n\n" +
    "If this needs to be ordered, follow the PO / POR request process: fill out the PO Request Form, attach the quote that supports the price, and email both to POR-Richmond@wearemoore.com."
  );
}

function answerKnifeLookup(query) {
  const results = searchKnowledge(query, {
    maxResults: 6,
    categories: ["05_KNIVES"],
    minScore: 50
  });

  if (results.length) return answerFromTopResults(query, results);

  return "I could not find that knife in the current JARVIS knife log. Please physically verify or ask Jonathan/supervision.";
}

function answerMagnaLookup(query) {
  const results = searchKnowledge(query, {
    maxResults: 6,
    categories: ["07_MAGNA_REBUILDS"],
    minScore: 35
  });

  if (results.length) return answerFromTopResults(query, results);

  return "I could not find that motor/drive in the current Magna rebuild file. Please check with Gerard or Jonathan before making repair or PO decisions.";
}

function answerMailshopLookup(query) {
  const results = searchKnowledge(query, {
    maxResults: 6,
    categories: ["08_MAILSHOP_EQUIPMENT_OUTGOING"],
    minScore: 35
  });

  if (results.length) return answerFromTopResults(query, results);

  return "I could not find that item in the current Warehouse 4 / Mailshop equipment list. Please physically verify or check with Jonathan/supervision.";
}

function answerSafetyLookup(query) {
  const results = searchKnowledge(query, {
    maxResults: 6,
    categories: ["10_SAFETY_TRAINING"],
    minScore: 35
  });

  if (results.length) return answerFromTopResults(query, results);

  return "I could not confirm that from the current JARVIS safety files. Please check with supervision or Jonathan.";
}

function isPurchaseOrderPolicyQuestion(msg) {
  return (
    msg.includes("po request") ||
    msg.includes("por request") ||
    msg.includes("purchase order request") ||
    msg.includes("blank po") ||
    msg.includes("blank por") ||
    msg.includes("po form") ||
    msg.includes("por form") ||
    msg.includes("purchase order form") ||
    msg.includes("por-richmond") ||
    msg.includes("po process") ||
    msg.includes("por process") ||
    msg.includes("request a po") ||
    msg.includes("request a por") ||
    msg.includes("submit a po") ||
    msg.includes("submit a por") ||
    msg.includes("create a po") ||
    msg.includes("create a por") ||
    msg.includes("get a po") ||
    msg.includes("get a por") ||
    msg.includes("how do i request a po") ||
    msg.includes("how do i request a por") ||
    (
      msg.includes("request form") &&
      (msg.includes("po") || msg.includes("por") || msg.includes("purchase"))
    )
  );
}

function isPartOrderingProcessQuestion(msg) {
  return (
    (
      msg.includes("how do i order") ||
      msg.includes("how to order") ||
      msg.includes("order a part") ||
      msg.includes("part we dont have") ||
      msg.includes("part we don't have") ||
      msg.includes("need a part we dont have") ||
      msg.includes("need a part we don't have") ||
      msg.includes("request a part") ||
      msg.includes("add a part")
    ) &&
    (msg.includes("part") || msg.includes("parts") || msg.includes("bearing") || msg.includes("item"))
  );
}

function isPartRequestStart(msg) {
  return (
    msg.startsWith("i need part") ||
    msg.startsWith("need part") ||
    msg.startsWith("request part") ||
    msg.startsWith("add part")
  );
}

function isCancelIntent(msg) {
  const q = lower(msg);
  return (
    q === "cancel" ||
    q === "stop" ||
    q === "never mind" ||
    q === "nevermind" ||
    q === "start over" ||
    q === "new question" ||
    q === "clear" ||
    q === "reset" ||
    q === "no" ||
    q === "nope"
  );
}

function isYesIntent(msg) {
  const q = lower(msg);
  return (
    q === "yes" ||
    q === "y" ||
    q === "yeah" ||
    q === "yep" ||
    q === "please" ||
    q === "please do" ||
    q === "add it" ||
    q === "add this" ||
    q === "do it" ||
    q === "go ahead" ||
    q.includes("yes add") ||
    q.includes("please add")
  );
}

function isWrongPartIntent(msg) {
  const q = lower(msg);
  return (
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
  ) return true;

  if (/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/.test(q)) return true;
  if (/\b\d{4}-\d{2}-\d{2}\b/.test(q)) return true;

  return false;
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
    q.includes("ink department") ||
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
    q.startsWith("can ") ||
    q.startsWith("i need ink") ||
    q.startsWith("need ink") ||
    q.startsWith("do we have ink") ||
    q.startsWith("where is ink") ||
    q.startsWith("how do i request") ||
    q.startsWith("request a po") ||
    q.startsWith("request a por")
  ) return true;

  if (isPurchaseOrderPolicyQuestion(q)) return true;
  if (q.includes("ink") || q.includes("thermostat") || q.includes("eyewash") || q.includes("fire extinguisher")) return true;

  return false;
}

function classifyIntent(msg) {
  const q = lower(msg);

  if (q === "" || q === "help") return "help";

  if (isPurchaseOrderPolicyQuestion(q)) return "po_policy";
  if (isPartOrderingProcessQuestion(q)) return "part_ordering_process";

  if (q.includes("ink") || q.includes("pantone") || q.includes("pms") || q.includes("drawdown") || q.includes("extender") || q.includes("inx")) return "ink";

  if (isPartRequestStart(q)) return "part_request_start";

  if (q.includes("2-2-3") || q.includes("schedule") || q.includes("dayshift") || q.includes("day shift") || q.includes("nightshift") || q.includes("night shift")) return "schedule";

  if (q.includes("thermostat") || q.includes("eyewash") || q.includes("eye wash") || q.includes("fire extinguisher") || q.includes("extinguisher") || q.includes("map")) return "map";

  if (q.includes("did") && (q.includes("order") || q.includes("ordered"))) return "open_orders";
  if (q.includes("ordered") || q.includes("open order") || q.includes("coming") || q.includes("received yet")) return "open_orders";

  if (q.includes("magna") || q.includes("motor") || q.includes("drive") || q.includes("rebuild")) return "magna";

  if (q.includes("warehouse 4") || q.includes("wh4") || q.includes("mailshop") || q.includes("building 4") || q.includes("stamper") || q.includes("fire jet") || q.includes("picked up") || q.includes("pickup")) return "mailshop";

  if (q.includes("forklift") || q.includes("certified") || q.includes("operator") || q.includes("certification") || q.includes("clamp truck") || q.includes("training")) return "safety";

  if (hasExplicitKnifeLanguage(q)) return "knives";

  if (looksLikePartNumber(q)) return "parts_lookup";

  if (q.includes("do we have") || q.includes("where is") || q.includes("looking for") || q.includes("find") || q.includes("on hand") || q.includes("available") || q.includes("part")) return "parts_lookup";

  return "fallback";
}

function isHighPriorityDueDate(dueDateText) {
  const text = lower(dueDateText);

  const urgentPhrases = [
    "asap", "urgent", "today", "tomorrow", "this week", "next week",
    "within 2 weeks", "within two weeks", "down machine", "machine down",
    "cannot run", "production stopped", "next monday", "next tuesday",
    "next wednesday", "next thursday", "next friday", "next saturday", "next sunday"
  ];

  if (urgentPhrases.some((phrase) => text.includes(phrase))) return true;

  const match = text.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (!match) return false;

  const now = new Date();
  const month = Number(match[1]) - 1;
  const day = Number(match[2]);
  let year = match[3] ? Number(match[3]) : now.getFullYear();

  if (year < 100) year += 2000;

  const due = new Date(year, month, day);
  const diffDays = (due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);

  return diffDays <= 14;
}

async function sendTeamsAlert(message) {
  const teamsWebhook = process.env.TEAMS_WEBHOOK_URL;

  if (!teamsWebhook) {
    console.log("No TEAMS_WEBHOOK_URL set. Skipping Teams alert.");
    return false;
  }

  try {
    await fetch(teamsWebhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message })
    });

    console.log("Teams alert sent.");
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
    console.warn("Missing PARTS_REQUEST_WEBHOOK_URL or PARTS_REQUEST_SECRET");
    return { ok: false, error: "Missing spreadsheet webhook configuration" };
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      secret,
      requesterName: request.requesterName || "",
      requesterPhone: request.requesterPhone || "",
      machineOrArea: request.machineOrArea || "",
      partNumber: request.partNumber || "",
      partDescription: request.partDescription || "",
      quantityRequested: request.quantityRequested || "",
      requestedDueDate: request.requestedDueDate || "",
      priority: request.priority || "Normal",
      notes: request.notes || "",
      status: request.status || "New",
      jonathanNotified: request.jonathanNotified || "No"
    })
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
    "Part Number: " + (pending.partNumber || pending.originalQuery || "Not provided") + "\n" +
    "Description: " + (pending.partDescription || "Not provided") + "\n\n" +
    "What requested due date should I use?\n\n" +
    "Examples: 6/20, next Friday, ASAP, or within 2 weeks.\n\n" +
    "Type cancel if you do not want to create this request."
  );
}

async function handlePendingRequest({ pending, from, cleanBody, requesterName }) {
  const msg = lower(cleanBody);

  if (pending.step === "possible_part_match") {
    if (isWrongPartIntent(msg)) {
      pendingRequests.set(from, {
        ...pending,
        step: "confirm_add_missing_part"
      });

      return (
        "Got it. I will treat the original part as not found:\n\n" +
        (pending.partNumber || pending.originalQuery || "Original part not provided") +
        "\n\nWould you like me to add it to Jonathan's Purchase Order Request list?"
      );
    }

    if (isYesIntent(msg)) {
      pendingRequests.delete(from);
      return "Okay — please physically verify that possible match before relying on it for production. If you want me to add the original part instead, say: not the right part.";
    }

    if (isCancelIntent(msg)) {
      pendingRequests.delete(from);
      return "Okay — I cleared that possible part match. What can I help you with?";
    }

    if (looksLikeNewQuestion(cleanBody)) {
      pendingRequests.delete(from);
      const reply = await getJarvisReply({ from, body: cleanBody, requesterName });
      return "I cleared the previous possible part match and answered your new question instead.\n\n" + reply;
    }
  }

  if (pending.step === "confirm_add_missing_part") {
    if (isYesIntent(msg)) return startMissingPartRequestFromPending(from, pending, requesterName);

    if (isCancelIntent(msg)) {
      pendingRequests.delete(from);
      return "Okay — I will not add that part request. What can I help you with?";
    }

    if (looksLikeNewQuestion(cleanBody)) {
      pendingRequests.delete(from);
      const reply = await getJarvisReply({ from, body: cleanBody, requesterName });
      return "I cleared the pending add-part offer and answered your new question instead.\n\n" + reply;
    }

    return "Please answer yes to add the missing part to Jonathan's Purchase Order Request list, or type cancel.";
  }

  if (isCancelIntent(msg)) {
    pendingRequests.delete(from);
    return "Okay — I canceled the pending parts request. What can I help you with?";
  }

  if (requesterName) pending.requesterName = requesterName;

  if (pending.step === "awaiting_due_date") {
    if (looksLikeDueDateOrUrgency(cleanBody)) {
      pending.requestedDueDate = cleanBody;
      pending.step = "awaiting_machine";
      pendingRequests.set(from, pending);

      return (
        "Got it. What machine or area is this part for?\n\n" +
        "Examples: 102, 202, 627-1, 627-2, 627-3, Ink Room, WH2, HVAC."
      );
    }

    if (looksLikeNewQuestion(cleanBody)) {
      pendingRequests.delete(from);
      const reply = await getJarvisReply({ from, body: cleanBody, requesterName });
      return "I paused the pending parts request and answered your new question instead.\n\n" + reply;
    }

    return (
      "I am waiting for the requested due date for the pending part request.\n\n" +
      "Reply with something like 6/20, next Friday, ASAP, today, tomorrow, or within 2 weeks.\n\n" +
      "Or type cancel to stop this request."
    );
  }

  if (pending.step === "awaiting_machine") {
    if (looksLikeNewQuestion(cleanBody)) {
      pendingRequests.delete(from);
      const reply = await getJarvisReply({ from, body: cleanBody, requesterName });
      return "I paused the pending parts request and answered your new question instead.\n\n" + reply;
    }

    if (!looksLikeMachineOrArea(cleanBody)) {
      return (
        "I am waiting for the machine or area for the pending part request.\n\n" +
        "Examples: 102, 202, 627-1, 627-2, 627-3, Ink Room, WH2, Maintenance, Shipping, or HVAC.\n\n" +
        "Or type cancel to stop this request."
      );
    }

    pending.machineOrArea = cleanBody;

    const priority = isHighPriorityDueDate(pending.requestedDueDate) ? "High" : "Normal";
    let jonathanNotified = "No";

    if (priority === "High") {
      const alertSent = await sendTeamsAlert(
        "🚨 *JARVIS HIGH PRIORITY PART REQUEST*\n\n" +
          `Requester: ${pending.requesterName || "Not provided"}\n` +
          `Requester ID: ${from}\n` +
          `Machine / Area: ${pending.machineOrArea}\n` +
          `Part Number: ${pending.partNumber || "Not provided"}\n` +
          `Description: ${pending.partDescription || "Not provided"}\n` +
          `Requested Due Date: ${pending.requestedDueDate}\n\n` +
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
        "Part Number: " + sheetRequest.partNumber + "\n" +
        "Description: " + sheetRequest.partDescription + "\n" +
        "Requested Due Date: " + sheetRequest.requestedDueDate + "\n" +
        "Machine / Area: " + sheetRequest.machineOrArea + "\n\n" +
        "Jonathan needs to check the JARVIS logs.\n\n" +
        "Important: This is not ordered yet."
      );
    }

    let reply =
      "Added to Jonathan's Purchase Order Request list.\n\n" +
      "Part Number: " + (sheetRequest.partNumber || "Not provided") + "\n" +
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
  const partNumber = info.partNumber || extractCandidatePartNumber(cleanBody);

  const lookupResults = searchKnowledge(partNumber || cleanBody, {
    maxResults: 3,
    categories: ["01_PARTS_INVENTORY"],
    minScore: 55
  });

  let foundNote = "";

  if (lookupResults.length) {
    const confidence = getPartMatchConfidence(partNumber || cleanBody, lookupResults[0]);

    if (confidence === "exact" || confidence === "likely") {
      foundNote =
        "Before I add the request, it looks like we may already have this:\n\n" +
        answerPartSearchResults(partNumber || cleanBody, lookupResults) +
        "\n\n";
    } else {
      foundNote =
        "Before I add the request, I found one loose possible match, but I am not confident it is the same part:\n\n" +
        answerPartSearchResults(partNumber || cleanBody, lookupResults) +
        "\n\n";
    }
  }

  pendingRequests.set(from, {
    step: "awaiting_due_date",
    requesterName,
    requesterPhone: from,
    partNumber: partNumber || info.partNumber,
    partDescription: info.partDescription,
    quantityRequested: "",
    notes: cleanBody
  });

  return (
    foundNote +
    "I can add this to Jonathan's next Purchase Order Request list.\n\n" +
    "Part Number: " + (partNumber || info.partNumber || "Not provided") + "\n" +
    "Description: " + (info.partDescription || "Not provided") + "\n\n" +
    "What requested due date should I use?\n\n" +
    "Examples: 6/20, next Friday, ASAP, or within 2 weeks.\n\n" +
    "Type cancel if you do not want to create this request."
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
        "You can ask about parts, ink, HVAC/thermostats, maps, knives, PO/POR requests, Magna rebuilds, Warehouse 4 mailshop equipment, safety training, or the 2-2-3 schedule.\n\n" +
        `Knowledge base records loaded: ${knowledgeRecords.length}.`
      );

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

    case "ink":
      return answerInkQuestion(cleanBody);

    case "open_orders":
      return answerOpenOrdersLookup(cleanBody);

    case "magna":
      return answerMagnaLookup(cleanBody);

    case "knives":
      return answerKnifeLookup(cleanBody);

    case "mailshop":
      return answerMailshopLookup(cleanBody);

    case "safety":
      return answerSafetyLookup(cleanBody);

    case "parts_lookup":
      return answerPartsLookup(cleanBody, { from, requesterName });

    default: {
      const results = searchKnowledge(cleanBody, { maxResults: 5, minScore: 50 });
      if (results.length) return answerFromTopResults(cleanBody, results);

      return (
        "I received your question:\n\n" +
        `"${cleanBody}"\n\n` +
        "I do not have enough information loaded to answer that confidently yet.\n\n" +
        "I should not guess. Try asking with a part number, ink color, machine/area, vendor, order clue, map location, or schedule keyword."
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
    :root { --blue:#123a63; --blue2:#0f2f52; --dark:#1f2933; --border:#d6dee8; --green:#ecfdf3; --green-border:#a6d9b7; }
    * { box-sizing:border-box; }
    html, body { height:100%; margin:0; font-family:Arial, Helvetica, sans-serif; background:#f6f9fc; color:var(--dark); }
    body { overflow:hidden; }
    .app { height:100dvh; max-width:860px; margin:0 auto; background:white; display:flex; flex-direction:column; border-left:1px solid var(--border); border-right:1px solid var(--border); }
    .header { flex:0 0 auto; background:linear-gradient(135deg, var(--blue), var(--blue2)); color:white; padding:15px 16px 13px; box-shadow:0 2px 10px rgba(15,23,42,0.18); z-index:2; text-align:center; }
    .header h1 { margin:0; font-size:30px; letter-spacing:3px; line-height:1; }
    .header p { margin:6px 0 0; font-size:12px; opacity:.95; }
    .chat { flex:1 1 auto; overflow-y:auto; padding:16px 14px; background:radial-gradient(circle at top left, rgba(18,58,99,.06), transparent 35%), #f7f9fc; }
    .bubble-wrap { display:flex; margin:10px 0; }
    .user-wrap { justify-content:flex-end; }
    .jarvis-wrap { justify-content:flex-start; }
    .bubble { max-width:82%; white-space:pre-wrap; line-height:1.42; border-radius:18px; padding:12px 14px; font-size:16px; box-shadow:0 1px 4px rgba(15,23,42,.06); }
    .user { background:var(--blue); color:white; border-bottom-right-radius:6px; }
    .jarvis { background:white; border:1px solid var(--border); border-bottom-left-radius:6px; }
    .system { background:var(--green); border:1px solid var(--green-border); border-bottom-left-radius:6px; }
    .composer { flex:0 0 auto; background:white; border-top:1px solid var(--border); padding:10px; box-shadow:0 -2px 10px rgba(15,23,42,.06); }
    .name-row { display:flex; gap:8px; margin-bottom:8px; }
    .name-row input { width:100%; border:1px solid var(--border); border-radius:12px; padding:10px 12px; font-size:15px; }
    .input-row { display:flex; gap:8px; align-items:flex-end; }
    textarea { flex:1 1 auto; min-height:48px; max-height:120px; resize:none; border:1px solid var(--border); border-radius:16px; padding:12px; font-size:16px; font-family:Arial, Helvetica, sans-serif; line-height:1.3; }
    .send { flex:0 0 auto; background:var(--blue); color:white; border:none; border-radius:16px; padding:13px 17px; font-size:16px; font-weight:bold; cursor:pointer; min-height:48px; }
    .send:disabled { background:#8aa0b7; cursor:wait; }
    .examples { font-size:12px; color:#64748b; margin-top:7px; line-height:1.35; text-align:center; }
    .fine-print { font-size:11px; color:#64748b; margin-top:6px; text-align:center; }
    @media (max-width:560px) { .app{border-left:none;border-right:none;} .header h1{font-size:26px;} .bubble{max-width:90%;font-size:15px;} .header{padding:13px 12px 10px;} .chat{padding:12px 10px;} .composer{padding:9px;} .send{padding-left:14px;padding-right:14px;} }
  </style>
</head>
<body>
  <div class="app">
    <header class="header">
      <h1>J.A.R.V.I.S.</h1>
      <p>Jonathan's Automated Resource &amp; Virtual Information System</p>
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

      <div class="examples">Examples: “do we have ink 186?” • “i need part 12345” • “where is the thermostat for the envelope department?”</div>
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

    function addMessage(text, type) {
      const chat = document.getElementById("chat");

      const wrap = document.createElement("div");
      wrap.className = "bubble-wrap " + (type === "user" ? "user-wrap" : "jarvis-wrap");

      const bubble = document.createElement("div");
      bubble.className = "bubble " + type;
      bubble.textContent = String(text);

      wrap.appendChild(bubble);
      chat.appendChild(wrap);
      scrollChatToBottom();
    }

    async function askJarvis() {
      const nameInput = document.getElementById("name");
      const questionInput = document.getElementById("question");
      const button = document.getElementById("askButton");

      const name = nameInput.value.trim();
      const question = questionInput.value.trim();

      if (!question) {
        questionInput.focus();
        return;
      }

      localStorage.setItem("jarvisName", name);

      button.disabled = true;
      button.textContent = "...";

      addMessage(question, "user");
      questionInput.value = "";

      try {
        const response = await fetch("/api/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: getSessionId(), name, question })
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || "Request failed");
        }

        addMessage(data.reply, "jarvis");
      } catch (error) {
        addMessage("I had a problem answering that. Jonathan needs to check the JARVIS logs. Error: " + error.message, "system");
      } finally {
        button.disabled = false;
        button.textContent = "Ask";
        questionInput.focus();
        scrollChatToBottom();
      }
    }

    document.addEventListener("DOMContentLoaded", () => {
      const savedName = localStorage.getItem("jarvisName");

      if (savedName) {
        document.getElementById("name").value = savedName;
      }

      addMessage("What can I help you with?", "system");

      document.getElementById("question").addEventListener("keydown", (event) => {
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

app.get("/", (_req, res) => {
  res.redirect("/ask");
});

app.get("/ask", (_req, res) => {
  res.type("html").send(getAskPageHtml());
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: !knowledgeLoadError,
    status: "J.A.R.V.I.S. online.",
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

    console.log("Web question received:", {
      from,
      name,
      question
    });

    const reply = await getJarvisReply({
      from,
      body: question,
      requesterName: name
    });

    res.json({
      ok: true,
      reply
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
  const body = req.query.body || "HELP";
  const from = req.query.from || "browser-test";
  const requesterName = req.query.name || "";

  const reply = await getJarvisReply({
    from,
    body,
    requesterName
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
            text: "🤖 *J.A.R.V.I.S. SMS*\\n**From:** " + from + " (" + city + ", " + state + ")\\n**Message:** " + body + "\\n\\n**JARVIS Reply:** " + reply
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
  console.log("J.A.R.V.I.S. listening on " + port);
});
