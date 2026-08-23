# Breeze Plugin Example

最小可运行示例，仅包含占位实现：

- `getInfo`
- `searchComic`
- `getComicDetail`
- `getReadSnapshot`
- `fetchImageBytes`
- `getSettingsBundle`

构建流程：

1. 生成根目录 `manifest.json`
2. `rspack` 构建 bundle
3. 自动生成 `.br` Brotli 压缩版本

## 收藏工作流

插件导出 `startFavoriteAction` 和 `continueFavoriteAction`，对应绅士漫画的书架操作：

- 加入书架：展示已有书架，也允许输入新书架名称。
- 新建书架：先调用站点的新建书架接口，再重新获取书架 ID，最后加入漫画。
- 从当前书架移除：根据当前书架页面中的条目 ID调用移除接口。
- 取消全局收藏：遍历所有书架并移除漫画对应的全部条目。
- 移动书架：先加入目标书架，再移除原书架条目；移除失败时返回 `partial`。

当前 `breeze-plugin-kit` 仍引用同级目录的本地版本，因为收藏工作流类型尚未发布到 npm：

```json
"breeze-plugin-kit": "file:../breeze-plugin-kit"
```
