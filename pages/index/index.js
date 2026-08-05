const store = require("../../utils/store");
const cloudStore = require("../../utils/cloudStore");
const duplicate = require("../../utils/duplicate");
const imageUtils = require("../../utils/image");
const security = require("../../utils/security");
const tagStore = require("../../utils/tagStore");
const { IMAGE_TAGS } = require("../../utils/constants");

function normalizeImageTag(tag) {
  return String(tag || "").trim();
}

function buildFilters(items) {
  const customTags = [];
  items.forEach((item) => {
    const tag = normalizeImageTag(item.imageTag);
    if (tag && !IMAGE_TAGS.includes(tag) && !customTags.includes(tag)) {
      customTags.push(tag);
    }
  });
  return [
    { key: "all", label: "全部" },
    { key: "sentence", label: "语录" },
    ...customTags.map((tag) => ({ key: tag, label: tag })),
    ...IMAGE_TAGS.map((tag) => ({ key: tag, label: tag }))
  ];
}

function buildSelectableImageTags(extraTag) {
  return tagStore.getSelectableTags(extraTag);
}

function cleanSavedImages(images) {
  const uniqueImages = [...new Set((images || []).filter(Boolean))];
  return Promise.all(uniqueImages.map(imageUtils.removeSavedImage));
}

function getUnsavedEditImages(selectedItem, editImages) {
  const savedImages = new Set((selectedItem && selectedItem.images || []).filter(Boolean));
  return (editImages || []).filter((image) => image && !savedImages.has(image));
}

function rebaseEditImages(baseItem, latestItem, draftImages) {
  const baseImages = new Set((baseItem && baseItem.images || []).filter(Boolean));
  const draftImageSet = new Set((draftImages || []).filter(Boolean));
  const rebasedImages = (latestItem && latestItem.images || []).filter(
    (image) => !baseImages.has(image) || draftImageSet.has(image)
  );
  (draftImages || []).forEach((image) => {
    if (
      image &&
      !baseImages.has(image) &&
      !imageUtils.isCloudFile(image) &&
      !rebasedImages.includes(image)
    ) {
      rebasedImages.push(image);
    }
  });
  return rebasedImages;
}

function estimateCardHeight(item) {
  const content = String(item.content || "");
  const tagLength = String(item.imageTag || "").length;
  const hasImages = item.images && item.images.length;
  const estimatedTextLines = content
    ? content.split(/\r?\n/).reduce(
      (total, line) => total + Math.max(1, Math.ceil(Array.from(line).length / 9)),
      0
    )
    : 0;
  const tagLines = tagLength > 6 ? 2 : 1;
  const bodyMinHeight = hasImages ? 164 : 284;
  const imageHeight = hasImages ? 340 : 0;
  const textHeight = estimatedTextLines * 44;
  const extraTagHeight = tagLines > 1 ? 42 : 0;
  const naturalBodyHeight = 136 + textHeight + extraTagHeight + (content ? 18 : 0);
  return imageHeight + Math.max(bodyMinHeight, naturalBodyHeight) + 18;
}

function getMasonryItemSignature(item) {
  return JSON.stringify([
    item.version || 0,
    item.content || "",
    item.imageTag || "",
    item.statusText || "",
    Boolean(item.isPinned),
    Boolean(item.isUsed),
    Boolean(item.isImageCard),
    (item.images || []).length,
    item.createdText || ""
  ]);
}

function splitMasonryColumns(items, getItemHeight = estimateCardHeight) {
  const leftItems = [];
  const rightItems = [];
  let leftHeight = 0;
  let rightHeight = 0;

  items.forEach((item) => {
    const measuredHeight = Number(getItemHeight(item));
    const height = measuredHeight > 0 ? measuredHeight : estimateCardHeight(item);
    if (leftHeight <= rightHeight) {
      leftItems.push(item);
      leftHeight += height;
    } else {
      rightItems.push(item);
      rightHeight += height;
    }
  });

  return { leftItems, rightItems };
}

function haveSameMasonryItems(currentItems, nextItems) {
  if ((currentItems || []).length !== (nextItems || []).length) return false;
  return (currentItems || []).every(
    (item, index) => item.id === nextItems[index].id
  );
}

Page({
  data: {
    keyword: "",
    activeType: "all",
    isSearchFloating: false,
    isAndroid: false,
    floatingSearchStyle: "",
    floatingLogoStyle: "",
    filters: buildFilters([]),
    imageTags: buildSelectableImageTags(),
    items: [],
    leftItems: [],
    rightItems: [],
    selectedItem: null,
    isEditing: false,
    isEditSaving: false,
    isCloudSyncing: false,
    isLoadingMore: false,
    hasMoreCloudItems: false,
    syncStatusText: "",
    syncStatusType: "idle",
    editContent: "",
    editImages: [],
    editImageTag: ""
  },

  onLoad() {
    this.setFloatingSearchMetrics();
  },

  onShow() {
    const syncMeta = store.getSyncMeta();
    this.setData({
      imageTags: buildSelectableImageTags(this.data.editImageTag),
      hasMoreCloudItems: Boolean(syncMeta.hasMore)
    });
    this.loadItems();
    this.syncCloudItems();
  },

  async syncCloudItems() {
    if (this.data.isCloudSyncing) return;
    this.setData({
      isCloudSyncing: true,
      syncStatusText: "正在同步",
      syncStatusType: "syncing"
    });
    try {
      const result = await cloudStore.syncAll();
      this.loadItems();
      this.refreshOpenDetail();
      this.setData({
        hasMoreCloudItems: Boolean(result.hasMore),
        syncStatusText: "已同步",
        syncStatusType: "synced",
        imageTags: buildSelectableImageTags(this.data.editImageTag)
      });
      if (result.migratedCount) {
        wx.showToast({ title: "旧数据已同步到云端", icon: "success" });
      }
      cloudStore.backfillMissingThumbnails(result.items, 4).then((updatedCount) => {
        if (updatedCount) this.loadItems();
      });
      this.hasShownCloudSyncError = false;
    } catch (error) {
      console.error("sync inspirations from cloud failed", error);
      if (!this.hasShownCloudSyncError) {
        this.hasShownCloudSyncError = true;
        wx.showToast({ title: "云端同步失败，已显示本地数据", icon: "none" });
      }
      this.setData({
        syncStatusText: "离线 · 已显示缓存",
        syncStatusType: "offline"
      });
    } finally {
      this.setData({ isCloudSyncing: false }, () => {
        if (
          this.data.hasMoreCloudItems &&
          (String(this.data.keyword || "").trim() || this.data.activeType !== "all")
        ) {
          this.ensureAllCloudItems();
        }
      });
    }
  },

  refreshOpenDetail() {
    const selectedItem = this.data.selectedItem;
    if (!selectedItem || this.data.isEditing) return;
    const latest = store.getById(selectedItem.id);
    if (!latest) {
      this.closeDetail();
      return;
    }
    const decorated = this.decorateItem(latest);
    this.setData({
      selectedItem: decorated,
      editContent: decorated.content || "",
      editImages: decorated.images || [],
      editImageTag: normalizeImageTag(decorated.imageTag),
      imageTags: buildSelectableImageTags(decorated.imageTag)
    });
  },

  async loadMoreCloudItems() {
    if (
      this.data.isCloudSyncing ||
      this.data.isLoadingMore ||
      !this.data.hasMoreCloudItems
    ) {
      return;
    }
    this.setData({
      isLoadingMore: true,
      syncStatusText: "正在加载更多",
      syncStatusType: "syncing"
    });
    try {
      const result = await cloudStore.loadNextPage();
      this.loadItems();
      cloudStore.backfillMissingThumbnails(result.items, 4).then((updatedCount) => {
        if (updatedCount) this.loadItems();
      });
      this.setData({
        hasMoreCloudItems: Boolean(result.hasMore),
        syncStatusText: result.hasMore ? "已同步" : "已加载全部",
        syncStatusType: "synced"
      });
    } catch (error) {
      console.error("load more inspirations failed", error);
      this.setData({
        syncStatusText: "加载失败 · 上滑重试",
        syncStatusType: "offline"
      });
    } finally {
      this.setData({ isLoadingMore: false });
    }
  },

  async ensureAllCloudItems() {
    if (
      this.data.isCloudSyncing ||
      this.data.isLoadingMore ||
      !this.data.hasMoreCloudItems
    ) {
      return;
    }
    this.setData({
      isLoadingMore: true,
      syncStatusText: "正在加载完整结果",
      syncStatusType: "syncing"
    });
    let hasMore = true;
    try {
      while (hasMore) {
        const result = await cloudStore.loadNextPage();
        hasMore = Boolean(result.hasMore);
      }
      this.loadItems();
      this.setData({
        hasMoreCloudItems: false,
        syncStatusText: "已加载全部",
        syncStatusType: "synced"
      });
    } catch (error) {
      console.error("load complete inspiration results failed", error);
      const meta = store.getSyncMeta();
      this.loadItems();
      this.setData({
        hasMoreCloudItems: Boolean(meta.hasMore),
        syncStatusText: "部分结果 · 上滑继续加载",
        syncStatusType: "offline"
      });
    } finally {
      this.setData({ isLoadingMore: false });
    }
  },

  onReachBottom() {
    this.loadMoreCloudItems();
  },

  setFloatingSearchMetrics() {
    if (!wx.getMenuButtonBoundingClientRect) return;
    const menu = wx.getMenuButtonBoundingClientRect();
    if (!menu || !menu.bottom) return;

    const systemInfo = wx.getSystemInfoSync ? wx.getSystemInfoSync() : {};
    const deviceInfo = wx.getDeviceInfo ? wx.getDeviceInfo() : {};
    const platform = String(systemInfo.platform || deviceInfo.platform || "").toLowerCase();
    const system = String(systemInfo.system || deviceInfo.system || "").toLowerCase();
    const model = String(systemInfo.model || deviceInfo.model || "").toLowerCase();
    const isIOS =
      platform === "ios" ||
      system.includes("ios") ||
      system.includes("iphone") ||
      system.includes("ipad") ||
      model.includes("iphone") ||
      model.includes("ipad");
    const isAndroid =
      !isIOS ||
      platform === "android" ||
      system.includes("android") ||
      model.includes("android");
    const searchTop = menu.bottom + 12;
    const logoHeight = 24;
    const logoGap = isAndroid ? 5 : 25;
    const logoTop = Math.max(8, searchTop - logoHeight - logoGap);

    this.setData({
      floatingSearchStyle: `padding-top: ${searchTop}px; padding-bottom: 12px;`,
      floatingLogoStyle: `top: ${logoTop}px;`,
      isAndroid
    });
  },

  onPageScroll(event) {
    const isSearchFloating = event.scrollTop > 300;
    if (isSearchFloating !== this.data.isSearchFloating) {
      this.setData({ isSearchFloating });
    }
  },

  onSearchInput(event) {
    this.setData({ keyword: event.detail.value });
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.loadItems();
      if (String(this.data.keyword || "").trim()) {
        this.ensureAllCloudItems();
      }
    }, 180);
  },

  onFilterTap(event) {
    this.setData({ activeType: event.currentTarget.dataset.type }, () => {
      this.loadItems();
      if (this.data.activeType !== "all") {
        this.ensureAllCloudItems();
      }
    });
  },

  onSearchButtonTap() {
    if (this.data.keyword) {
      this.setData({ keyword: "" }, () => {
        this.loadItems();
      });
      return;
    }
    wx.hideKeyboard();
  },

  loadItems() {
    const activeType = this.data.activeType;
    const keyword = String(this.data.keyword || "").trim().toLowerCase();
    const allItems = store.getAll();
    const filters = buildFilters(allItems);
    const filterKey = filters.map((item) => item.key).join("|");
    const items = allItems
      .filter((item) => {
        if (!keyword) return true;
        return [item.content, item.note, item.imageTag]
          .join(" ")
          .toLowerCase()
          .includes(keyword);
      })
      .filter((item) => {
        const hasImages = item.images && item.images.length;
        if (activeType === "all") return true;
        if (activeType === "sentence") {
          return !hasImages && (item.type === "sentence" || item.type === "reply");
        }
        return hasImages && normalizeImageTag(item.imageTag) === activeType;
      })
      .map((item) => {
        const images = item.images || [];
        const thumbnails = item.thumbnails || images;
        const useOriginal = this.thumbnailFallbackIds && this.thumbnailFallbackIds.has(item.id);
        return {
          ...item,
          createdText: store.formatDate(item.createdAt),
          statusText: item.isPinned ? "置顶" : item.isUsed ? "用过了" : "待用",
          imageTag: normalizeImageTag(item.imageTag),
          images,
          thumbnails,
          cardImage: useOriginal ? images[0] : thumbnails[0] || images[0],
          isImageCard: item.type === "image" || images.length > 0
        };
      });
    const getCachedHeight = (item) => {
      const cached = this.masonryHeightCache && this.masonryHeightCache.get(item.id);
      return cached && cached.signature === getMasonryItemSignature(item)
        ? cached.height
        : estimateCardHeight(item);
    };
    const { leftItems, rightItems } = splitMasonryColumns(items, getCachedHeight);
    const nextData = {
      items,
      leftItems,
      rightItems
    };
    if (this.filterKey !== filterKey) {
      this.filterKey = filterKey;
      nextData.filters = filters;
    }
    this.masonryMeasureRevision = Number(this.masonryMeasureRevision || 0) + 1;
    const measureRevision = this.masonryMeasureRevision;
    this.setData(nextData, () => {
      this.rebalanceMasonry(items, measureRevision);
    });
  },

  rebalanceMasonry(items, measureRevision) {
    if (
      !items.length ||
      measureRevision !== this.masonryMeasureRevision ||
      !wx.createSelectorQuery
    ) {
      return;
    }
    const itemById = new Map(items.map((item) => [String(item.id), item]));
    const query = wx.createSelectorQuery();
    const scopedQuery = query.in ? query.in(this) : query;
    scopedQuery.selectAll(".inspiration-card").boundingClientRect();
    scopedQuery.exec((results) => {
      if (measureRevision !== this.masonryMeasureRevision) return;
      const rects = results && results[0] || [];
      if (!rects.length) return;
      const windowInfo = wx.getWindowInfo
        ? wx.getWindowInfo()
        : wx.getSystemInfoSync ? wx.getSystemInfoSync() : {};
      const pxToRpx = windowInfo.windowWidth ? 750 / windowInfo.windowWidth : 1;
      if (!this.masonryHeightCache) this.masonryHeightCache = new Map();

      rects.forEach((rect) => {
        const datasetId = rect.dataset && rect.dataset.id;
        const elementId = String(rect.id || "").replace(/^inspiration-card-/, "");
        const id = String(datasetId || elementId || "");
        const item = itemById.get(id);
        if (!item || !Number(rect.height)) return;
        this.masonryHeightCache.set(id, {
          signature: getMasonryItemSignature(item),
          height: Number(rect.height) * pxToRpx + 18
        });
      });

      const balanced = splitMasonryColumns(items, (item) => {
        const cached = this.masonryHeightCache.get(String(item.id));
        return cached && cached.signature === getMasonryItemSignature(item)
          ? cached.height
          : estimateCardHeight(item);
      });
      if (
        haveSameMasonryItems(this.data.leftItems, balanced.leftItems) &&
        haveSameMasonryItems(this.data.rightItems, balanced.rightItems)
      ) {
        return;
      }
      this.setData({
        leftItems: balanced.leftItems,
        rightItems: balanced.rightItems
      });
    });
  },

  onUnload() {
    clearTimeout(this.searchTimer);
    this.masonryMeasureRevision = Number(this.masonryMeasureRevision || 0) + 1;
  },

  openDetail(event) {
    const { id } = event.currentTarget.dataset;
    const raw = this.data.items.find((item) => item.id === id) || store.getById(id);
    if (!raw) return;
    const selectedItem = this.decorateItem(raw);
    this.setData({
      selectedItem,
      isEditing: false,
      editContent: selectedItem.content || "",
      editImages: selectedItem.images || [],
      editImageTag: normalizeImageTag(selectedItem.imageTag) || (selectedItem.images.length ? tagStore.getFirstSelectableTag() : ""),
      imageTags: buildSelectableImageTags(selectedItem.imageTag)
    });
  },

  decorateItem(item) {
    return {
      ...item,
      createdText: store.formatDate(item.createdAt),
      statusText: item.isPinned ? "置顶" : item.isUsed ? "用过了" : "待用",
      imageTag: normalizeImageTag(item.imageTag),
      images: item.images || [],
      thumbnails: item.thumbnails || item.images || [],
      isImageCard: item.type === "image" || (item.images || []).length > 0
    };
  },

  closeDetail() {
    if (this.data.isEditing) {
      cleanSavedImages(getUnsavedEditImages(this.data.selectedItem, this.data.editImages));
    }
    this.setData({
      selectedItem: null,
      isEditing: false,
      editContent: "",
      editImages: [],
      editImageTag: ""
    });
  },

  noop() {},

  copySelected() {
    const text = this.data.selectedItem && this.data.selectedItem.content;
    if (!text) {
      wx.showToast({ title: "没有可复制文字", icon: "none" });
      return;
    }
    wx.setClipboardData({
      data: text,
      success: () => {
        wx.showToast({ title: "已复制", icon: "success" });
      }
    });
  },

  startEdit() {
    this.setData({
      isEditing: true,
      editContent: this.data.selectedItem.content || "",
      editImages: this.data.selectedItem.images || [],
      editImageTag: normalizeImageTag(this.data.selectedItem.imageTag) || (this.data.selectedItem.images.length ? tagStore.getFirstSelectableTag() : ""),
      imageTags: buildSelectableImageTags(this.data.selectedItem.imageTag)
    });
  },

  onEditInput(event) {
    this.setData({ editContent: event.detail.value });
  },

  async saveEdit() {
    if (this.data.isEditSaving) return;
    const item = this.data.selectedItem;
    if (!item) return;
    const content = this.data.editContent.trim();
    if (!content && !this.data.editImages.length) {
      wx.showToast({ title: "先写点或放张图", icon: "none" });
      return;
    }
    if (content && store.hasContent(content, item.id)) {
      wx.showToast({ title: "这段文案已经在脑袋里", icon: "none" });
      return;
    }

    let toast = null;
    let imageFingerprints = [];
    this.setData({ isEditSaving: true });
    wx.showLoading({ title: "正在塞入脑袋", mask: true });
    try {
      if (this.data.editImages.length) {
        imageFingerprints = await duplicate.getEditImageFingerprints(
          item,
          this.data.editImages
        );
        const storedFingerprints = await duplicate.getStoredImageFingerprintSet(item.id);
        const validFingerprints = imageFingerprints.filter(Boolean);
        const uniqueFingerprints = new Set(validFingerprints);
        if (uniqueFingerprints.size !== validFingerprints.length) {
          toast = { title: "这次有重复图片", icon: "none" };
        } else if (validFingerprints.some((fingerprint) => storedFingerprints.has(fingerprint))) {
          toast = { title: "图片已经在脑袋里", icon: "none" };
        } else {
          const unsavedImages = getUnsavedEditImages(item, this.data.editImages);
          const checkResult = await security.checkImages(unsavedImages);
          if (!checkResult.pass) {
            toast = checkResult.unsafeCount
              ? { title: "有图片未通过安全检测", icon: "none" }
              : { title: "图片检测暂时失败", icon: "none" };
          }
        }
      }

      if (!toast) {
        await cloudStore.updateItem(
          item,
          {
            content,
            imageTag: this.data.editImages.length
              ? this.data.editImageTag || tagStore.getFirstSelectableTag()
              : ""
          },
          this.data.editImages,
          imageFingerprints
        );
        if (this.data.editImages.length && this.data.editImageTag) {
          tagStore.add(this.data.editImageTag);
          cloudStore.syncTagSettings().catch((error) => {
            console.warn("sync edited image tag failed", error);
          });
        }
        this.refreshSelected(item.id);
        toast = { title: "已更新", icon: "success" };
      }
    } catch (error) {
      console.error("update inspiration in cloud failed", error);
      if (cloudStore.isConflict(error) && error.latest) {
        this.handleEditConflict(item, error.latest);
      } else if (error.code === "DUPLICATE_CONTENT") {
        toast = { title: "这段文案已经在脑袋里", icon: "none" };
      } else if (error.code === "DUPLICATE_IMAGE") {
        toast = { title: "图片已经在脑袋里", icon: "none" };
      } else if (error.code === "UNSAFE_TEXT") {
        toast = { title: "文案未通过安全检测", icon: "none" };
      } else if (error.code === "TEXT_CHECK_ERROR") {
        toast = { title: "文案检测暂时失败", icon: "none" };
      } else {
        toast = { title: "云端更新失败，请稍后重试", icon: "none" };
      }
    } finally {
      wx.hideLoading();
      this.setData({ isEditSaving: false });
    }

    if (toast) {
      wx.showToast(toast);
    }
  },

  handleEditConflict(baseItem, latestItem) {
    if (latestItem.isDeleted) {
      store.mergeRemoteItems([latestItem]);
      this.closeDetail();
      this.loadItems();
      wx.showModal({
        title: "这条灵感已被删除",
        content: "它刚刚在其他设备被删除，本次修改没有覆盖云端。",
        showCancel: false,
        confirmText: "知道了"
      });
      return;
    }
    const editImages = rebaseEditImages(baseItem, latestItem, this.data.editImages);
    const editContent =
      this.data.editContent === String(baseItem.content || "")
        ? String(latestItem.content || "")
        : this.data.editContent;
    const editImageTag =
      normalizeImageTag(this.data.editImageTag) === normalizeImageTag(baseItem.imageTag)
        ? normalizeImageTag(latestItem.imageTag)
        : this.data.editImageTag;
    store.mergeRemoteItems([latestItem]);
    const selectedItem = this.decorateItem(latestItem);
    this.setData({
      selectedItem,
      isEditing: true,
      editContent,
      editImages,
      editImageTag: editImages.length ? editImageTag || tagStore.getFirstSelectableTag() : "",
      imageTags: buildSelectableImageTags(editImageTag),
      syncStatusText: "已获取其他设备的更新",
      syncStatusType: "synced"
    });
    this.loadItems();
    wx.showModal({
      title: "发现其他设备的修改",
      content: "当前编辑内容已保留，并合并了云端最新图片。请检查后再次保存。",
      showCancel: false,
      confirmText: "知道了"
    });
  },

  cancelEdit() {
    cleanSavedImages(getUnsavedEditImages(this.data.selectedItem, this.data.editImages));
    this.setData({
      isEditing: false,
      editContent: this.data.selectedItem ? this.data.selectedItem.content || "" : "",
      editImages: this.data.selectedItem ? this.data.selectedItem.images || [] : [],
      editImageTag: this.data.selectedItem
        ? normalizeImageTag(this.data.selectedItem.imageTag) || ((this.data.selectedItem.images || []).length ? tagStore.getFirstSelectableTag() : "")
        : "",
      imageTags: buildSelectableImageTags(this.data.selectedItem && this.data.selectedItem.imageTag)
    });
  },

  selectEditImageTag(event) {
    this.setData({ editImageTag: event.currentTarget.dataset.tag || "" });
  },

  chooseEditImage() {
    const remaining = Math.max(0, 9 - this.data.editImages.length);
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
            editImages: [...this.data.editImages, ...nextImages],
            editImageTag: this.data.editImageTag || tagStore.getFirstSelectableTag(),
            imageTags: buildSelectableImageTags(this.data.editImageTag)
          });
          security.precheckImages(nextImages);
        }
      }
    });
  },

  removeEditImage(event) {
    const index = Number(event.currentTarget.dataset.index);
    const removedImage = this.data.editImages[index];
    const editImages = this.data.editImages.filter((_, itemIndex) => itemIndex !== index);
    if (getUnsavedEditImages(this.data.selectedItem, [removedImage]).length) {
      imageUtils.removeSavedImage(removedImage);
    }
    this.setData({
      editImages,
      editImageTag: editImages.length ? this.data.editImageTag || tagStore.getFirstSelectableTag() : ""
    });
  },

  async previewSelectedImage(event) {
    const images = (this.data.selectedItem && this.data.selectedItem.images || []).filter(Boolean);
    if (!images.length) return;
    const current = event.currentTarget.dataset.src || images[0];
    const previewUrls = await cloudStore.getPreviewUrls(images);
    const currentIndex = images.indexOf(current);
    wx.previewImage({
      current: previewUrls[currentIndex >= 0 ? currentIndex : 0],
      urls: previewUrls
    });
  },

  onStoredImageError(event) {
    const { id, src } = event.currentTarget.dataset;
    if (!id || !src) return;
    if (imageUtils.isCloudFile(src)) return;
    store.removeImage(id, src);
    if (this.data.selectedItem && this.data.selectedItem.id === id) {
      const raw = store.getById(id);
      if (raw) {
        const selectedItem = this.decorateItem(raw);
        this.setData({
          selectedItem,
          editImages: selectedItem.images || [],
          editImageTag: normalizeImageTag(selectedItem.imageTag) || (selectedItem.images.length ? tagStore.getFirstSelectableTag() : ""),
          imageTags: buildSelectableImageTags(selectedItem.imageTag)
        });
      }
    }
    this.loadItems();
  },

  onCardImageError(event) {
    const id = event.currentTarget.dataset.id;
    const raw = id && store.getById(id);
    if (!raw || !(raw.images || []).length) return;
    const originalImage = raw.images[0];
    const thumbnail = (raw.thumbnails || [])[0];
    if (thumbnail && thumbnail !== originalImage) {
      if (!this.thumbnailFallbackIds) this.thumbnailFallbackIds = new Set();
      this.thumbnailFallbackIds.add(id);
      this.loadItems();
      return;
    }
    this.onStoredImageError({
      currentTarget: { dataset: { id, src: originalImage } }
    });
  },

  onEditImageError(event) {
    const src = event.currentTarget.dataset.src;
    if (!src) return;
    if (imageUtils.isCloudFile(src)) return;
    const editImages = this.data.editImages.filter((path) => path !== src);
    this.setData({
      editImages,
      editImageTag: editImages.length ? this.data.editImageTag || tagStore.getFirstSelectableTag() : ""
    });
  },

  async togglePinnedSelected() {
    const item = this.data.selectedItem;
    if (!item) return;
    try {
      await cloudStore.updateFields(item.id, { isPinned: !item.isPinned });
      this.refreshSelected(item.id);
    } catch (error) {
      console.error("update pinned state in cloud failed", error);
      if (cloudStore.isConflict(error)) {
        this.refreshSelected(item.id);
        wx.showToast({ title: "已同步其他设备更新，请重试", icon: "none" });
      } else {
        wx.showToast({ title: "云端更新失败", icon: "none" });
      }
    }
  },

  async toggleUsedSelected() {
    const item = this.data.selectedItem;
    if (!item) return;
    const nextUsed = !item.isUsed;
    try {
      await cloudStore.updateFields(item.id, {
        isUsed: nextUsed,
        usedAt: nextUsed ? Date.now() : null
      });
      this.refreshSelected(item.id);
      wx.showToast({ title: nextUsed ? "已标记用过了" : "已改回待用", icon: "success" });
    } catch (error) {
      console.error("update used state in cloud failed", error);
      if (cloudStore.isConflict(error)) {
        this.refreshSelected(item.id);
        wx.showToast({ title: "已同步其他设备更新，请重试", icon: "none" });
      } else {
        wx.showToast({ title: "云端更新失败", icon: "none" });
      }
    }
  },

  confirmDeleteSelected() {
    const item = this.data.selectedItem;
    if (!item) return;
    wx.showModal({
      title: "确定不要这条灵感了吗？",
      confirmText: "踢出脑袋",
      cancelText: "再想想",
      confirmColor: "#7554e2",
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: "正在删除", mask: true });
          let hasDeleted = false;
          try {
            await cloudStore.removeItem(item);
            this.closeDetail();
            this.loadItems();
            hasDeleted = true;
          } catch (error) {
            console.error("remove inspiration from cloud failed", error);
            if (cloudStore.isConflict(error)) {
              this.refreshSelected(item.id);
              wx.showToast({
                title: "其他设备刚更新了这条灵感，请重新确认",
                icon: "none"
              });
              return;
            }
          } finally {
            wx.hideLoading();
          }
          wx.showToast({
            title: hasDeleted ? "已删除" : "云端删除失败，请稍后重试",
            icon: hasDeleted ? "success" : "none"
          });
        }
      }
    });
  },

  refreshSelected(id) {
    const raw = store.getById(id);
    if (!raw) {
      this.closeDetail();
      this.loadItems();
      return;
    }
    const selectedItem = this.decorateItem(raw);
    this.setData({
      selectedItem,
      isEditing: false,
      editContent: selectedItem.content || "",
      editImages: selectedItem.images || [],
      editImageTag: normalizeImageTag(selectedItem.imageTag) || (selectedItem.images.length ? tagStore.getFirstSelectableTag() : ""),
      imageTags: buildSelectableImageTags(selectedItem.imageTag)
    });
    this.loadItems();
  },

  goAdd() {
    wx.navigateTo({ url: "/pages/add/add" });
  }
});
