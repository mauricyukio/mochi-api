require("dotenv").config();
const fs = require("fs/promises");
const path = require("path");

/**
 * build_vocab_deck.js
 *
 * Inputs:
 * - class plan json: chunks_000.json (schema: { class, entries:[{chunk,id,variants,meaning?,obs?}] })
 * - global library: chunk_library.json (schema: { version, entries:[{chunk,id,variants,meaning?,obs?}] })
 *
 * Behavior:
 * - Ensures deck "<CLASS>_V" exists.
 * - For each class entry:
 *   - If chunk exists in library with an id: skip creating card; fill class entry.id from library; warn list.
 *   - Else: create card; store id into class entry and library entry; union variants; persist both files atomically.
 *
 * Env required:
 * - MOCHI_API_KEY
 * - VOCAB_TEMPLATE_ID
 * - VOCAB_FIELD_TERM_ID
 * - VOCAB_FIELD_MEANING_ID
 *
 * Env optional:
 * - VOCAB_FIELD_OBS_ID
 * - MASTER_VOCAB_DECK_ID
 * - DRY_RUN=1
 */

const MOCHI_API_KEY = mustEnv("MOCHI_API_KEY");
const VOCAB_TEMPLATE_ID = mustEnv("VOCAB_TEMPLATE_ID");
const VOCAB_FIELD_TERM_ID = mustEnv("VOCAB_FIELD_TERM_ID");
const VOCAB_FIELD_MEANING_ID = mustEnv("VOCAB_FIELD_MEANING_ID");

const VOCAB_FIELD_OBS_ID = process.env.VOCAB_FIELD_OBS_ID || "";
const MASTER_VOCAB_DECK_ID = process.env.MASTER_VOCAB_DECK_ID || "";
const DRY_RUN = process.env.DRY_RUN === "1";

const LIB_FILE = process.env.CHUNK_LIBRARY_FILE || "chunk_library.json";

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
  return decks.find(d => d.name === name) || null;
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

async function loadJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function saveJsonAtomic(filePath, obj) {
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}

function validateClassDoc(doc) {
  if (!doc || typeof doc !== "object") throw new Error("Class JSON is not an object.");
  if (!doc.class || typeof doc.class !== "string") throw new Error('Missing "class" string.');
  if (!Array.isArray(doc.entries)) throw new Error('Missing "entries" array.');

  const seen = new Set();
  for (const [i, e] of doc.entries.entries()) {
    if (!e.chunk || typeof e.chunk !== "string") throw new Error(`entries[${i}].chunk missing/invalid`);
    if (typeof e.id !== "string") throw new Error(`entries[${i}].id must be a string (use "" if empty)`);
    if (!Array.isArray(e.variants)) throw new Error(`entries[${i}].variants must be an array`);
    if (e.obs != null && typeof e.obs !== "string") throw new Error(`entries[${i}].obs must be a string if present`);
    if (e.meaning != null && typeof e.meaning !== "string") throw new Error(`entries[${i}].meaning must be a string if present`);

    const key = e.chunk.trim();
    if (seen.has(key)) throw new Error(`Duplicate chunk in class JSON: "${key}"`);
    seen.add(key);
  }
}

function emptyLibrary() {
  return { version: 1, entries: [] };
}

function validateLibrary(lib) {
  if (!lib || typeof lib !== "object") return emptyLibrary();
  if (!Array.isArray(lib.entries)) return emptyLibrary();

  const seen = new Set();
  for (const [i, e] of lib.entries.entries()) {
    if (!e.chunk || typeof e.chunk !== "string") throw new Error(`Library entries[${i}].chunk missing/invalid`);
    if (typeof e.id !== "string") throw new Error(`Library entries[${i}].id must be a string (use "" if empty)`);
    if (!Array.isArray(e.variants)) throw new Error(`Library entries[${i}].variants must be an array`);
    const key = e.chunk.trim();
    if (seen.has(key)) throw new Error(`Duplicate chunk in library: "${key}"`);
    seen.add(key);
  }
  return lib;
}

function indexByChunk(entries) {
  const m = new Map();
  for (const e of entries) m.set(e.chunk, e);
  return m;
}

function union(arrA = [], arrB = []) {
  const s = new Set([...arrA, ...arrB].filter(Boolean));
  return Array.from(s);
}

async function createVocabCard({ deckId, entry }) {
  // Mochi JSON API requires:
  // - content (string) and/or fields
  // - fields must be: { FIELD_ID: { id: FIELD_ID, value: "..." } }
  const makeField = (fieldId, value) => ({
    id: fieldId,
    value: String(value ?? ""),
  });

  const fields = {
    [VOCAB_FIELD_TERM_ID]: makeField(VOCAB_FIELD_TERM_ID, entry.chunk),
    [VOCAB_FIELD_MEANING_ID]: makeField(VOCAB_FIELD_MEANING_ID, entry.meaning ?? ""),
  };

  if (VOCAB_FIELD_OBS_ID && entry.obs && entry.obs.trim()) {
    fields[VOCAB_FIELD_OBS_ID] = makeField(VOCAB_FIELD_OBS_ID, entry.obs.trim());
  }

  const body = {
    "content": "",              // required key; ignored when fields present
    "deck-id": deckId,
    "template-id": VOCAB_TEMPLATE_ID,
    "fields": fields,
  };

  if (DRY_RUN) {
    console.log(`[DRY_RUN] create card "${entry.chunk}" in deck ${deckId}`);
    return { id: `DRY_CARD_${entry.chunk.replace(/\s+/g, "_")}` };
  }

  return mochi("/cards", { method: "POST", body });
}

async function main() {
  const classFileArg = process.argv[2];
  if (!classFileArg) {
    throw new Error("Usage: node build_vocab_deck.js <class_chunks.json>\nExample: node build_vocab_deck.js chunks_000.json");
  }

  const classPath = path.resolve(classFileArg);
  const libPath = path.resolve(LIB_FILE);

  const classDoc = await loadJson(classPath);
  validateClassDoc(classDoc);

  let lib;
  try {
    lib = validateLibrary(await loadJson(libPath));
  } catch {
    lib = emptyLibrary();
  }

  const libMap = indexByChunk(lib.entries);

  const classId = classDoc.class;
  const deckName = `${classId}_V`;

  console.log(`CWD: ${process.cwd()}`);
  console.log(`Class file: ${classPath}`);
  console.log(`Library: ${libPath}`);
  console.log(`Deck: ${deckName}`);
  console.log(`DRY_RUN: ${DRY_RUN ? "yes" : "no"}`);

  if (classDoc.entries.some(e => e.obs && !VOCAB_FIELD_OBS_ID)) {
    console.warn("WARN: Some entries have 'obs' but VOCAB_FIELD_OBS_ID is not set. obs will be ignored.");
  }

  let deck = await findDeckByName(deckName);
  if (!deck) {
    deck = await createDeck({ name: deckName, parentId: MASTER_VOCAB_DECK_ID });
    console.log(`Created deck ${deckName} (id=${deck.id})`);
  } else {
    console.log(`Using existing deck ${deckName} (id=${deck.id})`);
  }

  const skippedExisting = [];
  let created = 0;

  for (const entry of classDoc.entries) {
    const inLib = libMap.get(entry.chunk);

    // Conflict check: class file provides an id that disagrees with library id
    if (inLib && inLib.id && entry.id && entry.id.trim() && entry.id !== inLib.id) {
      throw new Error(`ID conflict for chunk "${entry.chunk}": class has "${entry.id}" but library has "${inLib.id}". Refuse to proceed.`);
    }

    // If library already has an ID, skip card creation and backfill the class entry.id
    if (inLib && inLib.id && inLib.id.trim()) {
      entry.id = inLib.id;
      // keep variants up to date
      inLib.variants = union(inLib.variants, entry.variants);
      skippedExisting.push(entry.chunk);
      continue;
    }

    // Otherwise, create a card and store id in both classDoc and library
    const card = await createVocabCard({ deckId: deck.id, entry });
    entry.id = card.id;

    const libEntry = inLib || { chunk: entry.chunk, id: "", variants: [] };
    libEntry.id = card.id;
    libEntry.variants = union(libEntry.variants, entry.variants);

    // Optionally keep meaning/obs in library too (useful later)
    if (entry.meaning != null) libEntry.meaning = entry.meaning;
    if (entry.obs != null) libEntry.obs = entry.obs;

    if (!inLib) {
      lib.entries.push(libEntry);
      libMap.set(entry.chunk, libEntry);
    }

    created++;
    console.log(`+ ${entry.chunk} -> ${entry.id}`);

    // Persist progress after each card
    if (!DRY_RUN) {
      await saveJsonAtomic(classPath, classDoc);
      await saveJsonAtomic(libPath, lib);
    }
  }

  // Sort library for stability
  lib.entries.sort((a, b) => a.chunk.localeCompare(b.chunk, "en"));

  if (!DRY_RUN) {
    await saveJsonAtomic(classPath, classDoc);
    await saveJsonAtomic(libPath, lib);
  }

  if (skippedExisting.length) {
    console.warn("\nWARN: Skipped chunks already registered in chunk_library.json:");
    for (const c of skippedExisting) console.warn(`- ${c}`);
    console.warn("Verify if that was expected.\n");
  }

  console.log(`Done. New cards created=${created}. Skipped(existing)=${skippedExisting.length}.`);
}

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

