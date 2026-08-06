const store = require("../../utils/store");
const clipboardStore = require("../../utils/clipboardStore");
const cloudStore = require("../../utils/cloudStore");
const duplicate = require("../../utils/duplicate");
const imageUtils = require("../../utils/image");
const security = require("../../utils/security");
const tagStore = require("../../utils/tagStore");
const CUSTOM_TAG_KEY = "__custom__";
const DRAFT_KEY = "addInspirationDraft";
const DRAFT_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

function readDraft() {
  try {
    const draft = wx.getStorageSync(DRAFT_KEY);
    return draft && typeof draft === "object" ? draft : null;
  } catch (error) {
    return null;
  }
}

function clearDraftStorage() {
  try {
    wx.removeStorageSync(DRAFT_KEY);
  } catch (error) {
    console.warn("clear add inspiration draft failed", error);
  }
}

Page({
  data: {
    lastImportedClipboard: "",
    acceptedClipboard: "",
    content: "",
    images: [],
    imageTags: tagStore.getDefaultTags(),
    customImageTags: [],
    selectedImageTag: "",
    isCustomImageTag: false,
    customImageTag: "",
    hasSaved: false,
    isSaving: false
  },

  onLoad() {
    this.restoreDraft();
  },

  onShow() {
    this.loadImageTags();
    cloudStore.syncTagSettings()
      .then(() => this.loadImageTags())
      .catch((error) => console.warn("sync image tags on add page failed", error));
    this.checkClipboard();
  },

  onHide() {
    clearTimeout(this.draftSaveTimer);
    this.saveDraftNow();
  },

  loadImageTags() {
    this.setData({
      imageTags: tagStore.getDefaultTags(),
      customImageTags: tagStore.getAll()
    });
  },

  restoreDraft() {
    const draft = readDraft();
    if (!draft) return;
    const images = Array.isArray(draft.images) ? draft.images.filter(Boolean).slice(0, 9) : [];
    const isExpired = Date.now() - Number(draft.updatedAt || 0) > DRAFT_MAX_AGE;
    if (isExpired) {
      images.forEach(imageUtils.removeSavedImage);
      clearDraftStorage();
      return;
    }
    const content = String(draft.content || "");
    if (!content.trim() && !images.length) {
      clearDraftStorage();
      return;
    }
    this.setData({
      lastImportedClipboard: String(draft.acceptedClipboard || ""),
      acceptedClipboard: String(draft.acceptedClipboard || ""),
      content,
      images,
      selectedImageTag: images.length ? String(draft.selectedImageTag || "") : "",
      isCustomImageTag: images.length && Boolean(draft.isCustomImageTag),
      customImageTag: images.length ? String(draft.customImageTag || "") : ""
    });
  },

  scheduleDraftSave() {
    clearTimeout(this.draftSaveTimer);
    this.draftSaveTimer = setTimeout(() => this.saveDraftNow(), 300);
  },

  saveDraftNow() {
    if (this.data.hasSaved) return;
    const content = String(this.data.content || "");
    const images = (this.data.images || []).filter(Boolean);
    if (!content.trim() && !images.length) {
      clearDraftStorage();
      return;
    }
    try {
      wx.setStorageSync(DRAFT_KEY, {
        content,
        images,
        selectedImageTag: this.data.selectedImageTag || "",
        isCustomImageTag: Boolean(this.data.isCustomImageTag),
        customImageTag: this.data.customImageTag || "",
        acceptedClipboard: this.data.acceptedClipboard || "",
        updatedAt: Date.now()
      });
    } catch (error) {
      console.warn("save add inspiration draft failed", error);
    }
  },

  checkClipboard() {
    wx.getClipboardData({
      success: (res) => {
        const text = String(res.data || "").trim();
        const currentContent = this.data.content.trim();
        if (
          text &&
          !currentContent &&
          text !== this.data.lastImportedClipboard &&
          !clipboardStore.has(text) &&
          !store.hasContent(text)
        ) {
          this.setData({
            lastImportedClipboard: text,
            content: text,
            acceptedClipboard: text
          }, () => this.scheduleDraftSave());
        }
      }
    });
  },

  onContentInput(event) {
    this.setData({ content: event.detail.value }, () => this.scheduleDraftSave());
  },

  chooseImage() {
    const remaining = Math.max(0, 9 - this.data.images.length);
    if (!remaining) {
      wx.showToast({ title: "最多放 9 张图", icon: "none" });
      return;
    }
    wx.chooseMedia({
      count: remaining,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      success: async (res) => {
        const tempImages = (res.tempFiles || [])
          .map((file) => file.tempFilePath)
          .filter(Boolean);
        wx.showLoading({ title: "处理图片中", mask: true });
        const result = await imageUtils.prepareLocalImages(tempImages);
        wx.hideLoading();
        const nextImages = result.images;
        const errorMessage = imageUtils.getPrepareImagesErrorMessage(result);
        if (errorMessage) {
          wx.showToast({ title: errorMessage, icon: "none" });
        }
        if (nextImages.length) {
          this.setData({
            images: [...this.data.images, ...nextImages],
            selectedImageTag: this.data.selectedImageTag || tagStore.getFirstSelectableTag(),
            imageTags: tagStore.getDefaultTags(),
            customImageTags: tagStore.getAll()
          }, () => this.scheduleDraftSave());
          security.precheckImages(nextImages);
        }
      }
    });
  },

  selectImageTag(event) {
    const tag = event.currentTarget.dataset.tag || "";
    this.setData({
      selectedImageTag: tag,
      isCustomImageTag: tag === CUSTOM_TAG_KEY
    }, () => this.scheduleDraftSave());
  },

  onCustomImageTagInput(event) {
    this.setData({ customImageTag: event.detail.value }, () => this.scheduleDraftSave());
  },

  removeImageTag(event) {
    const tag = event.currentTarget.dataset.tag || "";
    wx.showModal({
      title: "删除标签",
      content: `删除「${tag}」后，新增时不再显示它。`,
      confirmText: "删除",
      confirmColor: "#7554e2",
      success: (res) => {
        if (!res.confirm) return;
        tagStore.remove(tag);
        cloudStore.syncTagSettings().catch((error) => {
          console.warn("sync removed image tag failed", error);
        });
        const isSelected = this.data.selectedImageTag === tag;
        this.setData({
          imageTags: tagStore.getDefaultTags(),
          customImageTags: tagStore.getAll(),
          selectedImageTag: isSelected ? tagStore.getFirstSelectableTag() : this.data.selectedImageTag,
          isCustomImageTag: isSelected ? false : this.data.isCustomImageTag
        }, () => this.scheduleDraftSave());
      }
    });
  },

  removeImage(event) {
    const index = Number(event.currentTarget.dataset.index);
    const removedImage = this.data.images[index];
    const images = this.data.images.filter((_, itemIndex) => itemIndex !== index);
    imageUtils.removeSavedImage(removedImage);
    this.setData({
      images,
      selectedImageTag: images.length ? this.data.selectedImageTag || tagStore.getFirstSelectableTag() : "",
      isCustomImageTag: images.length ? this.data.isCustomImageTag : false,
      customImageTag: images.length ? this.data.customImageTag : ""
    }, () => this.scheduleDraftSave());
  },

  onDraftImageError(event) {
    this.removeImage(event);
  },

  async save() {
    if (this.data.isSaving) return;
    const content = this.data.content.trim();
    if (!content && !this.data.images.length) {
      wx.showToast({ title: "先写点或放张图", icon: "none" });
      return;
    }
    if (content && store.hasContent(content)) {
      wx.showToast({ title: "这段文案已经在脑袋里", icon: "none" });
      return;
    }

    let imageFingerprints = [];
    if (this.data.images.length) {
      if (this.data.isCustomImageTag && !this.data.customImageTag.trim()) {
        wx.showToast({ title: "先写自定义标签", icon: "none" });
        return;
      }
    }

    let toast = null;
    let shouldNavigate = false;
    const imageTag = this.data.images.length
      ? this.data.isCustomImageTag
        ? tagStore.normalizeTag(this.data.customImageTag)
        : this.data.selectedImageTag || tagStore.getFirstSelectableTag()
      : "";
    this.setData({ isSaving: true });
    wx.showLoading({ title: "正在塞入脑袋", mask: true });
    try {
      if (this.data.images.length) {
        imageFingerprints = await imageUtils.getImageFingerprints(this.data.images);
        const storedFingerprints = await duplicate.getStoredImageFingerprintSet();
        const uniqueFingerprints = new Set(imageFingerprints);
        if (uniqueFingerprints.size !== imageFingerprints.length) {
          toast = { title: "这次有重复图片", icon: "none" };
        } else if (imageFingerprints.some((fingerprint) => storedFingerprints.has(fingerprint))) {
          toast = { title: "图片已经在脑袋里", icon: "none" };
        } else {
          const checkResult = await security.checkImages(this.data.images);
          if (!checkResult.pass) {
            toast = checkResult.unsafeCount
              ? { title: "有图片未通过安全检测", icon: "none" }
              : { title: "图片检测暂时失败", icon: "none" };
          }
        }
      }

      if (!toast) {
        await cloudStore.createItem({
          content,
          images: this.data.images,
          imageFingerprints,
          imageTag
        });
        if (this.data.isCustomImageTag && imageTag) {
          tagStore.add(imageTag);
          cloudStore.syncTagSettings().catch((error) => {
            console.warn("sync custom image tag failed", error);
          });
        }
        if (this.data.acceptedClipboard) {
          clipboardStore.add(this.data.acceptedClipboard);
        }
        clearTimeout(this.draftSaveTimer);
        clearDraftStorage();
        toast = { title: "已放进灵感脑袋", icon: "success" };
        shouldNavigate = true;
        this.setData({
          lastImportedClipboard: "",
          acceptedClipboard: "",
          content: "",
          images: [],
          selectedImageTag: "",
          isCustomImageTag: false,
          customImageTag: "",
          imageTags: tagStore.getDefaultTags(),
          customImageTags: tagStore.getAll(),
          hasSaved: true
        });
      }
    } catch (error) {
      console.error("save inspiration to cloud failed", error);
      if (error.code === "DUPLICATE_CONTENT") {
        toast = { title: "这段文案已经在脑袋里", icon: "none" };
      } else if (error.code === "DUPLICATE_IMAGE") {
        toast = { title: "图片已经在脑袋里", icon: "none" };
      } else if (error.code === "UNSAFE_TEXT") {
        toast = { title: "文案未通过安全检测", icon: "none" };
      } else if (error.code === "TEXT_CHECK_ERROR") {
        toast = { title: "文案检测暂时失败", icon: "none" };
      } else {
        toast = { title: "云端保存失败，请稍后重试", icon: "none" };
      }
    } finally {
      wx.hideLoading();
      this.setData({ isSaving: false });
    }

    if (toast) {
      wx.showToast(toast);
    }
    if (shouldNavigate) {
      setTimeout(() => {
        wx.navigateBack({
          fail: () => wx.redirectTo({ url: "/pages/index/index" })
        });
      }, 500);
    }
  },

  onUnload() {
    clearTimeout(this.draftSaveTimer);
    this.saveDraftNow();
  }
});
