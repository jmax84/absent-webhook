import express from "express";
import fetch from "node-fetch";
import twilioPkg from "twilio";

const { twiml: Twiml } = twilioPkg;

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

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

  const urgentPhrases = [
    "asap",
    "urgent",
    "today",
    "tomorrow",
    "this week",
    "next week",
    "within 2 weeks",
    "within two weeks",
    "next monday",
    "next tuesday",
    "next wednesday",
    "next thursday",
    "next friday",
    "next saturday",
    "next sunday"
  ];

  if (urgentPhrases.some((phrase) => text.includes(phrase))) {
    return true;
  }

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

async function getJarvisReply({ from = "browser-test", body = "", requesterName = "" }) {
  const cleanBody = normalize(body);
  const msg = lower(cleanBody);

  const pending = pendingRequests.get(from);

  if (pending) {
    if (requesterName) {
      pending.requesterName = requesterName;
    }

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
          "\n\nThis was marked HIGH priority because the requested due date appears to be within 2 weeks or urgent. Jonathan has been notified.";
      }

      return reply;
    }
  }

  if (msg === "" || msg === "help") {
    return (
      "I can help with parts requests, ink questions, HVAC / AC routing, maps, open order questions, and escalation to Jonathan when needed.\n\n" +
      "I do not have the full knowledge base loaded yet, so if I do not know something, I should not guess."
    );
  }

  if (
    msg === "parts" ||
    msg.includes("part ") ||
    msg.includes("parts ") ||
    msg.startsWith("i need part") ||
    msg.startsWith("need part")
  ) {
    if (
      msg.startsWith("request part") ||
      msg.startsWith("add part") ||
      msg.startsWith("need part") ||
      msg.startsWith("i need part")
    ) {
      const info = extractSimplePartInfo(cleanBody.replace(/^i need part/i, "need part"));

      pendingRequests.set(from, {
        step: "awaiting_due_date",
        requesterName,
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

    return (
      "For parts questions, tell me the part number if you know it, the machine or area, and whether it is urgent.\n\n" +
      "Example: i need part 12345"
    );
  }

  if (msg === "ink" || msg.includes("ink")) {
    return (
      "For ink questions, include the color or Pantone number, machine, job/customer if known, and whether it is urgent.\n\n" +
      "Example: do we have ink 186?\n\n" +
      "I will use Jonathan's ink notes once they are loaded. If I cannot answer confidently, I should escalate instead of guessing."
    );
  }

  if (
    msg === "hvac" ||
    msg.includes("hvac") ||
    msg.includes("ac ") ||
    msg.includes("air conditioning") ||
    msg.includes("thermostat")
  ) {
    return (
      "For HVAC / AC questions, include the warehouse or department, area affected, thermostat reading if known, and photos/video if available.\n\n" +
      "Do not reset diagnostics unless instructed.\n\n" +
      "JARVIS should escalate to Jonathan before recommending vendor calls unless there is a clear emergency rule."
    );
  }

  if (
    msg === "maps" ||
    msg.includes("map") ||
    msg.includes("fire extinguisher") ||
    msg.includes("eyewash") ||
    msg.includes("eye wash")
  ) {
    return (
      "Map support is planned for:\n\n" +
      "- HVAC thermostat locations\n" +
      "- Fire extinguisher locations\n" +
      "- Eye wash station locations\n" +
      "- Parts / ink reference locations\n\n" +
      "Map images will be added after Jonathan uploads the facility maps."
    );
  }

  if (msg.includes("order") || msg.includes("ordered")) {
    return (
      "For order questions, include the part, vendor, machine, or item you are asking about.\n\n" +
      "Example: did Jonathan order doctor blades?\n\n" +
      "Open order notes are not fully loaded yet."
    );
  }

  if (msg.includes("jonathan") || msg.includes("escalate")) {
    return (
      "If I cannot answer confidently, I should escalate to Jonathan instead of guessing.\n\n" +
      "High-priority purchase requests, urgent HVAC issues, unclear safety issues, and missing critical information should be escalated."
    );
  }

  return (
    "I received your question:\n\n" +
    `"${cleanBody}"\n\n` +
    "I do not have enough information loaded to answer that confidently yet.\n\n" +
    "For now, try asking about parts requests, ink, HVAC / AC, maps, or open orders."
  );
}

function getAskPageHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>J.A.R.V.I.S.</title>
  <style>
    :root {
      --blue: #123a63;
      --blue2: #0f2f52;
      --dark: #1f2933;
      --border: #d6dee8;
      --green: #ecfdf3;
      --green-border: #a6d9b7;
    }

    * {
      box-sizing: border-box;
    }

    html, body {
      height: 100%;
      margin: 0;
      font-family: Arial, Helvetica, sans-serif;
      background: #f6f9fc;
      color: var(--dark);
    }

    body {
      overflow: hidden;
    }

    .app {
      height: 100dvh;
      max-width: 860px;
      margin: 0 auto;
      background: white;
      display: flex;
      flex-direction: column;
      border-left: 1px solid var(--border);
      border-right: 1px solid var(--border);
    }

    .header {
      flex: 0 0 auto;
      background: linear-gradient(135deg, var(--blue), var(--blue2));
      color: white;
      padding: 15px 16px 13px;
      box-shadow: 0 2px 10px rgba(15, 23, 42, 0.18);
      z-index: 2;
      text-align: center;
    }

    .header h1 {
      margin: 0;
      font-size: 30px;
      letter-spacing: 3px;
      line-height: 1;
    }

    .header p {
      margin: 6px 0 0;
      font-size: 12px;
      opacity: 0.95;
    }

    .chat {
      flex: 1 1 auto;
      overflow-y: auto;
      padding: 16px 14px;
      background:
        radial-gradient(circle at top left, rgba(18,58,99,0.06), transparent 35%),
        #f7f9fc;
    }

    .bubble-wrap {
      display: flex;
      margin: 10px 0;
    }

    .bubble-wrap.user-wrap {
      justify-content: flex-end;
    }

    .bubble-wrap.jarvis-wrap {
      justify-content: flex-start;
    }

    .bubble {
      max-width: 82%;
      white-space: pre-wrap;
      line-height: 1.42;
      border-radius: 18px;
      padding: 12px 14px;
      font-size: 16px;
      box-shadow: 0 1px 4px rgba(15, 23, 42, 0.06);
    }

    .bubble.user {
      background: var(--blue);
      color: white;
      border-bottom-right-radius: 6px;
    }

    .bubble.jarvis {
      background: white;
      border: 1px solid var(--border);
      border-bottom-left-radius: 6px;
    }

    .bubble.system {
      background: var(--green);
      border: 1px solid var(--green-border);
      border-bottom-left-radius: 6px;
    }

    .composer {
      flex: 0 0 auto;
      background: white;
      border-top: 1px solid var(--border);
      padding: 10px;
      box-shadow: 0 -2px 10px rgba(15, 23, 42, 0.06);
    }

    .name-row {
      display: flex;
      gap: 8px;
      margin-bottom: 8px;
    }

    .name-row input {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 10px 12px;
      font-size: 15px;
    }

    .input-row {
      display: flex;
      gap: 8px;
      align-items: flex-end;
    }

    textarea {
      flex: 1 1 auto;
      min-height: 48px;
      max-height: 120px;
      resize: none;
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 12px;
      font-size: 16px;
      font-family: Arial, Helvetica, sans-serif;
      line-height: 1.3;
    }

    .send {
      flex: 0 0 auto;
      background: var(--blue);
      color: white;
      border: none;
      border-radius: 16px;
      padding: 13px 17px;
      font-size: 16px;
      font-weight: bold;
      cursor: pointer;
      min-height: 48px;
    }

    .send:disabled {
      background: #8aa0b7;
      cursor: wait;
    }

    .examples {
      font-size: 12px;
      color: #64748b;
      margin-top: 7px;
      line-height: 1.35;
      text-align: center;
    }

    .fine-print {
      font-size: 11px;
      color: #64748b;
      margin-top: 6px;
      text-align: center;
    }

    @media (max-width: 560px) {
      .app {
        border-left: none;
        border-right: none;
      }

      .header h1 {
        font-size: 26px;
      }

      .bubble {
        max-width: 90%;
        font-size: 15px;
      }

      .header {
        padding: 13px 12px 10px;
      }

      .chat {
        padding: 12px 10px;
      }

      .composer {
        padding: 9px;
      }

      .send {
        padding-left: 14px;
        padding-right: 14px;
      }
    }
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

      <div class="examples">
        Examples: “do we have ink 186?” • “i need part 12345” • “where is the thermostat for the envelope department?”
      </div>

      <div class="fine-print">
        Parts requests are not ordered until Jonathan reviews them. Machine troubleshooting is not loaded yet.
      </div>
    </footer>
  </div>

  <script>
    function getSessionId() {
      let id = localStorage.getItem("jarvisSessionId");

      if (!id) {
        if (window.crypto && crypto.randomUUID) {
          id = crypto.randomUUID();
        } else {
          id = "session-" + Date.now() + "-" + Math.random().toString(16).slice(2);
        }

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
      bubble.textContent = text;

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
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            sessionId: getSessionId(),
            name,
            question
          })
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || "Request failed");
        }

        addMessage(data.reply, "jarvis");
      } catch (error) {
        addMessage(
          "I had a problem answering that. Jonathan needs to check the JARVIS logs.\\n\\nError: " + error.message,
          "system"
        );
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

app.get("/", (_req, res) => {
  res.redirect("/ask");
});

app.get("/ask", (_req, res) => {
  console.log("JARVIS ask page loaded");
  res.type("html").send(getAskPageHtml());
});

app.get("/health", (_req, res) => {
  console.log("Health check hit");
  res.status(200).send("J.A.R.V.I.S. online.");
});

app.post("/api/ask", async (req, res) => {
  try {
    const sessionId = normalize(req.body.sessionId) || "web-unknown";
    const name = normalize(req.body.name);
    const question = normalize(req.body.question);

    if (!question) {
      return res.status(400).json({
        ok: false,
        error: "Missing question"
      });
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

  console.log("Browser test hit:", {
    from,
    body,
    requesterName,
    reply
  });

  res.type("text/plain").send(reply);
});

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
    }

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
