const MAX_IMAGE_SIZE = 500 * 1024;
const MAX_COMPRESS_ATTEMPTS = 5;
const FALLBACK_QUALITIES = [75, 55, 35, 20, 10];
const MAX_CONCURRENT_PREPARE = 2;
const fingerprintCache = {};

function isCloudFile(filePath) {
  return String(filePath || "").startsWith("cloud://");
}

function getFileSize(filePath) {
  return new Promise((resolve) => {
    wx.getFileInfo({
      filePath,
      success: (res) => resolve(res.size || 0),
      fail: () => resolve(0)
    });
  });
}

function readFileBuffer(filePath) {
  return new Promise((resolve) => {
    wx.getFileSystemManager().readFile({
      filePath,
      success: (res) => resolve(res.data || null),
      fail: () => resolve(null)
    });
  });
}

function getFileDigestInfo(filePath) {
  return new Promise((resolve) => {
    const fileSystemManager = wx.getFileSystemManager();
    if (!fileSystemManager.getFileInfo) {
      resolve({ size: 0, digest: "" });
      return;
    }
    fileSystemManager.getFileInfo({
      filePath,
      digestAlgorithm: "md5",
      success: (res) => resolve({
        size: res.size || 0,
        digest: String(res.digest || "").toLowerCase()
      }),
      fail: () => resolve({ size: 0, digest: "" })
    });
  });
}

function hashBuffer(buffer) {
  if (!buffer) return "";
  const bytes = new Uint8Array(buffer);
  let hash = 2166136261;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

async function getImageFingerprint(filePath) {
  if (isCloudFile(filePath)) return "";
  const digestInfo = await getFileDigestInfo(filePath);
  const size = digestInfo.size || await getFileSize(filePath);
  if (!size) return "";
  const cacheKey = `${filePath}:${size}`;
  if (fingerprintCache[cacheKey]) {
    return fingerprintCache[cacheKey];
  }
  let fingerprint = digestInfo.digest ? `md5:${size}:${digestInfo.digest}` : "";
  if (!fingerprint) {
    const buffer = await readFileBuffer(filePath);
    const hash = hashBuffer(buffer);
    fingerprint = hash ? `fnv1a:${size}:${hash}` : "";
  }
  if (fingerprint) {
    fingerprintCache[cacheKey] = fingerprint;
  }
  return fingerprint;
}

function isCurrentImageFingerprint(fingerprint) {
  return /^(md5|fnv1a):\d+:[a-f0-9]+$/i.test(String(fingerprint || ""));
}

async function getImageFingerprints(filePaths) {
  const fingerprints = [];
  for (const filePath of (filePaths || []).filter(Boolean)) {
    const fingerprint = await getImageFingerprint(filePath);
    if (fingerprint) {
      fingerprints.push(fingerprint);
    }
  }
  return fingerprints;
}

function compressImage(filePath, quality) {
  return new Promise((resolve) => {
    wx.compressImage({
      src: filePath,
      quality,
      success: (res) => resolve(res.tempFilePath || ""),
      fail: () => resolve("")
    });
  });
}

function compressImageWithSize(filePath, quality, width, height) {
  return new Promise((resolve) => {
    wx.compressImage({
      src: filePath,
      quality,
      compressedWidth: Math.max(1, Math.round(width)),
      compressedHeight: Math.max(1, Math.round(height)),
      success: (res) => resolve(res.tempFilePath || ""),
      fail: () => resolve("")
    });
  });
}

function getImageInfo(filePath) {
  return new Promise((resolve) => {
    wx.getImageInfo({
      src: filePath,
      success: (res) => resolve({
        width: res.width || 0,
        height: res.height || 0
      }),
      fail: () => resolve({ width: 0, height: 0 })
    });
  });
}

async function compressImageToLimit(filePath) {
  return compressImageToSize(filePath, MAX_IMAGE_SIZE);
}

async function compressImageToSize(filePath, maxSize) {
  const originalSize = await getFileSize(filePath);
  if (originalSize > 0 && originalSize <= maxSize) {
    return filePath;
  }

  let bestPath = "";
  let bestSize = Number.MAX_SAFE_INTEGER;
  const imageInfo = await getImageInfo(filePath);
  if (imageInfo.width && imageInfo.height) {
    const estimatedRatio = originalSize > 0 ? maxSize / originalSize : 0.5;
    let scale = Math.min(0.98, Math.max(0.08, Math.sqrt(estimatedRatio / 0.72) * 0.95));
    let quality = 82;

    for (let attempt = 0; attempt < MAX_COMPRESS_ATTEMPTS; attempt += 1) {
      const compressedPath = await compressImageWithSize(
        filePath,
        quality,
        imageInfo.width * scale,
        imageInfo.height * scale
      );
      if (!compressedPath) {
        scale *= 0.72;
        quality = Math.max(28, quality - 12);
        continue;
      }

      const compressedSize = await getFileSize(compressedPath);
      if (compressedSize > 0 && compressedSize < bestSize) {
        bestPath = compressedPath;
        bestSize = compressedSize;
      }
      if (compressedSize > 0 && compressedSize <= maxSize) {
        return compressedPath;
      }

      const sizeRatio = compressedSize > 0 ? maxSize / compressedSize : 0;
      const nextScaleFactor = sizeRatio > 0
        ? Math.max(0.35, Math.min(0.88, Math.sqrt(sizeRatio) * 0.92))
        : 0.72;
      scale *= nextScaleFactor;
      quality = Math.max(28, quality - 12);
    }
  } else {
    for (const quality of FALLBACK_QUALITIES) {
      const compressedPath = await compressImage(filePath, quality);
      if (!compressedPath) continue;
      const compressedSize = await getFileSize(compressedPath);
      if (compressedSize > 0 && compressedSize < bestSize) {
        bestPath = compressedPath;
        bestSize = compressedSize;
      }
      if (compressedSize > 0 && compressedSize <= maxSize) {
        return compressedPath;
      }
    }
  }

  return bestSize <= maxSize ? bestPath : "";
}

function isStorageLimitError(error) {
  const message = String(
    error && (error.errMsg || error.message || error.errno || error.errCode) || ""
  ).toLowerCase();
  return (
    /quota|no space|enospc|空间不足|存储空间/.test(message) ||
    /exceed.*(storage|size)|maximum.*(storage|size)|storage.*limit/.test(message)
  );
}

function saveLocalImageWithResult(filePath) {
  return new Promise((resolve) => {
    wx.saveFile({
      tempFilePath: filePath,
      success: (res) => {
        const image = res.savedFilePath || "";
        resolve({ image, error: image ? "" : "save" });
      },
      fail: (error) => resolve({
        image: "",
        error: isStorageLimitError(error) ? "storage" : "save"
      })
    });
  });
}

async function saveLocalImage(filePath) {
  const result = await saveLocalImageWithResult(filePath);
  return result.image;
}

function removeSavedImage(filePath) {
  if (
    !filePath ||
    isCloudFile(filePath) ||
    filePath.startsWith("/assets/") ||
    filePath.includes("__tmp__")
  ) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    wx.removeSavedFile({
      filePath,
      complete: () => resolve()
    });
  });
}

async function saveCompressedImage(filePath) {
  const compressedPath = await compressImageToLimit(filePath);
  if (!compressedPath) return "";
  return saveLocalImage(compressedPath);
}

async function prepareLocalImage(filePath) {
  const compressedPath = await compressImageToLimit(filePath);
  if (!compressedPath) {
    return { image: "", error: "compress" };
  }

  return saveLocalImageWithResult(compressedPath);
}

async function prepareLocalImages(filePaths) {
  const tempImages = (filePaths || []).filter(Boolean);
  const results = new Array(tempImages.length);
  let nextIndex = 0;
  const workerCount = Math.min(MAX_CONCURRENT_PREPARE, tempImages.length);
  const workers = new Array(workerCount).fill(null).map(async () => {
    while (nextIndex < tempImages.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await prepareLocalImage(tempImages[currentIndex]);
    }
  });
  await Promise.all(workers);
  return {
    images: results.map((item) => item.image).filter(Boolean),
    compressionFailureCount: results.filter((item) => item.error === "compress").length,
    storageFailureCount: results.filter((item) => item.error === "storage").length,
    saveFailureCount: results.filter((item) => item.error === "save").length
  };
}

function getPrepareImagesErrorMessage(result) {
  if (result.storageFailureCount) {
    return "本地空间不足，部分图片未保存";
  }
  if (result.compressionFailureCount && result.saveFailureCount) {
    return "有图片处理失败，已跳过";
  }
  if (result.compressionFailureCount) {
    return "有图片压缩失败，已跳过";
  }
  if (result.saveFailureCount) {
    return "有图片保存失败，已跳过";
  }
  return "";
}

module.exports = {
  MAX_IMAGE_SIZE,
  compressImageToLimit,
  compressImageToSize,
  getImageFingerprint,
  getImageFingerprints,
  getPrepareImagesErrorMessage,
  isCloudFile,
  isCurrentImageFingerprint,
  prepareLocalImages,
  removeSavedImage,
  saveLocalImage,
  saveCompressedImage
};
