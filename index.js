require("dotenv").config();

const key = process.env.MOCHI_API_KEY;
if (!key) throw new Error("Missing MOCHI_API_KEY in .env");

const auth = Buffer.from(`${key}:`).toString("base64");

(async () => {
  const res = await fetch("https://app.mochi.cards/api/decks", {
    headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
  });

  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  console.log(await res.json());
})();
