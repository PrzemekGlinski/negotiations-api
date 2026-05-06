const fs = require("fs");
const path = require("path");

const MAX_OUTPUT_BYTES = 500;

function stripDiacritics(text) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeText(text) {
  if (!text) return "";
  return stripDiacritics(String(text).toLowerCase())
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stemToken(token) {
  let t = token;
  const suffixes = [
    "owego",
    "owej",
    "owemu",
    "owym",
    "owych",
    "owie",
    "ami",
    "ach",
    "ego",
    "emu",
    "owa",
    "owe",
    "owy",
    "ow",
    "ami",
    "ach",
    "ie",
    "ia",
    "em",
    "om",
    "ow",
    "a",
    "e",
    "y",
    "u"
  ];

  for (const suffix of suffixes) {
    if (t.length > suffix.length + 2 && t.endsWith(suffix)) {
      t = t.slice(0, -suffix.length);
      break;
    }
  }
  return t;
}

function tokenize(text) {
  return normalizeText(text)
    .split(" ")
    .filter(Boolean)
    .map(stemToken);
}

function parseCsv(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) return [];

  return lines.slice(1).map((line) => {
    const commaIndex = line.lastIndexOf(",");
    if (commaIndex === -1) {
      return { name: line.trim(), code: "" };
    }
    const left = line.slice(0, commaIndex).trim();
    const right = line.slice(commaIndex + 1).trim();
    return { name: left, code: right };
  });
}

function parseConnections(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) return [];

  return lines.slice(1).map((line) => {
    const [itemCode, cityCode] = line.split(",").map((v) => (v || "").trim());
    return { itemCode, cityCode };
  });
}

function clampOutput(output) {
  if (Buffer.byteLength(output, "utf8") <= MAX_OUTPUT_BYTES) {
    return output;
  }

  let trimmed = output;
  while (Buffer.byteLength(trimmed, "utf8") > MAX_OUTPUT_BYTES && trimmed.length > 4) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

const dataDir = process.cwd();
const citiesPath = path.join(__dirname, "cities.csv");
const itemsPath = path.join(__dirname, "items.csv");
const connectionsPath = path.join(__dirname, "connections.csv");

const cities = parseCsv(citiesPath);
const items = parseCsv(itemsPath);
const connections = parseConnections(connectionsPath);

const cityNameByCode = new Map(cities.map((city) => [city.code, city.name]));
const cityCodesByItemCode = new Map();

for (const row of connections) {
  if (!row.itemCode || !row.cityCode) continue;
  if (!cityCodesByItemCode.has(row.itemCode)) {
    cityCodesByItemCode.set(row.itemCode, new Set());
  }
  cityCodesByItemCode.get(row.itemCode).add(row.cityCode);
}

const indexedItems = items.map((item) => ({
  ...item,
  normalizedName: normalizeText(item.name),
  tokens: tokenize(item.name)
}));

function findBestItem(query) {
  const normalizedQuery = normalizeText(query);
  const queryTokens = tokenize(query);
  if (!normalizedQuery) return null;

  let best = null;
  let bestScore = 0;

  for (const item of indexedItems) {
    let score = 0;

    if (normalizedQuery.includes(item.normalizedName)) {
      score += 1000;
    }

    const itemTokenSet = new Set(item.tokens);
    for (const token of queryTokens) {
      if (itemTokenSet.has(token)) {
        score += token.length >= 4 ? 3 : 1;
      }
      if (item.normalizedName.includes(token)) {
        score += 1;
      }
    }

    const coverage = queryTokens.length
      ? queryTokens.filter((t) => itemTokenSet.has(t)).length / queryTokens.length
      : 0;
    score += coverage * 10;

    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  return bestScore >= 2 ? best : null;
}

module.exports = function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ output: "Method Not Allowed" });
  }

  try {
    const params = req.body && typeof req.body.params === "string" ? req.body.params : "";
    if (!params.trim()) {
      return res.status(400).json({
        output: "Podaj tekst w polu params, np. 'potrzebuję rezystora 1 ohm'."
      });
    }

    const bestItem = findBestItem(params);
    if (!bestItem) {
      const output = clampOutput(
        "Nie znalazlem przedmiotu. Sprobuj podac wiecej detali, np. 'rezystor metalizowany 1 ohm'."
      );
      return res.status(200).json({ output });
    }

    const cityCodesSet = cityCodesByItemCode.get(bestItem.code);
    if (!cityCodesSet || cityCodesSet.size === 0) {
      const output = clampOutput(
        `Brak miast dla przedmiotu: ${bestItem.name}. Sprobuj innej frazy.`
      );
      return res.status(200).json({ output });
    }

    const cityNames = Array.from(cityCodesSet)
      .map((code) => cityNameByCode.get(code))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, "pl"));

    if (cityNames.length === 0) {
      const output = clampOutput(
        `Brak poprawnych mapowan miast dla przedmiotu: ${bestItem.name}.`
      );
      return res.status(200).json({ output });
    }

    let output = `Miasta: ${cityNames.join(", ")}`;
    output = clampOutput(output);

    if (Buffer.byteLength(output, "utf8") < 4) {
      output = "Brak";
    }

    return res.status(200).json({ output });
  } catch (error) {
    const output = clampOutput("Wystapil blad serwera podczas wyszukiwania.");
    return res.status(500).json({ output });
  }
};
