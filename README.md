# 灵感脑袋小程序骨架

这是「灵感脑袋」的微信小程序原生骨架，当前版本先用本地 `wx.setStorageSync` 存数据，方便快速跑通体验。

## 如何打开

1. 打开微信开发者工具。
2. 选择“导入项目”。
3. 项目目录选择：
   `/Users/zhoujj/Documents/Codex/lingan-naodai-miniprogram`
4. AppID 可以先用测试号，或在 `project.config.json` 里替换成你的正式 AppID。

## 已有页面

- `pages/index/index`：脑袋首页，搜索 + 瀑布流。
- `pages/add/add`：塞点灵感，读取剪贴板、写文字、放图片、备注、保存。

## 当前数据字段

```js
{
  id,
  content,
  images,
  imageTag,
  source,
  note,
  isPinned,
  isFavorite,
  isUsed,
  isDeleted,
  createdAt,
  updatedAt,
  usedAt
}
```

## 下一步建议

1. 把本地 storage 换成云数据库。
2. 把图片临时路径换成云存储 fileID。
3. 接入 OCR，让搜索支持“图里的字”。
4. 完善首页详情弹层里的编辑、回收站和清理图片文件能力。
