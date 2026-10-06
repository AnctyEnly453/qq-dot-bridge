# 部署与客户端接入

## 1. 运行边界

这是 Linux 上的一个 Node.js 进程，绑定 `127.0.0.1`。由你现有的 HTTPS 反向代理对外提供服务；不附带 TLS 证书、域名或生产配置。

后端通过固定 `docker exec` 调用已有 NapCat 容器内的 curl/Python。它不是通用执行接口，但操作系统上的 Docker 权限本身很强。请使用专用主机或受控服务账号，不把未经信任的程序放在同一权限边界内；部署前由管理员明确授予所需权限。本项目不会更改 Docker 组、系统安全设置或防火墙。

需要：

- 主机：Node.js 24+（内置 `node:sqlite`）、Python 3.10+、Pillow、Docker CLI
- NapCat 容器：你已安装并接受其许可证的版本、已登录的 QQ、已启用带 token 的 OneBot HTTP；容器内 curl、Python 3
- 可选音频：容器内 FFmpeg 和 ffprobe
- 可选通知：相同端口的 OneBot 正向 WebSocket（当前适配器假定 HTTP/WS 共用监听端口）
- HTTPS 反向代理：保持原始 `/qq/...` 路径及请求头；请求体至少允许 3 MiB；读取超时建议 60 秒

不要把 NapCat API 或 WebUI 暴露给客户端。桥接只公开列出的 QQ 工具。QQ 登录、验证码和服务条款由账号所有者处理。

## 2. 唯一配置模板

复制根目录 `config.example.json` 为 `config.json`。也可通过 `QQ_BRIDGE_CONFIG` 指向另一份实例配置；相对文件路径以该配置文件目录为基准。

- `audience`：客户端访问的精确 HTTPS origin，例如 `https://qq.example.invalid`。不带尾斜杠、子路径或查询参数。示例域名不能用于真实连接。
- `client_key_id` / `server_key_id`：双方一致的签名身份标签。
- `self_id`：NapCat 当前实际登录的 QQ 账号。启动时不匹配会拒绝监听；每个原生请求前也重新核对。
- `allowed_privates` / `allowed_groups`：允许读写的会话 ID 字符串。默认全空；至少明确配置一个会话。第一个私聊也是旧私聊兼容接口的目标。
- `listen_port`：只绑定 loopback 的网关端口，默认 17445。
- `state_directory`：独立持久目录，保存收件状态、发送防重与收藏。服务以 0700 创建目录、0600 创建数据库；不要放在公开静态站点下。
- `client_public_key_file`：本实例唯一客户端的 Ed25519 公钥 PEM。
- `server_private_key_file`：服务器签名私钥 PEM，权限 0600。
- `python`：安装 Pillow 的 Python 解释器路径或命令名。生产建议填绝对路径。
- `napcat.container`：已有容器名；`http_port` 是容器内部的 OneBot HTTP/WS 端口，默认 3000。
- `napcat.token_file`：只含现有 OneBot token 的本地文件，权限 0600；当前适配器接受 40–100 位 URL-safe 字符。不要提交或发给客户端。
- `napcat.cache_mount`：主机上的 QQ 缓存挂载根目录绝对路径；未配置时接收图片读取不可用。
- `napcat.cache_container_path`：同一目录在容器内的位置，默认 `/app/.config/QQ`。媒体读取拒绝目录穿越、符号链接与不匹配的文件名。
- `features.actions`：启用收藏发送/原生收藏/群回应/测试撤回等额外动作；默认 false。
- `features.audio`：启用音频发送；默认 false，与 actions 独立。
- `features.notices`：连接经过筛选的原生通知流；默认 false。关闭或断开时不得把历史缓存当作完整撤回状态。
- `client`：生成客户端配置时使用的本地路径与既有代理要求，无服务器凭据。

白名单是整个实例的授权范围，当前不支持一个实例内按客户端分别授权，也不支持在线修改配置；改后重启。配置只允许管理员编辑，不接受 QQ 消息指令改变权限。

## 3. 密钥交换

每个客户端在自己的机器上保管自己的 Ed25519 私钥，只向服务端管理员提供公钥。服务器持有独立响应签名私钥，只把其公钥交给客户端。通过已验证渠道核对公钥与所属实例，不能从第一次未认证响应自动信任。

本项目不自动生成、替换或登记密钥。密钥的创建和授权由部署者在自己的安全流程中完成。不要复用另一位 dot 的私钥，也不要把服务器私钥发给客户端。

服务器完成配置后，可导出仅含公开连接信息的客户端文件：

```sh
QQ_BRIDGE_CONFIG=config.json node scripts/export-client-config.mjs client-connection.local.json
```

此命令只读取服务器私钥以导出对应公钥，不传输或复制私钥，不覆盖已有输出。导出结果的 `account_binding_confirmed` 仍为 false；管理员需先确认“此 origin + 此客户端身份仅对应此 QQ 实例”。在客户端机器放置其自己的私钥、完成核对后，再把该字段置 true。

## 4. 启动与验收

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r server/requirements.txt
# config.json 的 python 指向 .venv/bin/python 的绝对路径
npm start
```

推荐用你已有的进程管理方式运行 `node server/main.mjs`，工作目录设为仓库根目录；保留同一状态目录。无需 `npm install`，服务端没有 npm 运行依赖。

验收順序：

1. 启动时账号核对成功，服务仅在 loopback 监听。
2. 客户端 `doctor` 离线通过，随后 `status` 双向签名通过。
3. 在获授权会话读信息/读历史；尝试未授权测试会话应拒绝。
4. 只有另外明确授权发送后，使用固定 UUID 发一条测试消息并核对回执。
5. 测试断线、同一 UUID 再查结果、重启后的防重；绝不换 UUID 重发不确定消息。
6. 若启用图片/音频/通知，分别核验格式限制、缓存映射、回执和撤回通知。不能从基本状态通过推断这些功能可用。

本次开源整理没有改动或部署任何生产 QQ 服务。

## 5. 另一个 QQ / dot

为它创建独立 NapCat 登录与数据目录、桥接状态目录、client/server 密钥对、内部监听端口和 HTTPS origin。所有配置都按新实例填写；不要从旧状态目录复制数据库或聊天记录。

多个实例可以使用同一源码。当前没有共享网关路由表、多身份切换、自动账号登录或跨账号调度。两个实例的真实连通和交叉访问拒绝仍需单独验收。
