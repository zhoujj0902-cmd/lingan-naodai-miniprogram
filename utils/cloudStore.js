const imageUtils = require("./image");
const security = require("./security");
const store = require("./store");

const FUNCTION_NAME = "inspirationData";
const MIGRATION_VERSION = 1;
const PAGINATION_VERSION = 2;
const PAGE_SIZE = 30;
const MAX_CONCURRENT_UPLOADS = 2;
let sessionPromise = null;

function createId() {
  return `inspiration-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function safePathPart(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 80);
}

function getFileExt(filePath) {
  const match = String(filePath || "").match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
  const ext = match ? match[1].toLowerCase() : "jpg";
  return ["jpg", "jpeg", "png", "gif", "webp", "bmp"].includes(ext) ? ext : "jpg";
}

function getFingerprintSuffix(fingerprint) {
  const value = String(fingerprint || "").split(":").pop() || "";
  return safePathPart(value.slice(0, 16)) || Math.random().toString(16).slice(2, 10);
}

function getMigrationKey(openid) {
  return `cloudMigrationV${MIGRATION_VERSION}:${openid}`;
}

function callDataFunction(action, data = {}) {
  if (!wx.cloud || !wx.cloud.callFunction) {
    return Promise.reject(new Error("云开发不可用"));
  }
  return wx.cloud.callFunction({
    name: FUNCTION_NAME,
    data: { action, ...data }
  }).then((res) => {
    const result = res.result || {};
    if (!result.ok) {
      const error = new Error(result.message || "云端操作失败");
      error.code = result.code || "";
      error.data = result.data || null;
      error.latest = result.data && result.data.latest || null;
      error.isCloudOperationFailure = true;
      throw error;
    }
    return result.data;
  });
}

function getSession() {
  if (!sessionPromise) {
    sessionPromise = callDataFunction("session").catch((error) => {
      sessionPromise = null;
      throw error;
    });
  }
  return sessionPromise;
}

async function activateSession() {
  const session = await getSession();
  store.setOwner(session.openid);
  return session;
}

function uploadFile(cloudPath, filePath) {
  return new Promise((resolve, reject) => {
    wx.cloud.uploadFile({
      cloudPath,
      filePath,
      success: (res) => {
        if (res.fileID) resolve(res.fileID);
        else reject(new Error("图片上传失败"));
      },
      fail: (error) => reject(error)
    });
  });
}

function deleteCloudFiles(fileIDs) {
  const cloudFiles = [...new Set((fileIDs || []).filter(imageUtils.isCloudFile))];
  if (!cloudFiles.length || !wx.cloud || !wx.cloud.deleteFile) return Promise.resolve();
  return new Promise((resolve) => {
    wx.cloud.deleteFile({
      fileList: cloudFiles,
      complete: () => resolve()
    });
  });
}

async function uploadImages(images, itemId, imageFingerprints) {
  const session = await activateSession();
  const sourceImages = (images || []).filter(Boolean);
  const result = new Array(sourceImages.length);
  const uploadedFileIDs = [];
  let nextIndex = 0;
  let firstError = null;
  const workerCount = Math.min(MAX_CONCURRENT_UPLOADS, sourceImages.length);
  const workers = new Array(workerCount).fill(null).map(async () => {
    while (nextIndex < sourceImages.length && !firstError) {
      const index = nextIndex;
      nextIndex += 1;
      const image = sourceImages[index];
      if (imageUtils.isCloudFile(image)) {
        result[index] = image;
        continue;
      }
      try {
        const cloudPath = [
          "users",
          safePathPart(session.openid),
          "inspirations",
          safePathPart(itemId),
          `${String(index).padStart(2, "0")}-${getFingerprintSuffix(imageFingerprints[index])}.${getFileExt(image)}`
        ].join("/");
        const fileID = await uploadFile(cloudPath, image);
        result[index] = fileID;
        uploadedFileIDs.push(fileID);
      } catch (error) {
        firstError = error;
      }
    }
  });
  await Promise.all(workers);
  if (firstError) {
    await deleteCloudFiles(uploadedFileIDs);
    throw firstError;
  }
  return { images: result, uploadedFileIDs };
}

function removeLocalFiles(images) {
  const localFiles = (images || []).filter((image) => image && !imageUtils.isCloudFile(image));
  return Promise.all(localFiles.map(imageUtils.removeSavedImage));
}

function buildItem(data, id, images) {
  const now = Date.now();
  return {
    id,
    content: data.content || "",
    images: images || [],
    imageFingerprints: data.imageFingerprints || [],
    imageTag: data.imageTag || "",
    type: images && images.length ? "image" : "sentence",
    source: data.source || "",
    note: data.note || "",
    isPinned: Boolean(data.isPinned),
    isFavorite: data.isFavorite !== false,
    isUsed: Boolean(data.isUsed),
    isDeleted: false,
    createdAt: data.createdAt || now,
    updatedAt: data.updatedAt || now,
    usedAt: data.usedAt || null,
    version: Number(data.version || 1)
  };
}

function getBaseValues(item, patch) {
  const result = {};
  Object.keys(patch || {}).forEach((field) => {
    if (field !== "updatedAt") result[field] = item[field];
  });
  return result;
}

async function createItem(data, options = {}) {
  const id = data.id || createId();
  const localImages = data.images || [];
  const uploadResult = await uploadImages(localImages, id, data.imageFingerprints || []);
  const item = buildItem(data, id, uploadResult.images);
  let savedItem;
  try {
    savedItem = await callDataFunction(options.isMigration ? "import" : "upsert", { item });
  } catch (error) {
    if (error.isCloudOperationFailure) {
      await deleteCloudFiles(uploadResult.uploadedFileIDs);
    }
    throw error;
  }
  if (!savedItem || !Array.isArray(savedItem.images)) {
    savedItem = item;
  }
  store.add(savedItem);
  await removeLocalFiles(localImages);
  return savedItem;
}

async function updateItem(item, patch, editImages, imageFingerprints, options = {}) {
  const sourceImages = editImages || item.images || [];
  const uploadResult = await uploadImages(sourceImages, item.id, imageFingerprints || []);
  const nextPatch = {
    ...patch,
    images: uploadResult.images,
    imageFingerprints: imageFingerprints || [],
    type: uploadResult.images.length ? "image" : "sentence"
  };
  let savedItem;
  try {
    savedItem = await callDataFunction("update", {
      id: item.id,
      patch: nextPatch,
      baseVersion: Number(item.version || 0),
      baseValues: getBaseValues(item, nextPatch),
      force: Boolean(options.force)
    });
  } catch (error) {
    if (error.isCloudOperationFailure) {
      await deleteCloudFiles(uploadResult.uploadedFileIDs);
    }
    throw error;
  }
  if (!savedItem || !Array.isArray(savedItem.images)) {
    savedItem = {
      ...item,
      ...nextPatch,
      updatedAt: Date.now(),
      version: Number(item.version || 1) + 1
    };
  }
  store.mergeRemoteItems([savedItem]);
  await removeLocalFiles(sourceImages);
  return store.getById(item.id);
}

async function updateFields(id, patch) {
  await activateSession();
  const item = store.getById(id);
  if (!item) throw new Error("本地缓存中找不到这条灵感");
  try {
    const savedItem = await callDataFunction("update", {
      id,
      patch,
      baseVersion: Number(item.version || 0),
      baseValues: getBaseValues(item, patch)
    });
    store.mergeRemoteItems([savedItem]);
    return store.getById(id);
  } catch (error) {
    if (error.code === "CONFLICT" && error.latest) {
      store.mergeRemoteItems([error.latest]);
    }
    throw error;
  }
}

async function removeItem(item, options = {}) {
  await activateSession();
  try {
    await callDataFunction("remove", {
      id: item.id,
      baseVersion: Number(item.version || 0),
      force: Boolean(options.force)
    });
  } catch (error) {
    if (error.code === "CONFLICT" && error.latest) {
      store.mergeRemoteItems([error.latest]);
    }
    throw error;
  }
  store.remove(item.id);
  await removeLocalFiles(item.images || []);
}

async function listRemoteItems() {
  const items = await callDataFunction("list");
  return (items || []).filter((item) => item && item.id);
}

async function listRemotePage(cursor = "") {
  try {
    const result = await callDataFunction("listPage", { cursor, pageSize: PAGE_SIZE });
    return {
      items: (result && result.items || []).filter((item) => item && item.id),
      nextCursor: result && result.nextCursor || "",
      hasMore: Boolean(result && result.hasMore),
      syncCursor: Number(result && result.syncCursor || 0)
    };
  } catch (error) {
    if (error.code !== "INVALID_ACTION") throw error;
    return {
      items: await listRemoteItems(),
      nextCursor: "",
      hasMore: false,
      syncCursor: Date.now()
    };
  }
}

async function listRemoteChanges(since) {
  try {
    const result = await callDataFunction("changes", { since: Number(since || 0) });
    return {
      items: (result && result.items || []).filter((item) => item && item.id),
      syncCursor: Number(result && result.syncCursor || 0),
      isFullSnapshot: false
    };
  } catch (error) {
    if (error.code !== "INVALID_ACTION") throw error;
    return {
      items: await listRemoteItems(),
      syncCursor: Date.now(),
      isFullSnapshot: true
    };
  }
}

async function migrateItem(item) {
  const images = (item.images || []).filter(Boolean);
  const localImages = images.filter((image) => !imageUtils.isCloudFile(image));
  let imageFingerprints = item.imageFingerprints || [];
  const fingerprintsNeedRefresh =
    localImages.length > 0 &&
    (imageFingerprints.length !== images.length ||
      images.some(
        (image, index) =>
          !imageUtils.isCloudFile(image) &&
          !imageUtils.isCurrentImageFingerprint(imageFingerprints[index])
      ));
  if (fingerprintsNeedRefresh) {
    imageFingerprints = await imageUtils.getImageFingerprints(images);
  }
  if (localImages.length) {
    const checkResult = await security.checkImages(localImages);
    if (!checkResult.pass) {
      throw new Error(
        checkResult.unsafeCount ? "旧图片未通过安全检测" : "旧图片安全检测暂时失败"
      );
    }
  }
  return createItem({ ...item, images, imageFingerprints }, { isMigration: true });
}

async function migrateLegacyItems(legacyItems, session) {
  const migrationKey = getMigrationKey(session.openid);
  if (wx.getStorageSync(migrationKey)) {
    return { didMigrate: false, migratedCount: 0 };
  }
  let remoteItems = await listRemoteItems();
  let migratedCount = 0;
  const remoteById = new Map(remoteItems.map((item) => [item.id, item]));
  const userCacheItems = store.getAll();
  const localById = new Map();
  [...legacyItems, ...userCacheItems].forEach((item) => localById.set(item.id, item));
  for (const item of localById.values()) {
    const remoteItem = remoteById.get(item.id);
    if (remoteItem) {
      store.mergeRemoteItems([remoteItem]);
      await removeLocalFiles(item.images || []);
    } else {
      await migrateItem(item);
      migratedCount += 1;
    }
  }
  wx.setStorageSync(migrationKey, true);
  store.clearLegacy();
  remoteItems = await listRemoteItems();
  store.replaceAll(remoteItems);
  const firstPage = await listRemotePage();
  store.setSyncMeta({
    paginationVersion: PAGINATION_VERSION,
    nextCursor: "",
    hasMore: false,
    lastSyncAt: firstPage.syncCursor,
    lastSyncedAt: Date.now()
  });
  return { didMigrate: true, migratedCount };
}

async function syncAll() {
  const legacyItems = store.getLegacyAll();
  const session = await activateSession();
  const migration = await migrateLegacyItems(legacyItems, session);
  if (migration.didMigrate) {
    return {
      items: store.getAll(),
      migratedCount: migration.migratedCount,
      hasMore: false
    };
  }

  const meta = store.getSyncMeta();
  const firstPage = await listRemotePage();
  const isPaginationInitialized = meta.paginationVersion === PAGINATION_VERSION;
  if (!isPaginationInitialized) {
    store.replaceAll(firstPage.items);
  } else {
    if (meta.lastSyncAt) {
      const changes = await listRemoteChanges(meta.lastSyncAt);
      if (changes.isFullSnapshot) store.replaceAll(changes.items);
      else store.mergeRemoteItems(changes.items);
      meta.lastSyncAt = changes.syncCursor;
    } else {
      meta.lastSyncAt = firstPage.syncCursor;
    }
    store.mergeRemoteItems(firstPage.items);
  }
  store.setSyncMeta({
    paginationVersion: PAGINATION_VERSION,
    nextCursor: isPaginationInitialized ? meta.nextCursor : firstPage.nextCursor,
    hasMore: isPaginationInitialized ? meta.hasMore : firstPage.hasMore,
    lastSyncAt: meta.lastSyncAt || firstPage.syncCursor,
    lastSyncedAt: Date.now()
  });
  return {
    items: store.getAll(),
    migratedCount: 0,
    hasMore: isPaginationInitialized ? meta.hasMore : firstPage.hasMore
  };
}

async function loadNextPage() {
  await activateSession();
  const meta = store.getSyncMeta();
  if (meta.paginationVersion !== PAGINATION_VERSION || !meta.hasMore) {
    return { items: store.getAll(), hasMore: false, loadedCount: 0 };
  }
  const page = await listRemotePage(meta.nextCursor);
  store.mergeRemoteItems(page.items);
  store.setSyncMeta({
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    lastSyncedAt: Date.now()
  });
  return {
    items: store.getAll(),
    hasMore: page.hasMore,
    loadedCount: page.items.length
  };
}

async function getPreviewUrls(images) {
  const sourceImages = (images || []).filter(Boolean);
  const cloudFiles = sourceImages.filter(imageUtils.isCloudFile);
  if (!cloudFiles.length || !wx.cloud || !wx.cloud.getTempFileURL) return sourceImages;
  try {
    const res = await wx.cloud.getTempFileURL({ fileList: cloudFiles });
    const urlByFileID = new Map(
      (res.fileList || []).map((item) => [item.fileID, item.tempFileURL || item.fileID])
    );
    return sourceImages.map((image) => urlByFileID.get(image) || image);
  } catch (error) {
    return sourceImages;
  }
}

function isConflict(error) {
  return Boolean(error && error.code === "CONFLICT");
}

module.exports = {
  createItem,
  getPreviewUrls,
  getSession,
  isConflict,
  listRemoteItems,
  loadNextPage,
  removeItem,
  syncAll,
  updateFields,
  updateItem
};
