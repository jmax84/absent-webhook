import express from "express";
import fetch from "node-fetch";
import twilioPkg from "twilio";

const { twiml: Twiml } = twilioPkg;

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Temporary in-memory conversation state.
// Good enough for demo. Later we can replace this with a database.
const pendingRequests = new Map();

function normalize(text) {
  return (text || "").trim();
}

function lower(text) {
  return normalize(text).toLowerCase();
}

function extractSimplePartInfo(text) {
  const cleaned = normalize(text)
    .replace(/^request part/i, "")
    .replace(/^add part/i, "")
    .replace(/^need part/i, "")
    .trim();

  // Very simple first pass:
  // "12345 bearing" -> partNumber: 12345, partDescription: bearing
  const match = cleaned.match(/^([A-Za-z0-9\-_.]+)\s*(.*)$/);

  if (!match) {
    return {
      partNumber: "",
      partDescription: cleaned || text
    };
  }

  return {
    partNumber: match[1] || "",
    partDescription: match[2] || ""
  };
}

function isHighPriorityDueDate(dueDateText) {
  const text = lower(dueDateText);

  if (
    text.includes("asap") ||
    text.includes("urgent") ||
    text.includes("today") ||
    text.includes("tomorrow") ||
    text.includes("this week") ||
    text.includes("next week") ||
    text.includes("within 2 weeks") ||
    text.includes("within two weeks")
  ) {
    return true;
  }

  // Simple date parser for dates like 6/20 or 06/20/2026.
  const match = text.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);

  if (!match) {
    return false;
  }

  const now = new Date();
  const month = Number(match[1]) - 1;
  const day = Number(match[2]);
  let year = match[3] ? Number(match[3]) : now.getFullYear();

  if (year < 100) {
    year += 2000;
  }

  const due = new Date(year, month, day);
  const diffMs = due.getTime() - now.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);

  return diffDays <= 14;
}

async function writePartsRequestToSheet(request) {
  const webhookUrl = process.env.PARTS_REQUEST_WEBHOOK_URL;
  const secret = process.env.PARTS_REQUEST_SECRET;

  if (!webhookUrl || !secret) {
    console.warn("Missing PARTS_REQUEST_WEBHOOK_URL or PARTS_REQUEST_SECRET");
    return {
      ok: false,
      error: "Missing spreadsheet webhook configuration"
    };
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
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
    return {
      ok: response.ok,
      raw: text
    };
  }
}

async function getJarvisReply({ from = "browser-test", body = "" }) {
  const cleanBody = normalize(body);
  const msg = lower(cleanBody);

  const pending = pendingRequests.get(from);

  if (pending) {
    if (pending.step === "awaiting_due_date") {
      pending.requestedDueDate = cleanBody;
      pending.step = "awaiting_machine";
      pendingRequests.set(from, pending);

      return (
        "Got it. What machine or area is this part for?\n\n" +
        "Examples: 102, 202, 627-1, 627-2, 627-3, Ink Room, WH2, HVAC."
      );
    }

    if (pending.step === "awaiting_machine") {
      pending.machineOrArea = cleanBody;

      const priority = isHighPriorityDueDate(pending.requestedDueDate)
        ? "High"
        : "Normal";

      const jonathanNotified = priority === "High" ? "Needs Notification" : "No";

      const sheetRequest = {
        requesterName: pending.requesterName || "",
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
        sheetResult = {
          ok: false,
          error: error.toString()
        };
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
        reply +=
          "\n\nThis was marked HIGH priority because the requested due date appears to be within 2 weeks or urgent.";
      }

      return reply;
    }
  }

  if (msg === "" || msg === "help") {
    return (
      "J.A.R.V.I.S. online.\n\n" +
      "Jonathan's Automated Resource & Virtual Information System.\n\n" +
      "Text one of these commands:\n" +
      "PARTS - parts inventory / request help\n" +
      "INK - ink formulas and inventory\n" +
      "HVAC - AC notes for WH1-WH4\n" +
      "MAPS - thermostat, extinguisher, eyewash maps\n" +
      "ORDERS - open orders and order status\n" +
      "JONATHAN - escalation info\n\n" +
      "You can also ask a work question in plain English."
    );
  }

  if (msg === "parts") {
    return (
      "PARTS MODE\n\n" +
      "For parts questions, include:\n" +
      "- Machine number or area\n" +
      "- Part number if known\n" +
      "- Description or photo if part number is unknown\n" +
      "- Quantity needed\n" +
      "- Whether the machine is down\n\n" +
      "If the part is not available, JARVIS can add it to Jonathan's next Purchase Order Request list.\n\n" +
      "For a request demo, text:\n" +
      "Need part 12345 bearing"
    );
  }

  if (
    msg.startsWith("request part") ||
    msg.startsWith("add part") ||
    msg.startsWith("need part")
  ) {
    const info = extractSimplePartInfo(cleanBody);

    pendingRequests.set(from, {
      step: "awaiting_due_date",
      requesterPhone: from,
      partNumber: info.partNumber,
      partDescription: info.partDescription,
      quantityRequested: "",
      notes: cleanBody
    });

    return (
      "I can add this to Jonathan's next Purchase Order Request list.\n\n" +
      "Part Number: " + (info.partNumber || "Not provided") + "\n" +
      "Description: " + (info.partDescription || "Not provided") + "\n\n" +
      "What requested due date should I use?\n\n" +
      "Examples: 6/20, next Friday, ASAP, or within 2 weeks."
    );
  }

  if (msg === "ink") {
    return (
      "INK MODE\n\n" +
      "For ink questions, include:\n" +
      "- Pantone / color\n" +
      "- Machine\n" +
      "- Job or customer if known\n" +
      "- Whether this is urgent\n\n" +
      "JARVIS will use Jonathan's ink notes, formulas, inventory notes, and INX premade ink notes when available."
    );
  }

  if (msg === "hvac") {
    return (
      "HVAC MODE\n\n" +
      "For AC issues, include:\n" +
      "- Warehouse: WH1, WH2, WH3, or WH4\n" +
      "- Area affected\n" +
      "- Thermostat reading if known\n" +
      "- Photos/video of rooftop unit or diagnostics if available\n\n" +
      "Do not reset diagnostics unless instructed.\n\n" +
      "JARVIS should escalate to Jonathan before recommending vendor calls unless there is a clear emergency rule."
    );
  }

  if (msg === "maps") {
    return (
      "MAPS MODE\n\n" +
      "Planned map layers:\n" +
      "- HVAC thermostat locations\n" +
      "- Fire extinguisher locations\n" +
      "- Eye wash station locations\n" +
      "- Parts / ink reference locations\n\n" +
      "For now, ask something like:\n" +
      "'Where is the WH2 thermostat?'\n\n" +
      "Map sending will be added after the map files are uploaded."
    );
  }

  if (msg === "orders") {
    return (
      "ORDERS MODE\n\n" +
      "Ask about open parts, ink, vendor orders, or expected deliveries.\n\n" +
      "Example:\n" +
      "'Did Jonathan order doctor blades?'\n\n" +
      "JARVIS will eventually check the shared order notes and purchase request spreadsheet."
    );
  }

  if (msg === "jonathan") {
    return (
      "JONATHAN ESCALATION\n\n" +
      "If JARVIS cannot answer confidently, it should escalate to Jonathan instead of guessing.\n\n" +
      "High-priority purchase requests, urgent HVAC issues, unclear safety issues, and missing critical information should be escalated."
    );
  }

  return (
    "J.A.R.V.I.S. received your message:\n\n" +
    `"${cleanBody}"\n\n` +
    "I am still in setup mode. Try HELP, PARTS, INK, HVAC, MAPS, ORDERS, or JONATHAN.\n\n" +
    "For a purchase request demo, text:\n" +
    "Need part 12345 bearing"
  );
}

// Health check
app.get("/", (_req, res) => {
  console.log("Health check hit");
  res.status(200).send("J.A.R.V.I.S. online.");
});

// Browser test route
app.get("/test", async (req, res) => {
  const body = req.query.body || "HELP";
  const from = req.query.from || "browser-test";

  const reply = await getJarvisReply({ from, body });

  console.log("Browser test hit:", { from, body, reply });

  res.type("text/plain").send(reply);
});

// Twilio SMS route
app.post("/sms", async (req, res) => {
  try {
    console.log("====================================");
    console.log("Incoming SMS webhook hit");
    console.log("Body:", req.body);
    console.log("====================================");

    const from = req.body.From || "";
    const body = req.body.Body || "";
    const city = req.body.FromCity || "";
    const state = req.body.FromState || "";

    const reply = await getJarvisReply({ from, body });

    const teamsWebhook = process.env.TEAMS_WEBHOOK_URL;

    if (teamsWebhook) {
      try {
        await fetch(teamsWebhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text:
              `🤖 *J.A.R.V.I.S. SMS*\n` +
              `**From:** ${from} (${city}, ${state})\n` +
              `**Message:** ${body}\n\n` +
              `**JARVIS Reply:** ${reply}`
          })
        });

        console.log("Posted incoming SMS to Teams");
      } catch (teamsError) {
        console.error("Teams webhook failed:", teamsError);
      }
    } else {
      console.log("No TEAMS_WEBHOOK_URL set. Skipping Teams notification.");
    }

    console.log("Replying with:", reply);

    const twiml = new Twiml.MessagingResponse();
    twiml.message(reply);

    res.type("text/xml").send(twiml.toString());
  } catch (e) {
    console.error("JARVIS SMS handler error:", e);

    const twiml = new Twiml.MessagingResponse();
    twiml.message(
      "J.A.R.V.I.S. had an internal error while processing that message. Jonathan needs to check the logs."
    );

    res.type("text/xml").send(twiml.toString());
  }
});

const port = process.env.PORT || 3001;

app.listen(port, () => {
  console.log(`J.A.R.V.I.S. listening on ${port}`);
});
