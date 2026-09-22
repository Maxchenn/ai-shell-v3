# AI Shell V3

一个基于 Tauri 2 的轻量 AI 网页桌面壳。

当前版本包含：窗口位置/大小持久化、Alt+Space 呼出/隐藏、F 全屏、手动置顶、托盘、单实例、开机启动、多 AI 网站和自定义网址。

## 当前测试方式：GitHub Actions

不需要在本机安装 Node.js、Rust 或 Visual Studio Build Tools。上传到 GitHub 后，在 **Actions → Build Windows → Run workflow**，由 GitHub 的 Windows runner 自动编译并生成 NSIS 安装包。

详细步骤见 `README-GITHUB.md`。
