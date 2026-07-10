const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function imgSecCheckWithRetry(media, retries = 2) {
  let lastError = null;
  for (let index = 0; index <= retries; index += 1) {
    try {
      await cloud.openapi.security.imgSecCheck({ media });
      return { pass: true };
    } catch (error) {
      lastError = error;
      const code = Number(error.errCode || error.errorCode || error.code);
      if (code === 87014) {
        return { pass: false, reason: "unsafe", message: "图片可能包含违规内容", code };
      }
      if (code !== -1 || index === retries) {
        break;
      }
      await sleep(500);
    }
  }

  const code = lastError && (lastError.errCode || lastError.errorCode || lastError.code);
  const errMsg = lastError && (lastError.errMsg || lastError.message || "");
  console.error("imgSecCheck failed", { code, errMsg });
  if (Number(code) === -1) {
    return { pass: false, reason: "error", message: "内容安全接口系统繁忙", code, errMsg };
  }
  return {
    pass: false,
    reason: "error",
    message: "图片安全检测失败",
    code,
    errMsg
  };
}

exports.main = async (event) => {
  if (event.type !== "image" || !event.fileID) {
    return { pass: false, reason: "error", message: "缺少图片检测内容" };
  }

  const file = await cloud.downloadFile({
    fileID: event.fileID
  });

  return imgSecCheckWithRetry({
    contentType: event.contentType || "image/jpeg",
    value: file.fileContent
  });
};
