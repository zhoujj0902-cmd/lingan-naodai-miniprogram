const KEY = "handledClipboardTexts";
const MAX_ITEMS = 100;

function normalizeText(text) {
  return String(text || "").trim();
}

function getAll() {
  const texts = wx.getStorageSync(KEY) || [];
  return texts
    .map(normalizeText)
    .filter((text, index, list) => text && list.indexOf(text) === index);
}

function has(text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return getAll().includes(normalized);
}

function add(text) {
  const normalized = normalizeText(text);
  if (!normalized) return;
  const texts = getAll().filter((item) => item !== normalized);
  wx.setStorageSync(KEY, [normalized, ...texts].slice(0, MAX_ITEMS));
}

module.exports = {
  add,
  has,
  normalizeText
};
