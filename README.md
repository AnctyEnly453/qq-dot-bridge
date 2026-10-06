# qq-dot-bridge

A small, signed QQ gateway and Python client for personal assistants. 服务端与客户端同仓，配置与运行数据分离。

**One instance = one QQ account + one client signing identity.** 每个 dot 使用自己的密钥和独立实例；此项目不提供共享网关的多租户路由。

## 能做什么

- 私聊/群聊的文本、表情、图片、引用回复与群内 @
- 按会话隔离的收件轮询、保留历史、搜索、消息及媒体读取
- 可选收藏、群消息回应、已声明测试消息撤回、音频发送与撤回通知
- 双向 Ed25519 签名、防重放、持久化发送记录；不确定的发送不会自动重试

网关不调用大模型、不自动回复、不决定聊天权限。调用方决定内容与时机，服务端只允许配置中的会话。没有远程 shell、通用执行器、数学协作服务或语音模型。

## 结构

- `server/main.mjs`：组装并启动一个网关
- `server/src/`：签名边界、会话/历史、发送与媒体、NapCat 传输
- `client/qq.py`：安装、自检、状态查询及 QQ 工具调用
- `config.example.json`：唯一模板；不含任何真实身份、地址或凭据
- `docs/`：部署、协议、依赖及发布边界

## 开始

服务端需要 Linux、Node.js 24+、Python 3.10+ 和已有登录的 NapCat 容器。请先阅读 [部署说明](docs/deployment.md)，尤其是账号隔离、Docker 权限和密钥交换。

```sh
cp config.example.json config.json
python3 -m venv .venv
.venv/bin/python -m pip install -r server/requirements.txt -r client/requirements.txt
# 填写 config.json；python 填入此虚拟环境解释器的绝对路径。
npm start
```

模板故意不可直接运行：先配置账号、允许会话、HTTPS origin 和现有 Ed25519 密钥。此仓库不会生成或登记实际身份。

客户端克隆同一仓库后：

```sh
cd client
python3 qq.py setup
# 配置管理员提供的连接信息和本机私钥后：
python3 qq.py doctor
python3 qq.py status
python3 qq.py read get_chat_info --body request.json
```

完整参数和发送防重行为见 [客户端说明](client/README.md)。客户端不含后台守护进程。

## 验证

```sh
npm test
npm run check
```

测试使用虚构账号、内存密钥和临时数据库，包含 Node/Python 签名互通及模拟 NapCat 的完整启动；不连接真实 QQ。音频测试另需本机 FFmpeg/ffprobe。详见 [验收范围](docs/verification.md)。

## 当前边界

- 这是从单账号自用实现整理的独立发布版；未在新的真实 QQ 环境完成端到端验收。
- 历史来自最新窗口轮询及有限群历史回补，**不保证完整历史或无遗漏**。
- 一个实例最多配置 16 个私聊和 16 个群。多个 QQ 需独立 NapCat、目录、密钥、端口和 HTTPS origin；仅修改客户端账号字段不会切换 QQ。
- 音频与额外动作默认关闭。群回应目前只开放 emoji `14`；撤回仅限预先声明且确认发送的短时测试消息。
- `online=true` 是签名状态；服务端验证实际账号，客户端状态协议本身不返回账号证明。

## 许可证与依赖

本仓库原创桥接代码采用 [MIT](LICENSE)。NapCat、QQ、Node.js、Python、Pillow、cryptography 和 FFmpeg 都是单独依赖，没有打包其源码或二进制，遵循各自许可证。

**NapCat 当前许可证含非商用与再分发限制，不能用本仓库 MIT 覆盖它。** 安装前查看 [第三方来源与许可证](THIRD_PARTY_NOTICES.md)。本项目不隶属于或代表腾讯、NapCat 或 OpenAI。
