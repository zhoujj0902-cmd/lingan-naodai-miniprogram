const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const command = db.command;
const collection = db.collection("inspirations");
const PAGE_SIZE = 100;
const DEFAULT_CLIENT_PAGE_SIZE = 30;
const MAX_CLIENT_PAGE_SIZE = 50;
const EDITABLE_FIELDS = [
  "content",
  "images",
  "imageFingerprints",
  "imageTag",
  "type",
  "source",
  "note",
  "isPinned",
  "isFavorite",
  "isUsed",
  "isDeleted",
  "createdAt",
  "updatedAt",
  "usedAt"
];

function safeId(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 120);
}

function getDocumentId(openid, id) {
  return `${safeId(openid)}_${safeId(id)}`;
}

function pickFields(source) {
  const result = {};
  EDITABLE_FIELDS.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(source || {}, field)) {
      result[field] = source[field];
    }
  });
  return result;
}

function toClientItem(document) {
  const item = pickFields(document);
  return {
    id: document.clientId,
    ...item,
    images: Array.isArray(item.images) ? item.images : [],
    imageFingerprints: Array.isArray(item.imageFingerprints)
      ? item.imageFingerprints
      : [],
    version: Math.max(1, Number(document.version || 1))
  };
}

function createError(code, message, data) {
  const error = new Error(message);
  error.code = code;
  error.data = data;
  return error;
}

function valuesEqual(left, right) {
  if (left === right) return true;
  return JSON.stringify(left) === JSON.stringify(right);
}

function isCloudFile(fileID) {
  return String(fileID || "").startsWith("cloud://");
}

function isOwnedCloudFile(openid, fileID) {
  const ownedPath = `/users/${safeId(openid)}/inspirations/`;
  return isCloudFile(fileID) && String(fileID).includes(ownedPath);
}

function validateImages(openid, images) {
  if (!Array.isArray(images)) return [];
  if (images.some((fileID) => !isOwnedCloudFile(openid, fileID))) {
    throw createError("INVALID_IMAGE_FILE", "图片文件归属校验失败");
  }
  return images;
}

async function deleteFiles(openid, fileIDs) {
  const files = [
    ...new Set((fileIDs || []).filter((fileID) => isOwnedCloudFile(openid, fileID)))
  ];
  if (!files.length) return;
  try {
    await cloud.deleteFile({ fileList: files });
  } catch (error) {
    console.error("delete inspiration files failed", {
      fileCount: files.length,
      code: error.code || error.errCode || "",
      message: error.message || error.errMsg || ""
    });
  }
}

async function getOwnedDocument(openid, id) {
  const documentId = getDocumentId(openid, id);
  const result = await collection.doc(documentId).get();
  if (!result.data || result.data.ownerOpenId !== openid) {
    throw createError("FORBIDDEN", "无权访问这条灵感");
  }
  return { documentId, document: result.data };
}

async function getDocumentsByOwner(openid) {
  const documents = [];
  let offset = 0;
  while (true) {
    const result = await collection
      .where({ ownerOpenId: openid })
      .skip(offset)
      .limit(PAGE_SIZE)
      .get();
    const page = result.data || [];
    documents.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += page.length;
  }
  return documents;
}

async function listItems(openid) {
  const documents = await getDocumentsByOwner(openid);
  return documents
    .filter((document) => !document.isDeleted)
    .map(toClientItem)
    .sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      return Number(b.createdAt || 0) - Number(a.createdAt || 0);
    });
}

async function queryPage(openid, cursor, pageSize) {
  const query = { ownerOpenId: openid };
  if (cursor) query._id = command.lt(cursor);
  return collection
    .where(query)
    .orderBy("_id", "desc")
    .limit(pageSize)
    .get();
}

async function listPage(openid, cursor, requestedPageSize) {
  const pageSize = Math.min(
    MAX_CLIENT_PAGE_SIZE,
    Math.max(1, Number(requestedPageSize || DEFAULT_CLIENT_PAGE_SIZE))
  );
  const snapshotAt = Date.now();
  let activeDocuments = [];
  let scanCursor = String(cursor || "");
  let exhausted = false;

  try {
    while (activeDocuments.length <= pageSize && !exhausted) {
      const result = await queryPage(openid, scanCursor, pageSize + 1);
      const documents = result.data || [];
      if (!documents.length) {
        exhausted = true;
        break;
      }
      activeDocuments.push(...documents.filter((document) => !document.isDeleted));
      scanCursor = documents[documents.length - 1]._id;
      exhausted = documents.length < pageSize + 1;
    }
  } catch (error) {
    console.warn("paged query fallback", error.message || error.errMsg || error);
    const documents = (await getDocumentsByOwner(openid))
      .filter((document) => !document.isDeleted)
      .sort((a, b) => String(b._id).localeCompare(String(a._id)));
    const startIndex = cursor
      ? documents.findIndex((document) => String(document._id) < String(cursor))
      : 0;
    activeDocuments = startIndex < 0 ? [] : documents.slice(startIndex, startIndex + pageSize + 1);
    exhausted = activeDocuments.length <= pageSize;
  }

  const pageDocuments = activeDocuments.slice(0, pageSize);
  const hasMore = activeDocuments.length > pageSize || !exhausted;
  return {
    items: pageDocuments.map(toClientItem),
    nextCursor: hasMore && pageDocuments.length
      ? pageDocuments[pageDocuments.length - 1]._id
      : "",
    hasMore,
    syncCursor: snapshotAt
  };
}

async function listChanges(openid, since) {
  const syncCursor = Date.now();
  let documents = [];
  let offset = 0;
  try {
    while (true) {
      const result = await collection
        .where({
          ownerOpenId: openid,
          updatedAt: command.gt(Number(since || 0)).and(command.lte(syncCursor))
        })
        .skip(offset)
        .limit(PAGE_SIZE)
        .get();
      const page = result.data || [];
      documents.push(...page);
      if (page.length < PAGE_SIZE) break;
      offset += page.length;
    }
  } catch (error) {
    console.warn("incremental query fallback", error.message || error.errMsg || error);
    documents = (await getDocumentsByOwner(openid)).filter((document) => {
      const updatedAt = Number(document.updatedAt || 0);
      return updatedAt > Number(since || 0) && updatedAt <= syncCursor;
    });
  }
  return { items: documents.map(toClientItem), syncCursor };
}

async function assertNoDuplicate(openid, item, excludeId = "") {
  const content = String(item.content || "").trim();
  const fingerprints = new Set((item.imageFingerprints || []).filter(Boolean));
  if (!content && !fingerprints.size) return;
  const documents = await getDocumentsByOwner(openid);
  for (const document of documents) {
    if (document.isDeleted || document.clientId === excludeId) continue;
    if (content && String(document.content || "").trim() === content) {
      throw createError("DUPLICATE_CONTENT", "这段文案已经在脑袋里");
    }
    if (
      fingerprints.size &&
      (document.imageFingerprints || []).some((fingerprint) => fingerprints.has(fingerprint))
    ) {
      throw createError("DUPLICATE_IMAGE", "图片已经在脑袋里");
    }
  }
}

async function upsertItem(openid, item, skipDuplicateCheck = false) {
  const clientId = safeId(item && item.id);
  if (!clientId) throw new Error("缺少灵感 ID");
  const documentId = getDocumentId(openid, clientId);
  const now = Date.now();
  const fields = pickFields(item);
  if (Object.prototype.hasOwnProperty.call(fields, "images")) {
    fields.images = validateImages(openid, fields.images);
  }
  const document = {
    ...fields,
    clientId,
    ownerOpenId: openid,
    isDeleted: false,
    createdAt: Number(fields.createdAt || now),
    updatedAt: now,
    version: 1
  };
  if (!skipDuplicateCheck) {
    await assertNoDuplicate(openid, document, clientId);
  }
  await collection.doc(documentId).set({ data: document });
  return toClientItem({ _id: documentId, ...document });
}

function canMergePatch(document, nextPatch, baseValues) {
  const comparableFields = Object.keys(nextPatch).filter((field) => field !== "updatedAt");
  return comparableFields.every(
    (field) =>
      Object.prototype.hasOwnProperty.call(baseValues || {}, field) &&
      valuesEqual(document[field], baseValues[field])
  );
}

function throwConflict(document) {
  throw createError("CONFLICT", "这条灵感已在其他设备更新", {
    latest: toClientItem(document)
  });
}

function getVersionCondition(document) {
  return document.version === undefined || document.version === null
    ? command.exists(false)
    : Math.max(1, Number(document.version || 1));
}

async function updateDocumentAtVersion(documentId, openid, document, patch) {
  const result = await collection.where({
    _id: documentId,
    ownerOpenId: openid,
    version: getVersionCondition(document)
  }).update({ data: patch });
  return !result.stats || Number(result.stats.updated || 0) > 0;
}

async function updateItem(openid, id, patch, options = {}) {
  const nextPatch = pickFields(patch || {});
  if (Object.prototype.hasOwnProperty.call(nextPatch, "images")) {
    nextPatch.images = validateImages(openid, nextPatch.images);
  }
  const baseVersion = Number(options.baseVersion || 0);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { documentId, document } = await getOwnedDocument(openid, id);
    if (document.isDeleted) throwConflict(document);
    const currentVersion = Math.max(1, Number(document.version || 1));
    if (
      baseVersion > 0 &&
      baseVersion !== currentVersion &&
      !options.force &&
      !canMergePatch(document, nextPatch, options.baseValues)
    ) {
      throwConflict(document);
    }

    const nextDocument = { ...document, ...nextPatch };
    if (
      Object.prototype.hasOwnProperty.call(nextPatch, "content") ||
      Object.prototype.hasOwnProperty.call(nextPatch, "imageFingerprints")
    ) {
      await assertNoDuplicate(openid, nextDocument, id);
    }

    const serverPatch = {
      ...nextPatch,
      updatedAt: Date.now(),
      version: currentVersion + 1
    };
    const hasUpdated = await updateDocumentAtVersion(
      documentId,
      openid,
      document,
      serverPatch
    );
    if (!hasUpdated) continue;
    if (Object.prototype.hasOwnProperty.call(serverPatch, "images")) {
      const nextImages = new Set(serverPatch.images || []);
      const removedImages = (document.images || []).filter(
        (fileID) => isCloudFile(fileID) && !nextImages.has(fileID)
      );
      await deleteFiles(openid, removedImages);
    }
    return toClientItem({ ...document, ...serverPatch });
  }
  const { document } = await getOwnedDocument(openid, id);
  throwConflict(document);
}

async function removeItem(openid, id, options = {}) {
  const baseVersion = Number(options.baseVersion || 0);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { documentId, document } = await getOwnedDocument(openid, id);
    const currentVersion = Math.max(1, Number(document.version || 1));
    if (baseVersion > 0 && baseVersion !== currentVersion && !options.force) {
      throwConflict(document);
    }
    const tombstone = {
      isDeleted: true,
      images: [],
      imageFingerprints: [],
      updatedAt: Date.now(),
      version: currentVersion + 1
    };
    const hasUpdated = await updateDocumentAtVersion(
      documentId,
      openid,
      document,
      tombstone
    );
    if (!hasUpdated) continue;
    await deleteFiles(openid, document.images || []);
    return toClientItem({ ...document, ...tombstone });
  }
  const { document } = await getOwnedDocument(openid, id);
  throwConflict(document);
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  try {
    switch (event.action) {
      case "session":
        return { ok: true, data: { openid: OPENID } };
      case "list":
        return { ok: true, data: await listItems(OPENID) };
      case "listPage":
        return {
          ok: true,
          data: await listPage(OPENID, event.cursor, event.pageSize)
        };
      case "changes":
        return { ok: true, data: await listChanges(OPENID, event.since) };
      case "upsert":
        return { ok: true, data: await upsertItem(OPENID, event.item) };
      case "import":
        return { ok: true, data: await upsertItem(OPENID, event.item, true) };
      case "update":
        return {
          ok: true,
          data: await updateItem(OPENID, event.id, event.patch, event)
        };
      case "remove":
        return {
          ok: true,
          data: await removeItem(OPENID, event.id, event)
        };
      default:
        return { ok: false, code: "INVALID_ACTION", message: "不支持的云端操作" };
    }
  } catch (error) {
    console.error("inspirationData failed", {
      action: event.action,
      code: error.code || error.errCode || "",
      message: error.message || error.errMsg || ""
    });
    return {
      ok: false,
      code: error.code || error.errCode || "CLOUD_ERROR",
      message: error.message || error.errMsg || "云端操作失败",
      data: error.data || null
    };
  }
};
