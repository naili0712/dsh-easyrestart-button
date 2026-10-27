# dsh-easyrestart-button

> **AI 辅助声明**：本插件由 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 辅助创建
> —— 代码与文档均在与 DSH 的会话协作中产出，由仓库所有者审核后发布。
> 使用前请自行验证是否适合你的环境。

为 DeepSeek Harness 桌面版（Electron）提供一个位于窗口标题栏的重启按钮：点击后在原位展开确认气泡，确认后重启整个应用。

## 它做什么

为你的 DeepSeek Harness 添加一个简单的重启按钮。

## 安装

运行环境为 DSH 桌面版（Windows）。以下以 `desktop` profile 为例。

```powershell
# 从本地目录安装（开发与自用）
dsh plugin --profile desktop add link:D:/path/to/dsh-easyrestart-button
```

随后将包名加入该 profile 的 `package.json` 中 `dsh.profile.bundles` 字段：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["dsh-easyrestart-button"]
    }
  }
}
```

重启 DSH 后生效。

卸载方式：

```powershell
dsh plugin --profile desktop remove dsh-easyrestart-button
```

并删除 `dsh.profile.bundles` 中对应的条目。

## 工作机制

```
按钮（client 半，DOM 挂载）
  └─ POST /dsh-easyrestart-button/api/restart[?force=1]
        └─ host 半（Cordis 插件，注册于 webServer）
              ├─ 守卫：检查运行中的任务与正在安装的插件 → 返回 409 或直接拒绝
              └─ 写入交接描述并拉起 detached helper
                    └─ helper（process.execPath + ELECTRON_RUN_AS_NODE=1）
                          ├─ 记录窗口是否最大化
                          ├─ 结束主进程并收尾遗留进程
                          └─ 重新拉起，并恢复最大化状态
```

重启必须由 helper 完成。桌面版的 host 是 Electron 主进程的子进程，主进程未向插件提供任何重启通道；host 自行退出只会触发「启动失败」恢复窗口。Windows 下应用菜单仅含 devTools 项，托盘菜单仅含「打开」与「退出」，因此重启只能由宿主之外的进程执行。

按钮采用 DOM 挂载而非 slot。标题栏该行属于窗口 chrome，官方未暴露对应的 slot；`conversation.session.header.actions` 对应的是内容区标题栏，位置不同。

## 已知限制

- 仅支持 Windows 桌面版。helper 依赖 `taskkill` 与 Win32 窗口 API。
- 重启即结束进程后重新拉起，正在进行的生成与工具调用将中断；存在任务时会要求一次确认。
- 草稿清理仅作用于当前会话。无法从地址栏取得会话 id 时，仅在存在唯一非空草稿的情况下执行，以避免影响其他会话。
- 按钮依据「编辑」/「Edit」文案定位，DSH 调整标题栏结构后需同步修改。

## 致谢与许可

host 半（`lib/index.js`、`lib/helper.cjs`、`lib/sweep.js`）与 client 半的部分实现来自
[`@luoshuizhiwei/dsh-desktop-restart`](https://www.npmjs.com/package/@luoshuizhiwei/dsh-desktop-restart) v0.4.4（MIT），
在 MIT 许可下复制并修改，原版权归其作者所有。

本仓库的主要改动如下：

1. 移除侧栏面板、侧栏底部、设置行与斜杠命令四个入口，仅保留标题栏按钮；
2. 标题栏按钮改为 DOM 挂载，以「编辑」菜单项为锚点，并沿用其字号与颜色；
3. 二次确认改为贴合按钮的气泡形式，仅保留「取消」与「重启」；
4. 新增重启后的最大化恢复；
5. 新增确认重启时的当前会话草稿清理。

本项目以 MIT 许可发布，详见 [LICENSE](LICENSE)。
