const STOP_WORDS = new Set(["a", "an", "and", "are", "at", "for", "from", "i", "in", "is", "it", "lost", "my", "near", "of", "on", "or", "the", "this", "to", "was", "with"]);

function tokenize(value = "") {
  return [...new Set(String(value).toLowerCase().match(/[a-z0-9]{2,}/g)?.filter((word) => !STOP_WORDS.has(word)) || [])];
}

function overlap(left, right) {
  const a = new Set(Array.isArray(left) ? left : tokenize(left));
  const b = new Set(Array.isArray(right) ? right : tokenize(right));
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / new Set([...a, ...b]).size;
}

function hammingSimilarity(left, right) {
  if (!left || !right || left.length !== right.length) return null;
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) {
    distance += left[index] !== right[index];
  }
  return 1 - distance / left.length;
}

function locationScore(left, right) {
  if (left.latitude && left.longitude && right.latitude && right.longitude) {
    const km = haversine(Number(left.latitude), Number(left.longitude), Number(right.latitude), Number(right.longitude));
    return Math.max(0, 1 - km / 12);
  }
  return overlap(left.location_name, right.location_name);
}

function haversine(lat1, lng1, lat2, lng2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function scoreItems(source, candidate) {
  const sourceWords = tokenize([source.title, source.description, ...(source.keywords || [])].join(" "));
  const candidateWords = tokenize([candidate.title, candidate.description, ...(candidate.keywords || [])].join(" "));
  const text = overlap(sourceWords, candidateWords);
  const category = source.category && source.category.toLowerCase() === candidate.category?.toLowerCase() ? 1 : 0;
  const color = source.color && candidate.color && source.color.toLowerCase() === candidate.color.toLowerCase() ? 1 : 0;
  const location = locationScore(source, candidate);
  const visual = hammingSimilarity(source.visual_hash, candidate.visual_hash);
  const factors = { text: Math.round(text * 42), category: Math.round(category * 20), color: Math.round(color * 8), location: Math.round(location * 18) };
  if (visual !== null) factors.visual = Math.round(visual * 12);
  const raw = Object.values(factors).reduce((sum, value) => sum + value, 0);
  const maximum = visual === null ? 88 : 100;
  const score = Math.min(99, Math.round(raw / maximum * 100));
  const reasons = [];
  if (category) reasons.push("same category");
  if (text >= 0.16) reasons.push("similar description or keywords");
  if (location >= 0.25) reasons.push("nearby location");
  if (color) reasons.push("matching color");
  if (visual !== null && visual >= 0.7) reasons.push("visually similar image");
  return { score, factors, reasons, visualSimilarity: visual === null ? null : Math.round(visual * 100) };
}

function scoreQuery(query, item) {
  return scoreItems({ title: query, description: query, keywords: tokenize(query), category: "", location_name: query }, item);
}

module.exports = { tokenize, overlap, haversine, hammingSimilarity, scoreItems, scoreQuery };
