const imageUtils = require("./image");
const store = require("./store");

async function getStoredImageFingerprintSet(excludeId = "") {
  const fingerprints = new Set();
  const backfillEntries = [];
  const items = store.getAll();

  for (const item of items) {
    const images = (item.images || []).filter(Boolean);
    const storedFingerprints = item.imageFingerprints || [];
    const canCalculateFingerprints = images.every((image) => !imageUtils.isCloudFile(image));
    const needsBackfill =
      canCalculateFingerprints &&
      images.length > 0 &&
      (storedFingerprints.length !== images.length ||
        storedFingerprints.some(
          (fingerprint) => !imageUtils.isCurrentImageFingerprint(fingerprint)
        ));
    let itemFingerprints = storedFingerprints;

    if (needsBackfill) {
      const calculatedFingerprints = await imageUtils.getImageFingerprints(images);
      itemFingerprints = calculatedFingerprints;
      if (calculatedFingerprints.length === images.length) {
        backfillEntries.push({
          id: item.id,
          imageFingerprints: calculatedFingerprints
        });
      }
    }

    if (item.id !== excludeId) {
      itemFingerprints.forEach((fingerprint) => {
        if (fingerprint) fingerprints.add(fingerprint);
      });
    }
  }

  store.backfillImageFingerprints(backfillEntries);
  return fingerprints;
}

async function getEditImageFingerprints(selectedItem, editImages) {
  const originalImages = (selectedItem && selectedItem.images) || [];
  const originalFingerprints = (selectedItem && selectedItem.imageFingerprints) || [];
  const fingerprintsByImage = new Map();
  originalImages.forEach((image, index) => {
    if (image && originalFingerprints[index]) {
      fingerprintsByImage.set(image, originalFingerprints[index]);
    }
  });

  const fingerprints = [];
  for (const image of (editImages || []).filter(Boolean)) {
    const existingFingerprint = fingerprintsByImage.get(image);
    const fingerprint = existingFingerprint || await imageUtils.getImageFingerprint(image);
    fingerprints.push(fingerprint || "");
  }
  return fingerprints;
}

module.exports = {
  getEditImageFingerprints,
  getStoredImageFingerprintSet
};
