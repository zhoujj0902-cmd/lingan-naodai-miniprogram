const imageUtils = require("./image");
const security = require("./security");
const store = require("./store");

const FUNCTION_NAME = "inspirationData";
const MIGRATION_VERSION = 1;
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
    usedAt: data.usedAt || null
  };
}

async function createItem(data) {
  const id = data.id || createId();
  const localImages = data.images || [];
  const uploadResult = await uploadImages(localImages, id, data.imageFingerprints || []);
  const item = buildItem(data, id, uploadResult.images);
  try {
    await callDataFunction("upsert", { item });
  } catch (error) {
    // A rejected cloud call can have an unknown final state. Only clean up when
    // the function explicitly confirms that the database operation failed.
    if (error.isCloudOperationFailure) {
      await deleteCloudFiles(uploadResult.uploadedFileIDs);
    }
    throw error;
  }
  store.add(item);
  await removeLocalFiles(localImages);
  return item;
}

async function updateItem(item, patch, editImages, imageFingerprints) {
  const sourceImages = editImages || item.images || [];
  const uploadResult = await uploadImages(sourceImages, item.id, imageFingerprints || []);
  const nextPatch = {
    ...patch,
    images: uploadResult.images,
    imageFingerprints: imageFingerprints || [],
    type: uploadResult.images.length ? "image" : "sentence",
    updatedAt: Date.now()
  };
  try {
    await callDataFunction("update", { id: item.id, patch: nextPatch });
  } catch (error) {
    if (error.isCloudOperationFailure) {
      await deleteCloudFiles(uploadResult.uploadedFileIDs);
    }
    throw error;
  }
  const updated = store.update(item.id, nextPatch);
  await removeLocalFiles(sourceImages);
  return updated;
}

async function updateFields(id, patch) {
  await activateSession();
  const nextPatch = { ...patch, updatedAt: Date.now() };
  await callDataFunction("update", { id, patch: nextPatch });
  return store.update(id, nextPatch);
}

async function removeItem(item) {
  await activateSession();
  await callDataFunction("remove", { id: item.id });
  store.remove(item.id);
  await removeLocalFiles(item.images || []);
}

async function listRemoteItems() {
  const items = await callDataFunction("list");
  return (items || []).filter((item) => item && item.id);
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
  return createItem({ ...item, images, imageFingerprints });
}

async function syncAll() {
  const legacyItems = store.getLegacyAll();
  const session = await activateSession();
  const migrationKey = getMigrationKey(session.openid);
  let remoteItems = await listRemoteItems();
  let migratedCount = 0;

  if (!wx.getStorageSync(migrationKey)) {
    const remoteById = new Map(remoteItems.map((item) => [item.id, item]));
    const userCacheItems = store.getAll();
    const localById = new Map();
    [...legacyItems, ...userCacheItems].forEach((item) => localById.set(item.id, item));
    const localItems = [...localById.values()];
    for (const item of localItems) {
      const remoteItem = remoteById.get(item.id);
      if (remoteItem) {
        store.update(item.id, remoteItem);
        await removeLocalFiles(item.images || []);
      } else {
        await migrateItem(item);
        migratedCount += 1;
      }
    }
    wx.setStorageSync(migrationKey, true);
    store.clearLegacy();
    remoteItems = await listRemoteItems();
  }

  store.replaceAll(remoteItems);
  return { items: store.getAll(), migratedCount };
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

module.exports = {
  createItem,
  getPreviewUrls,
  getSession,
  listRemoteItems,
  removeItem,
  syncAll,
  updateFields,
  updateItem
};
