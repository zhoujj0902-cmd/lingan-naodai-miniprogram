const imageUtils = require("./image");

const MAX_SECURITY_IMAGE_SIZE = 500 * 1024;
const MAX_CONCURRENT_CHECKS = 3;
const imageCheckCache = new Map();

function getImageContentType(filePath) {
  const lowerPath = String(filePath || "").toLowerCase();
  if (lowerPath.endsWith(".png")) return "image/png";
  if (lowerPath.endsWith(".gif")) return "image/gif";
  if (lowerPath.endsWith(".bmp")) return "image/bmp";
  return "image/jpeg";
}

function getFileExt(filePath) {
  const match = String(filePath || "").match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
  return match ? match[1].toLowerCase() : "jpg";
}

function uploadSecurityImage(filePath) {
  const cloudPath = `security-check/${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}.${getFileExt(filePath)}`;
  return new Promise((resolve) => {
    wx.cloud.uploadFile({
      cloudPath,
      filePath,
      success: (res) => resolve(res.fileID || ""),
      fail: () => resolve("")
    });
  });
}

function deleteSecurityImage(fileID) {
  if (!fileID) return Promise.resolve();
  return new Promise((resolve) => {
    wx.cloud.deleteFile({
      fileList: [fileID],
      complete: () => resolve()
    });
  });
}

async function runImageCheck(filePath) {
  if (!wx.cloud || !wx.cloud.callFunction) {
    return { pass: false, reason: "error", message: "内容安全检测不可用" };
  }

  const checkFilePath = await imageUtils.compressImageToSize(filePath, MAX_SECURITY_IMAGE_SIZE);
  if (!checkFilePath) {
    return { pass: false, reason: "error", message: "图片检测前压缩失败" };
  }

  const fileID = await uploadSecurityImage(checkFilePath);
  if (!fileID) {
    return { pass: false, reason: "error", message: "检测图片上传失败" };
  }

  try {
    const res = await wx.cloud.callFunction({
      name: "contentSecurityCheck",
      data: {
        type: "image",
        contentType: getImageContentType(checkFilePath),
        fileID
      }
    });
    const result = res.result || {};
    if (!result.pass) {
      console.warn("image security check failed", result);
    }
    return result.pass
      ? { pass: true }
      : {
          pass: false,
          reason: result.reason || "error",
          message:
            result.message ||
            (Number(result.code) === -1 ? "内容安全接口系统繁忙" : "图片安全检测失败"),
          code: result.code || "",
          errMsg: result.errMsg || ""
        };
  } catch (error) {
    console.error("call contentSecurityCheck failed", error);
    const code = error.errCode || error.errorCode || error.code || "";
    return {
      pass: false,
      reason: "error",
      message: "云函数调用失败",
      code,
      errMsg: error.errMsg || error.message || ""
    };
  } finally {
    await deleteSecurityImage(fileID);
  }
}

async function getCheckCacheKey(filePath) {
  const fingerprint = await imageUtils.getImageFingerprint(filePath);
  return fingerprint || filePath || "";
}

async function checkImage(filePath) {
  const cacheKey = await getCheckCacheKey(filePath);
  if (cacheKey && imageCheckCache.has(cacheKey)) {
    return imageCheckCache.get(cacheKey);
  }

  const checkPromise = runImageCheck(filePath).then((result) => {
    if (!result.pass && result.reason !== "unsafe") {
      imageCheckCache.delete(cacheKey);
    }
    return result;
  });
  if (cacheKey) {
    imageCheckCache.set(cacheKey, checkPromise);
  }
  return checkPromise;
}

async function runChecksWithLimit(filePaths) {
  const results = new Array(filePaths.length);
  let nextIndex = 0;
  const workerCount = Math.min(MAX_CONCURRENT_CHECKS, filePaths.length);
  const workers = new Array(workerCount).fill(null).map(async () => {
    while (nextIndex < filePaths.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await checkImage(filePaths[currentIndex]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function checkImages(filePaths) {
  let unsafeCount = 0;
  let errorCount = 0;
  let firstErrorCode = "";
  let firstErrorMessage = "";
  const validFilePaths = (filePaths || []).filter(Boolean);
  const results = await runChecksWithLimit(validFilePaths);

  for (const result of results) {
    if (!result.pass) {
      if (result.reason === "unsafe") {
        unsafeCount += 1;
      } else {
        errorCount += 1;
        firstErrorCode = firstErrorCode || result.code || "";
        firstErrorMessage = firstErrorMessage || result.message || "";
      }
    }
  }

  return {
    pass: unsafeCount === 0 && errorCount === 0,
    unsafeCount,
    errorCount,
    firstErrorCode,
    firstErrorMessage
  };
}

function precheckImages(filePaths) {
  checkImages(filePaths).catch((error) => {
    console.warn("precheck images failed", error);
  });
}

module.exports = {
  checkImage,
  checkImages,
  precheckImages
};
