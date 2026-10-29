# dsh-easyrestart-button

> AI 辅助声明：本插件由 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 辅助创建，
> 代码与文档均在与 DSH 的会话协作中产出，由仓库所有者审核后发布。使用前请自行验证是否适合你的环境。

这是一个简单的重启插件：为 DeepSeek Harness 桌面版增加一个标题栏重启按钮，使重启 DSH 更简单；任务运行时，也可以让它空闲后自动重启。

## 功能

- 标题栏按钮：点击后就地展开确认，重启整个应用，并在重启后恢复窗口状态。
- 空闲重启：存在运行中的任务时，可安排任务结束后自动重启。
- 本机请求通道：同机进程可写入请求文件，安排一次空闲重启，无需浏览器会话。

## 安装

运行环境为 DSH 桌面版（Windows），以 `desktop` profile 为例。

```powershell
dsh plugin --profile desktop add link:D:/path/to/dsh-easyrestart-button
```

将包名加入该 profile 的 `package.json` 中 `dsh.profile.bundles`：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["dsh-easyrestart-button"]
    }
  }
}
```

重启 DSH 后生效。卸载：

```powershell
dsh plugin --profile desktop remove dsh-easyrestart-button
```

并从 `dsh.profile.bundles` 中删除对应条目。

## 机制

```
按钮 / 同机进程
  └─ host 守卫 → 空闲等待 → detached helper → 结束进程并重新拉起，恢复窗口状态
```

重启由宿主之外的 helper 完成。桌面版 host 是 Electron 主进程的子进程，主进程未提供重启通道；host 自行退出只会触发「启动失败」恢复窗口。因此重启只能由外部进程执行。

按钮采用 DOM 挂载而非 slot：标题栏属于窗口 chrome，官方未暴露对应 slot。

## 本机请求通道

平台门仅接受浏览器会话 cookie，同机进程无法通过。因此另设一条只接受等待请求的文件通道：

```text
<DSH_HOME>/desktop-restart/restart-request.json
```

```json
{ "wait": true, "by": "agent" }
```

- 宿主每 2 秒读取一次，仅接受 `wait: true`，即「等空闲再重启」，与界面按钮共用同一条排程；该通道不支持立即重启。
- `at` 为可选的毫秒时间戳；超过 5 分钟的请求视为过期，只删除、不执行。
- 请求读完立即删除；已在等待或交接中的请求会被忽略并记录日志。
- 该通道不扩大本机权限：能写入此目录的进程本就可启动 helper。区别在于它必须经过完整守卫并留下日志。
- 宿主就绪时写入 `channel-ready.json`（进程号与时间戳），供脚本确认新代码已加载，避免在旧代码上残留请求文件而导致二次重启。

安全边界未变：平台门仍只接受同源 loopback 的浏览器会话；文件通道不绕过它，只是将同机进程已有的权限纳入同一套守卫。

## 限制

- 仅支持 Windows 桌面版；helper 依赖 `taskkill` 与 Win32 窗口 API。
- 重启会结束进程并重新拉起，正在进行的生成与工具调用将中断；存在任务时需确认一次。
- 草稿清理仅作用于当前会话；无法取得会话 id 时，仅在存在唯一非空草稿的情况下执行。
- 按钮依据「编辑」/「Edit」文案定位，DSH 调整标题栏结构后需同步修改。
- 文件通道仅支持空闲重启；立即重启仍需界面按钮。

## 致谢与许可

host 半（`lib/index.js`、`lib/helper.cjs`、`lib/sweep.js`）与 client 半的部分实现来自
[`@luoshuizhiwei/dsh-desktop-restart`](https://www.npmjs.com/package/@luoshuizhiwei/dsh-desktop-restart) v0.4.4（MIT），
在 MIT 许可下复制并修改，原版权归其作者所有。

本仓库的主要改动：

1. 移除侧栏面板、侧栏底部、设置行与斜杠命令入口，仅保留标题栏按钮；
2. 标题栏按钮改为 DOM 挂载，以「编辑」菜单项为锚点，沿用其字号与颜色；
3. 二次确认改为贴合按钮的气泡，仅保留「取消」与「重启」；
4. 新增重启后的窗口状态恢复；
5. 新增确认重启时的当前会话草稿清理；
6. 新增本机请求通道，供同机进程安排空闲重启；
7. 文件通道发起的重启同样会清理当前会话草稿。

本项目以 MIT 许可发布，详见 [LICENSE](LICENSE)。