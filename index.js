import express from "express";
import fetch from "node-fetch";
import twilioPkg from "twilio";

const { twiml: Twiml } = twilioPkg;

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Health check
app.get("/", (_req, res) => {
  res.status(200).send("J.A.R.V.I.S. online.");
});

app.post("/sms", async (req, res) => {
  try {
    const from = req.body.From || "";
    const body = (req.body.Body || "").trim();
    const city = req.body.FromCity || "";
    const state = req.body.FromState || "";

    // Optional: notify Teams that someone texted JARVIS
    const teamsWebhook = process.env.TEAMS_WEBHOOK_URL;
    if (teamsWebhook) {
      await fetch(teamsWebhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `🤖 *J.A.R.V.I.S. SMS*\n**From:** ${from} (${city}, ${state})\n**Message:** ${body}`
        })
      });
    }

    let reply = "";

    const lower = body.toLowerCase();

    if (lower === "help" || lower === "") {
      reply =
        "J.A.R.V.I.S. online.\n\n" +
        "Jonathan's Automated Resource & Virtual Information System.\n\n" +
        "Try texting:\n" +
        "INK\n" +
        "PARTS\n" +
        "HVAC\n" +
        "ORDERS\n" +
        "JONATHAN";
    } else if (lower === "ink") {
      reply =
        "INK MODE\n\n" +
        "For ink questions, include:\n" +
        "- Pantone/color\n" +
        "- Machine\n" +
        "- Job/customer if known\n" +
        "- Whether this is urgent\n\n" +
        "If I cannot answer confidently, I will escalate to Jonathan.";
    } else if (lower === "parts") {
      reply =
        "PARTS MODE\n\n" +
        "For parts questions, include:\n" +
        "- Machine number\n" +
        "- Part name or photo/description\n" +
        "- Whether machine is down\n\n" +
        "If I cannot answer confidently, I will escalate to Jonathan.";
    } else if (lower === "hvac") {
      reply =
        "HVAC MODE\n\n" +
        "For AC issues, send:\n" +
        "- Warehouse: WH1, WH2, WH3, or WH4\n" +
        "- What area is hot\n" +
        "- Thermostat reading if known\n" +
        "- Photos/video of rooftop unit or diagnostics\n\n" +
        "Do not reset diagnostics unless instructed. JARVIS should ask Jonathan before recommending vendor calls unless it is an emergency.";
    } else if (lower === "orders") {
      reply =
        "ORDERS MODE\n\n" +
        "Ask about open parts, ink, vendor orders, or expected deliveries.\n\n" +
        "Example:\n" +
        "'Did Jonathan order doctor blades?'";
    } else if (lower === "jonathan") {
      reply =
        "Jonathan escalation noted.\n\n" +
        "In the full version, I will forward questions I cannot answer to Jonathan instead of guessing.";
    } else {
      reply =
        "J.A.R.V.I.S. received your message:\n\n" +
        `"${body}"\n\n` +
        "I am in test mode right now. Try HELP, INK, PARTS, HVAC, ORDERS, or JONATHAN.";
    }

    const twiml = new Twiml.MessagingResponse();
    twiml.message(reply);

    res.type("text/xml").send(twiml.toString());
  } catch (e) {
    console.error(e);
    res.status(200).send("<Response></Response>");
  }
});

const port = process.env.PORT || 3001;

app.listen(port, () => {
  console.log(`J.A.R.V.I.S. listening on ${port}`);
});
