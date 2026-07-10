const KEY = "inspirations";

function isExpiredTempImage(path) {
  return typeof path === "string" && path.includes("__tmp__");
}

function normalizeItem(item) {
  const originalImages = item.images || [];
  const images = originalImages.filter((path) => !isExpiredTempImage(path));
  const hasImageChanged = images.length !== originalImages.length;
  const lostAllImages = originalImages.length > 0 && images.length === 0;
  if (!hasImageChanged) {
    return item;
  }
  return {
    ...item,
    images,
    imageFingerprints: images.length ? item.imageFingerprints || [] : [],
    imageTag: images.length ? item.imageTag || "" : "",
    type: lostAllImages && item.type === "image" ? "sentence" : item.type
  };
}

function readAll() {
  const items = wx.getStorageSync(KEY) || [];
  const activeItems = items.filter((item) => !item.isDeleted);
  const normalized = activeItems.map(normalizeItem);
  const hasChanged =
    activeItems.length !== items.length ||
    activeItems.some((item, index) => item !== normalized[index]);
  if (hasChanged) {
    saveAll(normalized);
  }
  return normalized;
}

function getAll() {
  return readAll().sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    return b.createdAt - a.createdAt;
  });
}

function saveAll(items) {
  wx.setStorageSync(KEY, items);
}

function getById(id) {
  return readAll().find((item) => item.id === id);
}

function add(data) {
  const now = Date.now();
  const item = {
    id: `inspiration-${now}`,
    content: data.content || "",
    images: data.images || [],
    imageFingerprints: data.imageFingerprints || [],
    imageTag: data.imageTag || "",
    type: data.images && data.images.length ? "image" : "sentence",
    source: data.source || "",
    note: data.note || "",
    isPinned: Boolean(data.isPinned),
    isFavorite: true,
    isUsed: false,
    isDeleted: false,
    createdAt: now,
    updatedAt: now
  };
  const items = readAll();
  saveAll([item, ...items]);
  return item;
}

function update(id, patch) {
  const now = Date.now();
  const items = readAll();
  const next = items.map((item) =>
    item.id === id ? { ...item, ...patch, updatedAt: now } : item
  );
  saveAll(next);
  return getById(id);
}

function backfillImageFingerprints(entries) {
  const fingerprintsById = new Map(
    (entries || [])
      .filter((entry) => entry && entry.id && Array.isArray(entry.imageFingerprints))
      .map((entry) => [entry.id, entry.imageFingerprints])
  );
  if (!fingerprintsById.size) return;

  const items = readAll();
  let hasChanged = false;
  const next = items.map((item) => {
    const imageFingerprints = fingerprintsById.get(item.id);
    if (!imageFingerprints) return item;
    hasChanged = true;
    return { ...item, imageFingerprints };
  });
  if (hasChanged) saveAll(next);
}

function remove(id) {
  const items = readAll();
  const next = items.filter((item) => item.id !== id);
  if (next.length === items.length) return false;
  saveAll(next);
  return true;
}

function removeImage(id, imagePath) {
  const item = getById(id);
  if (!item) return null;
  const imageIndex = (item.images || []).findIndex((path) => path === imagePath);
  const images = (item.images || []).filter((path) => path !== imagePath);
  const imageFingerprints = (item.imageFingerprints || []).filter(
    (_, index) => index !== imageIndex
  );
  return update(id, {
    images,
    imageFingerprints,
    imageTag: images.length ? item.imageTag || "" : "",
    type: images.length ? "image" : item.type === "image" ? "sentence" : item.type
  });
}

function search(keyword) {
  const q = String(keyword || "").trim().toLowerCase();
  if (!q) return getAll();
  return getAll().filter((item) => {
    return [item.content, item.note, item.imageTag]
      .join(" ")
      .toLowerCase()
      .includes(q);
  });
}

function hasContent(content, excludeId = "") {
  const text = String(content || "").trim();
  if (!text) return false;
  return getAll().some(
    (item) => item.id !== excludeId && String(item.content || "").trim() === text
  );
}

function formatDate(time) {
  if (!time) return "";
  const date = new Date(time);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hour = `${date.getHours()}`.padStart(2, "0");
  const minute = `${date.getMinutes()}`.padStart(2, "0");
  return `${month}-${day} ${hour}:${minute}`;
}

module.exports = {
  getAll,
  getById,
  add,
  update,
  backfillImageFingerprints,
  remove,
  removeImage,
  search,
  hasContent,
  formatDate
};
