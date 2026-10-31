const sharp = require("sharp");
const { hammingSimilarity } = require("./matching");

// A difference hash is a compact, private visual fingerprint. It never sends images to a third party.
async function perceptualHash(input) {
  const pixels = await sharp(input).resize(9, 8, { fit: "fill" }).grayscale().raw().toBuffer();
  let hash = "";
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      hash += pixels[y * 9 + x] > pixels[y * 9 + x + 1] ? "1" : "0";
    }
  }
  return hash;
}

function visualScore(queryHash, itemHash) {
  const similarity = hammingSimilarity(queryHash, itemHash);
  return similarity === null ? null : Math.round(similarity * 100);
}

module.exports = { perceptualHash, visualScore };
