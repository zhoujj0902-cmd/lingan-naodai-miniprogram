const KEY = "inspirations";
const LAST_OWNER_KEY = `${KEY}:lastOwner`;
const DEFAULT_SYNC_META = {
  paginationVersion: 0,
  nextCursor: "",
  hasMore: false,
  lastSyncAt: 0,
  lastSyncedAt: 0
};
let storageKey = KEY;

function normalizeOwner(openid) {
  return String(openid || "").replace(/[^a-zA-Z0-9_-]/g, "");
}

function restoreOwner() {
  try {
    const owner = normalizeOwner(wx.getStorageSync(LAST_OWNER_KEY));
    storageKey = owner ? `${KEY}:${owner}` : KEY;
  } catch (error) {
    storageKey = KEY;
  }
}

function isExpiredTempImage(path) {
  return typeof path === "string" && path.includes("__tmp__");
}

function normalizeItem(item) {
  const originalImages = item.images || [];
  const activeImageIndexes = originalImages
    .map((path, index) => ({ path, index }))
    .filter(({ path }) => !isExpiredTempImage(path));
  const images = activeImageIndexes.map(({ path }) => path);
  const hasImageChanged = images.length !== originalImages.length;
  const lostAllImages = originalImages.length > 0 && images.length === 0;
  if (!hasImageChanged) {
    return item;
  }
  return {
    ...item,
    images,
    thumbnails: images.length
      ? activeImageIndexes.map(
        ({ index, path }) => (item.thumbnails || [])[index] || path
      )
      : [],
    imageFingerprints: images.length
      ? activeImageIndexes.map(({ index }) => (item.imageFingerprints || [])[index] || "")
      : [],
    imageTag: images.length ? item.imageTag || "" : "",
    type: lostAllImages && item.type === "image" ? "sentence" : item.type
  };
}

function saveAllToKey(key, items) {
  wx.setStorageSync(key, items);
}

function readAllFromKey(key) {
  const items = wx.getStorageSync(key) || [];
  const activeItems = items.filter((item) => !item.isDeleted);
  const normalized = activeItems.map(normalizeItem);
  const hasChanged =
    activeItems.length !== items.length ||
    activeItems.some((item, index) => item !== normalized[index]);
  if (hasChanged) {
    saveAllToKey(key, normalized);
  }
  return normalized;
}

function readAll() {
  return readAllFromKey(storageKey);
}

function getAll() {
  return readAll().sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    return b.createdAt - a.createdAt;
  });
}

function saveAll(items) {
  saveAllToKey(storageKey, items);
}

function getSyncMetaKey() {
  return `${storageKey}:syncMeta`;
}

function getSyncMeta() {
  return {
    ...DEFAULT_SYNC_META,
    ...(wx.getStorageSync(getSyncMetaKey()) || {})
  };
}

function setSyncMeta(patch) {
  const next = { ...getSyncMeta(), ...(patch || {}) };
  wx.setStorageSync(getSyncMetaKey(), next);
  return next;
}

function setOwner(openid) {
  const owner = normalizeOwner(openid);
  storageKey = owner ? `${KEY}:${owner}` : KEY;
  if (owner) {
    wx.setStorageSync(LAST_OWNER_KEY, owner);
  }
}

function getLegacyAll() {
  return readAllFromKey(KEY);
}

function clearLegacy() {
  wx.removeStorageSync(KEY);
}

function replaceAll(items) {
  const normalized = (items || [])
    .filter((item) => item && item.id && !item.isDeleted)
    .map(normalizeItem);
  saveAll(normalized);
  return getAll();
}

function mergeRemoteItems(remoteItems) {
  const itemsById = new Map(readAll().map((item) => [item.id, item]));
  (remoteItems || []).forEach((remoteItem) => {
    if (!remoteItem || !remoteItem.id) return;
    const localItem = itemsById.get(remoteItem.id);
    const remoteVersion = Number(remoteItem.version || 0);
    const localVersion = Number(localItem && localItem.version || 0);
    const remoteUpdatedAt = Number(remoteItem.updatedAt || 0);
    const localUpdatedAt = Number(localItem && localItem.updatedAt || 0);
    if (remoteItem.isDeleted) {
      if (
        !localItem ||
        remoteVersion > localVersion ||
        (remoteVersion === localVersion && remoteUpdatedAt >= localUpdatedAt)
      ) {
        itemsById.delete(remoteItem.id);
      }
      return;
    }
    if (
      !localItem ||
      remoteVersion > localVersion ||
      (remoteVersion === localVersion && remoteUpdatedAt >= localUpdatedAt)
    ) {
      itemsById.set(remoteItem.id, normalizeItem(remoteItem));
    }
  });
  saveAll([...itemsById.values()]);
  return getAll();
}

function getById(id) {
  return readAll().find((item) => item.id === id);
}

function add(data) {
  const now = data.createdAt || Date.now();
  const item = {
    id: data.id || `inspiration-${now}-${Math.random().toString(16).slice(2, 8)}`,
    content: data.content || "",
    images: data.images || [],
    thumbnails: data.thumbnails || data.images || [],
    imageFingerprints: data.imageFingerprints || [],
    imageTag: data.imageTag || "",
    type: data.images && data.images.length ? "image" : "sentence",
    source: data.source || "",
    note: data.note || "",
    isPinned: Boolean(data.isPinned),
    isFavorite: data.isFavorite !== false,
    isUsed: Boolean(data.isUsed),
    isDeleted: false,
    createdAt: now,
    updatedAt: data.updatedAt || now,
    usedAt: data.usedAt || null,
    version: Number(data.version || 1)
  };
  const items = readAll();
  saveAll([item, ...items.filter((existing) => existing.id !== item.id)]);
  return item;
}

function update(id, patch) {
  const now = Date.now();
  const items = readAll();
  const next = items.map((item) =>
    item.id === id ? { ...item, ...patch, updatedAt: patch.updatedAt || now } : item
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
  const thumbnails = (item.thumbnails || []).filter((_, index) => index !== imageIndex);
  const imageFingerprints = (item.imageFingerprints || []).filter(
    (_, index) => index !== imageIndex
  );
  return update(id, {
    images,
    thumbnails,
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

restoreOwner();

module.exports = {
  getAll,
  getById,
  getLegacyAll,
  clearLegacy,
  getSyncMeta,
  setSyncMeta,
  mergeRemoteItems,
  replaceAll,
  setOwner,
  add,
  update,
  backfillImageFingerprints,
  remove,
  removeImage,
  search,
  hasContent,
  formatDate
};
