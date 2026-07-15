const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const collection = db.collection("inspirations");
const PAGE_SIZE = 100;
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
      : []
  };
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
    const error = new Error("图片文件归属校验失败");
    error.code = "INVALID_IMAGE_FILE";
    throw error;
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
    const error = new Error("无权访问这条灵感");
    error.code = "FORBIDDEN";
    throw error;
  }
  return { documentId, document: result.data };
}

async function listItems(openid) {
  const items = [];
  let offset = 0;
  while (true) {
    const result = await collection
      .where({ ownerOpenId: openid })
      .skip(offset)
      .limit(PAGE_SIZE)
      .get();
    const page = result.data || [];
    items.push(...page.map(toClientItem));
    if (page.length < PAGE_SIZE) break;
    offset += page.length;
  }
  return items.sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    return Number(b.createdAt || 0) - Number(a.createdAt || 0);
  });
}

async function upsertItem(openid, item) {
  const clientId = safeId(item && item.id);
  if (!clientId) throw new Error("缺少灵感 ID");
  const documentId = getDocumentId(openid, clientId);
  const fields = pickFields(item);
  if (Object.prototype.hasOwnProperty.call(fields, "images")) {
    fields.images = validateImages(openid, fields.images);
  }
  await collection.doc(documentId).set({
    data: {
      ...fields,
      clientId,
      ownerOpenId: openid
    }
  });
  return { id: clientId };
}

async function updateItem(openid, id, patch) {
  const { documentId, document } = await getOwnedDocument(openid, id);
  const nextPatch = pickFields(patch || {});
  if (Object.prototype.hasOwnProperty.call(nextPatch, "images")) {
    nextPatch.images = validateImages(openid, nextPatch.images);
  }
  await collection.doc(documentId).update({ data: nextPatch });
  if (Object.prototype.hasOwnProperty.call(nextPatch, "images")) {
    const nextImages = new Set(nextPatch.images || []);
    const removedImages = (document.images || []).filter(
      (fileID) => isCloudFile(fileID) && !nextImages.has(fileID)
    );
    await deleteFiles(openid, removedImages);
  }
  return { id };
}

async function removeItem(openid, id) {
  const { documentId, document } = await getOwnedDocument(openid, id);
  await collection.doc(documentId).remove();
  await deleteFiles(openid, document.images || []);
  return { id };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  try {
    switch (event.action) {
      case "session":
        return { ok: true, data: { openid: OPENID } };
      case "list":
        return { ok: true, data: await listItems(OPENID) };
      case "upsert":
        return { ok: true, data: await upsertItem(OPENID, event.item) };
      case "update":
        return { ok: true, data: await updateItem(OPENID, event.id, event.patch) };
      case "remove":
        return { ok: true, data: await removeItem(OPENID, event.id) };
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
      message: error.message || error.errMsg || "云端操作失败"
    };
  }
};
