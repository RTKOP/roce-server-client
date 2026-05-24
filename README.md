# RoCE Batch Traffic Console

一个轻量级 Web 控制台，用于在多台服务器上批量编排 RoCE 打流任务。它可以：

- 维护服务器清单
- 服务器资产管理独立在 `/servers.html` 子页面
- 为每台启用服务器选择角色：server / client
- 批量添加服务器
- 为每台 client 指定目标 server
- 为每台 server/client 分别选择 RoCE 网卡、GID index、测试类型和并发流数量
- 支持 `-a` 全部包长和 `--run_infinitely` 持续运行
- 性能参数为空时不会拼到命令里，例如 `-D`、`-q`、`-t`、`-p`、`-i`、`-x`
- 支持 SSH 密码登录，服务器清单、扫描结果和任务历史会持久化到本地 `data/`
- 通过 SSH 批量启动 server 端和 client 端
- 在页面上查看任务状态、日志和一键停止
- 持久化服务器清单和任务结果，刷新页面或重启服务后可恢复最近任务

默认使用 Linux `perftest` 工具，例如 `ib_write_bw`、`ib_read_bw`、`ib_send_bw`。运行本程序的机器需要能 SSH 到目标服务器。

如果你平时手工使用：

```bash
ib_write_bw -a -F -d mlx5_0 43.1.1.1 --report_gbits --run_infinitely
```

页面中勾选 `全部包长 -a` 和 `持续运行 --run_infinitely`，只填写网卡和目标 server 的 RoCE IP，其它参数留空即可生成等价命令。

## 快速开始

```bash
python3 app.py
```

打开：

```text
http://127.0.0.1:8080
```

服务器管理页：

```text
http://127.0.0.1:8080/servers.html
```

## Windows 单文件 exe

在 Windows 构建机上安装 Python 3 后，双击：

```text
build_windows_exe.bat
```

构建完成后会生成：

```text
dist\RoCE批量打流控制台.exe
```

把这个 exe 单独拷到 Windows 机器上，双击即可启动，程序会自动打开浏览器访问 `http://127.0.0.1:8080`。服务器清单、扫描结果和测试历史会保存在 exe 同目录的 `data\` 文件夹里。

Windows 版 exe 已包含密码 SSH 所需的 `paramiko`，不需要目标环境配置 SSH 密钥；目标服务器仍需要能通过网络访问，并安装 perftest/rdma-core/iproute2。

如果页面打开后只有文字、没有样式，说明使用的是旧 exe；重新双击 `build_windows_exe.cmd` 构建并替换 `dist\RoCE批量打流控制台.exe`。

## 目标服务器依赖

每台参与打流的服务器建议安装：

```bash
perftest
rdma-core
iproute2
```

并确保控制机可以 SSH 到目标机器：

```bash
ssh user@server hostname
```

如果不使用密钥登录，也可以在服务器管理页填写密码。密码会保存到本地 `data/roce_console.db`，适合内网测试工具使用；请不要把 `data/` 目录提交到 GitHub。

## 安全说明

点击“开始测试”后，本程序会通过 SSH 批量运行 perftest 命令。

真实执行时，本程序会通过 SSH 运行类似命令：

```bash
nohup ib_write_bw -d mlx5_0 -x 3 -F --report_gbits -D 30 -p 18515 > /tmp/roce_batch_...log 2>&1 &
ib_write_bw server_ip -d mlx5_0 -x 3 -F --report_gbits -D 30 -p 18515
```

停止任务时，会尽量杀掉本次启动的远端进程。

## 持久化

服务器清单、扫描结果、任务索引、任务日志和打流结果保存在 SQLite 单文件：

```text
data/roce_console.db
```

老版本 JSON 数据会在程序启动时自动导入 SQLite，原文件会作为本地备份保留：

```text
data/hosts.json
data/jobs.json
data/jobs/index.json
data/jobs/*.json
```

页面刷新后会自动恢复上一次任务；服务重启后会加载最近 100 条任务历史。任务历史不会保存 SSH 密码。

## 服务器批量添加格式

服务器管理页左侧“批量添加”支持每行一台服务器，字段用英文逗号分隔：

```text
名称,地址,SSH端口,用户,密码
```

示例：

```text
node01,10.0.0.1,22,root,password
node02,10.0.0.2,22,root,password
node03,10.0.0.3,22,root,password
```

角色、网卡、RoCE IP、目标 Server 等打流配置在主页编辑。

也可以在服务器管理页点击“下载模板”，按模板填写 `.xlsx` 后通过“选择 Excel”导入。页面上的修改会自动保存到本地 `data/roce_console.db`。
