const { IMAGE_TAGS } = require("./constants");

const CUSTOM_KEY = "customImageTags";
const HIDDEN_DEFAULT_KEY = "hiddenDefaultImageTags";

function normalizeTag(tag) {
  return String(tag || "").trim().slice(0, 8);
}

function getAll() {
  const tags = wx.getStorageSync(CUSTOM_KEY) || [];
  return tags
    .map(normalizeTag)
    .filter((tag, index, list) => tag && !IMAGE_TAGS.includes(tag) && list.indexOf(tag) === index);
}

function saveAll(tags) {
  wx.setStorageSync(CUSTOM_KEY, tags);
}

function getHiddenDefaultTags() {
  const tags = wx.getStorageSync(HIDDEN_DEFAULT_KEY) || [];
  return tags
    .map(normalizeTag)
    .filter((tag, index, list) => tag && IMAGE_TAGS.includes(tag) && list.indexOf(tag) === index);
}

function saveHiddenDefaultTags(tags) {
  wx.setStorageSync(HIDDEN_DEFAULT_KEY, tags);
}

function getDefaultTags() {
  const hiddenTags = getHiddenDefaultTags();
  return IMAGE_TAGS.filter((tag) => !hiddenTags.includes(tag));
}

function add(tag) {
  const normalized = normalizeTag(tag);
  if (!normalized || IMAGE_TAGS.includes(normalized)) return normalized;
  const tags = getAll();
  if (!tags.includes(normalized)) {
    saveAll([...tags, normalized]);
  }
  return normalized;
}

function remove(tag) {
  const normalized = normalizeTag(tag);
  if (IMAGE_TAGS.includes(normalized)) {
    const hiddenTags = getHiddenDefaultTags();
    if (!hiddenTags.includes(normalized)) {
      saveHiddenDefaultTags([...hiddenTags, normalized]);
    }
    return getAll();
  }

  const tags = getAll().filter((item) => item !== normalized);
  saveAll(tags);
  return tags;
}

function getSelectableTags(extraTag) {
  const normalizedExtraTag = normalizeTag(extraTag);
  const tags = [...getDefaultTags(), ...getAll()];
  if (
    normalizedExtraTag &&
    !tags.includes(normalizedExtraTag)
  ) {
    tags.push(normalizedExtraTag);
  }
  return tags;
}

function getFirstSelectableTag() {
  return getSelectableTags()[0] || "";
}

module.exports = {
  add,
  getAll,
  getDefaultTags,
  getFirstSelectableTag,
  getSelectableTags,
  normalizeTag,
  remove
};
