# AI Shell V3 - GitHub Windows Build

这是一个用于第一次 Windows 云端编译验证的版本。

## 怎么用

1. 在 GitHub 新建一个空仓库。
2. 把整个项目文件夹中的内容上传到仓库根目录。
3. 打开 GitHub 仓库的 **Actions**。
4. 选择 **Build Windows**。
5. 点击 **Run workflow**。
6. 等待构建完成后，打开这次运行记录，在 **Artifacts** 中下载 **AI-Shell-Windows**。
7. 解压 Artifact，运行里面的 `*-setup.exe`。

## 注意

第一次构建的目的主要是验证：
- Tauri 项目能否在 Windows 云端成功编译
- NSIS 安装包能否正常生成
- 安装后程序能否启动

当前版本暂时没有加入运行时 debug.log。先完成第一次实际构建验证，再根据真实运行结果继续修改。
