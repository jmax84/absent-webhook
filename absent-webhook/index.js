import express from "express";
import fetch from "node-fetch";
import twilioPkg from "twilio";
const { twiml: Twiml } = twilioPkg;

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// health check
app.get("/", (_req, res) => res.status(200).send("OK"));

app.post("/sms", async (req, res) => {
  try {
    const from = req.body.From || "";
    const body = req.body.Body || "";
    const city = req.body.FromCity || "";
    const state = req.body.FromState || "";

    // 1) Post to Teams
    const teamsWebhook = process.env.TEAMS_WEBHOOK_URL;
    if (teamsWebhook) {
      await fetch(teamsWebhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `📨 *ABSENT SMS*\n**From:** ${from} (${city}, ${state})\n**Message:** ${body}`
        })
      });
    }

    // 2) Reply to sender (TwiML). If your number isn't approved yet, Twilio accepts this but may not deliver.
    const twiml = new Twiml.MessagingResponse();
    twiml.message("Thanks—your absence was received. If this was a mistake, reply CANCEL.");

    res.type("text/xml").send(twiml.toString());
  } catch (e) {
    console.error(e);
    res.status(200).send("<Response></Response>");
  }
});

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`listening on ${port}`));
