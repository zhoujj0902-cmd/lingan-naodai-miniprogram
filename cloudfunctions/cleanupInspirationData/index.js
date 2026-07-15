const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const collection = db.collection("inspirations");
const PAGE_SIZE = 100;
const DELETE_BATCH_SIZE = 50;
const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function isCloudFile(fileID) {
  return String(fileID || "").startsWith("cloud://");
}

async function getAllDocuments() {
  const documents = [];
  let offset = 0;
  while (true) {
    const result = await collection.skip(offset).limit(PAGE_SIZE).get();
    const page = result.data || [];
    documents.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += page.length;
  }
  return documents;
}

async function deleteFileBatch(fileIDs) {
  try {
    const result = await cloud.deleteFile({ fileList: fileIDs });
    const failed = new Set(
      (result.fileList || [])
        .filter((item) => Number(item.status) !== 0 && item.status !== "success")
        .map((item) => item.fileID)
    );
    return fileIDs.filter((fileID) => !failed.has(fileID));
  } catch (error) {
    console.error("scheduled file cleanup failed", {
      fileCount: fileIDs.length,
      message: error.message || error.errMsg || ""
    });
    return [];
  }
}

async function cleanDocumentFiles(document) {
  const queuedFiles = [...new Set((document.cleanupFileIDs || []).filter(isCloudFile))];
  if (!queuedFiles.length) return 0;
  const deletedFiles = [];
  for (let index = 0; index < queuedFiles.length; index += DELETE_BATCH_SIZE) {
    const batch = queuedFiles.slice(index, index + DELETE_BATCH_SIZE);
    deletedFiles.push(...await deleteFileBatch(batch));
  }
  if (!deletedFiles.length) return 0;

  const latestResult = await collection.doc(document._id).get();
  const latest = latestResult.data || {};
  const deletedSet = new Set(deletedFiles);
  const remainingFiles = (latest.cleanupFileIDs || []).filter(
    (fileID) => !deletedSet.has(fileID)
  );
  await collection.doc(document._id).update({
    data: { cleanupFileIDs: remainingFiles }
  });
  return deletedFiles.length;
}

async function removeExpiredTombstone(document, cutoff) {
  if (!document.isDeleted || Number(document.updatedAt || 0) >= cutoff) return false;
  const latestResult = await collection.doc(document._id).get();
  const latest = latestResult.data || {};
  if (
    !latest.isDeleted ||
    Number(latest.updatedAt || 0) >= cutoff ||
    (latest.cleanupFileIDs || []).length
  ) {
    return false;
  }
  await collection.doc(document._id).remove();
  return true;
}

exports.main = async () => {
  const documents = await getAllDocuments();
  const cutoff = Date.now() - TOMBSTONE_RETENTION_MS;
  let deletedFileCount = 0;
  let removedTombstoneCount = 0;
  for (const document of documents) {
    if (document.documentType === "settings") continue;
    deletedFileCount += await cleanDocumentFiles(document);
    if (await removeExpiredTombstone(document, cutoff)) {
      removedTombstoneCount += 1;
    }
  }
  const result = {
    scannedCount: documents.length,
    deletedFileCount,
    removedTombstoneCount
  };
  console.log("inspiration cleanup completed", result);
  return result;
};
