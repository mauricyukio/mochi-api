require("dotenv").config();
const fs = require("fs/promises");
const path = require("path");

const MOCHI_API_KEY = mustEnv("MOCHI_API_KEY");

const SENT_TEMPLATE_ID = mustEnv("SENT_TEMPLATE_ID");
const SENT_FIELD_EN_ID = mustEnv("SENT_FIELD_EN_ID");
const SENT_FIELD_HINTS_ID = mustEnv("SENT_FIELD_HINTS_ID");
const SENT_FIELD_PT_ID = mustEnv("SENT_FIELD_PT_ID");

const MASTER_SENTENCE_DECK_ID = process.env.MASTER_SENTENCE_DECK_ID || "";
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

const AUTH = Buffer.from(`${MOCHI_API_KEY}:`).toString("base64");
const BASE = "https://app.mochi.cards/api";

async function mochi(pathname, { method = "GET", body } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      Authorization: `Basic ${AUTH}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Mochi API ${method} ${pathname} -> ${res.status}: ${txt}`);
  }
  return res.json();
}

async function listDecks() {
  const data = await mochi("/decks");
  return data.docs || [];
}

async function findDeckByName(name) {
  const decks = await listDecks();
  return decks.find((d) => d.name === name) || null;
}

async function createDeck({ name, parentId = "" }) {
  if (DRY_RUN) {
    console.log(`[DRY_RUN] create deck "${name}" parent=${parentId || "(none)"}`);
    return { id: `DRY_DECK_${name}`, name };
  }
  const body = { name };
  if (parentId) body["parent-id"] = parentId;
  return mochi("/decks", { method: "POST", body });
}

// Mochi API: fields must be nested { FIELD_ID: { id: FIELD_ID, value: "..." } }
function makeField(fieldId, value) {
  return { id: fieldId, value: String(value ?? "") };
}

function cloze(text) {
  // Mochi cloze syntax
  return `{{${text}}}`;
}

function escapeBraces(text) {
  // Prevent accidental cloze collisions if gloss contains braces.
  // (Rare, but safe.)
  return String(text).replaceAll("{", "\\{").replaceAll("}", "\\}");
}

function renderHints(hintsArray) {
  // Plain text, no dynamic embeds.
  // Cloze only the gloss (second part).
  // Format: [[chunk|id]]: {{gloss_pt}}
  return (hintsArray || [])
    .map((h) => {
      if (!h.chunk || !h.id) throw new Error("Hint items must have chunk and id");
      const gloss = escapeBraces(h.gloss_pt ?? "");
      return `[[${h.chunk}|${h.id}]]: ${cloze(gloss)}`;
    })
    .join("\n");
}

async function createSentenceCard({ deckId, en, hints, pt }) {
  const body = {
    content: "",
    "deck-id": deckId,
    "template-id": SENT_TEMPLATE_ID,
    fields: {
      [SENT_FIELD_EN_ID]: makeField(SENT_FIELD_EN_ID, en),         // NO CLOZE HERE
      [SENT_FIELD_HINTS_ID]: makeField(SENT_FIELD_HINTS_ID, hints), // gloss is clozed inside hints string
      [SENT_FIELD_PT_ID]: makeField(SENT_FIELD_PT_ID, pt),
    },
  };

  if (DRY_RUN) {
    console.log(`[DRY_RUN] create sentence card: ${en}`);
    return { id: `DRY_CARD_${en.slice(0, 24).replace(/\s+/g, "_")}` };
  }

  return mochi("/cards", { method: "POST", body });
}

function resolveSentencesPath(arg) {
  if (/^\d{3}$/.test(arg)) {
    const classId = arg;
    return path.resolve("classes", classId, `sentences_${classId}.json`);
  }
  return path.resolve(arg);
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    throw new Error(
      "Usage:\n" +
        "  node build_sentence_deck.js 000\n" +
        "  node build_sentence_deck.js classes/000/sentences_000.json"
    );
  }

  const sentencesPath = resolveSentencesPath(arg);
  const doc = JSON.parse(await fs.readFile(sentencesPath, "utf8"));

  if (!doc.class || !Array.isArray(doc.sentences)) {
    throw new Error('Invalid sentences file. Expected { "class": "...", "sentences": [...] }');
  }

  const classId = doc.class;
  const deckName = `${classId}_S`;

  console.log(`CWD: ${process.cwd()}`);
  console.log(`Sentences file: ${sentencesPath}`);
  console.log(`Deck: ${deckName}`);
  console.log(`MASTER_SENTENCE_DECK_ID: ${MASTER_SENTENCE_DECK_ID || "(not set)"}`);
  console.log(`DRY_RUN: ${DRY_RUN ? "yes" : "no"}`);

  let deck = await findDeckByName(deckName);
  if (!deck) {
    deck = await createDeck({ name: deckName, parentId: MASTER_SENTENCE_DECK_ID });
    console.log(`Created deck ${deckName} (id=${deck.id})`);
  } else {
    console.log(`Using existing deck ${deckName} (id=${deck.id})`);
  }

  let created = 0;

  for (const s of doc.sentences) {
    if (!s.en || !s.pt || !Array.isArray(s.hints)) {
      throw new Error("Each sentence must have en, pt, and hints[]");
    }

    const hintsText = renderHints(s.hints);

    await createSentenceCard({
      deckId: deck.id,
      en: s.en,          // plain text; template handles cloze/audio behavior
      hints: hintsText,  // gloss clozed per line
      pt: s.pt,
    });

    created++;
    console.log(`+ ${s.en}`);
  }

  console.log(`Done. Sentence cards created=${created}.`);
}

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
