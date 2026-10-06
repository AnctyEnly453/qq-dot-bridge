# Portable signed QQ client

供另一台主机或 AI 接入自己获授权的 QQ 网关。Python 3.10+；一个入口 `qq.py`、一个运行配置 `config.json`。客户端不包含服务器执行器。

## 开始使用

```sh
python3 qq.py setup
```

安装器仅在本目录创建 `.venv`、安装固定版本依赖、首次复制空配置；已有配置不会被覆盖。它不生成密钥、不登记身份、不登录 QQ、不发消息，也不改系统网络或服务。安装依赖使用主机现有的包仓库和网络策略，失败后不会换源或绕过限制。依赖已装好时可用 `python3 qq.py setup --skip-install`。

填写 `config.json`，然后：

```sh
python3 qq.py doctor
python3 qq.py status
```

`doctor` 完全离线，不创建身份或状态文件；只检查配置和已有 Ed25519 私钥，输出客户端公钥 SHA-256 指纹，不输出私钥。

`status` 发送一次只读签名 GET `/qq/status`，验服务器签名后输出结果。未确认账号绑定时会在网络请求前拒绝。`online=true` 只代表该接口报告在线，当前协议不返回 QQ ID，不能证明它就是你期望的账号；结果始终明确 `qq_identity_verified=false`。

若这台主机已经能访问服务，无需重做网络配置。仅在需要定位接入故障时使用：

```sh
python3 qq.py probe
```

它对现有 `/qq/status` 发无凭据 HTTPS GET，收到鉴权拒绝是正常现象；输出只能证明 TLS/HTTP 到达。这里没有假设存在 `/health`。网络是否允许访问服务器由运行主机决定；客户端不调整白名单、代理、证书或权限，也不会尝试替代链路。

## 配置与第二账号

- `server_url`：管理员给出的独立 HTTPS origin，含必要端口，不带末尾 `/`、路径、查询参数或凭据。必须与服务端签名 audience 完全相同；留空默认不会连任何账号。
- `client_key_id`：管理员为这个 AI 分配的新身份名称。
- `private_key_file`：相对配置文件目录的 Ed25519 PEM 文件位置。文件需要当前用户拥有；POSIX 权限 0600。不要复制第一客户端的私钥。
- `server_key_id` / `server_public_key_raw_base64`：通过已验证渠道拿到的服务器验签公钥配置；不能从未认证的首次响应自动信任。
- `expected_qq_id`：这个 AI 预期的 QQ 账号，必须明确填写。
- `account_binding_confirmed`：只有管理员已核验“此 origin + 客户端身份只路由到这个 QQ 实例”后才设为 true。这是管理员确认记录，**不是客户端完成了远端验号**。
- `state_directory`：相对配置目录的持久状态目录；仅第一次明确写操作时创建。不要在请求间换路径或删除账本。
- `require_https_proxy`：默认 true，必须有主机既有 HTTPS 代理，且目标不能处于代理绕过清单；缺少代理就停止。若该主机政策本来允许其默认联网方式，可以明确设为 false，此时仍使用平台现有代理/直连选择。不能为了绕过拒绝改此项。
- `timeout_seconds`：1–60，默认 25。

生成或登记新的持久身份、增加服务器权限，都需要操作者另行明确授权。本包没有自动注册或密钥生成功能，不会拿旧身份替代。

同一台服务器承载两个 QQ 时，服务端仍需独立登录实例、账号数据、签名身份授权、桥接/监听、收发记录、游标和媒体状态。仅改 `expected_qq_id` 不会切换 QQ。账号实例可以通过不同受信 HTTPS origin 接入；不要只在反代中加 `/bot2` 再剥掉，因为 audience/path 都参与签名。第二实例尚未配置时，本包只是客户端能力准备好，不代表第二 QQ 已接通。

## QQ 工具

只读例子中的会话和游标必须属于已授权的这个账号。请求 JSON 由调用方准备，客户端不自作主张选群或私聊对象：

```sh
python3 qq.py read get_chat_info --body request.json
python3 qq.py read read_history --body request.json
python3 qq.py read get_send_result --body lookup.json
```

所有已收录 QQ 工具通过同一入口使用；完整列表见 `python3 qq.py tool --help`：

```sh
python3 qq.py tool list_favorites --body request.json
```

显式发送已获授权的消息：

```sh
python3 qq.py send --body approved-send.json
```

`send` 等价于 `tool send_message`。请求需包含 `conversation`、已确定的 UUIDv4 `request_id` 和服务器支持的 `messages`。发送范围、内容和授权由调用 AI 与服务端共同约束，安装包不是发送许可。

还支持已有 QQ 收藏、音频发送、回应、测试消息撤回等已知接口。服务端没启用的能力会失败；客户端不会自行安装或开通服务器功能。`collect_favorite` 的线上协议没有操作 UUID，因此需另传本地 `--operation-id <已确定的UUIDv4>`，仅用于本地防重，不加入线上 JSON。`react_message`/`recall_test_message` 用正文中的 `action_id`；其他写操作使用 `request_id`。

所有写操作在网络 I/O 前，把操作 ID、范围散列、请求散列记入持久 SQLite 账本，不存正文或凭据。相同操作 ID 再次尝试即拒绝，重启后仍有效。消息/音频/收藏发送共用发送 ID 命名空间，不能换接口绕过不确定结果。不要另建 ID、移动状态目录或删账本来重试。

超时、断线或验签失败会返回 `mutation_state=unknown`；用同一 ID 和原会话调用返回的 `lookup_tool` 查询。HTTP 200 或 `response_signature_verified=true` 只代表收到可信响应，仍需看正文的 `state` 是否确认为 sent/verified 等成功状态。查询/收藏验证可能更新服务端内部收据，客户端不会推进调用方游标。

未暴露 `/agent/*`、任意 shell、任意 URL 或通用 OneBot 调用。TTS 服务属于单独的服务器能力，本包不开放它的执行接口。

## 协议与安全

沿用原客户端的 Ed25519 canonical 协议：绑定 HTTPS audience、身份、方法、完整路径、时间戳、随机 nonce、正文 SHA-256；服务器响应再绑定请求散列、nonce、HTTP 状态和响应正文，允许时钟误差 ±30 秒。签名使用压紧后的 UTF-8 JSON，发出的字节和 Content-Length 与签名一致，保留不透明游标原值。

TLS 始终校验证书与主机名，不跟随重定向，不接受压缩响应，不自动重试。状态最大 4 KiB，工具请求/响应最大 16 MiB。错误输出不包含代理 URL、请求头、私钥或原始异常详情；正常工具输出会包含用户请求读取的 QQ 内容，请由调用方按自己的隐私权限处理。

这是无守护进程的单次调用客户端，未安装后台服务、循环轮询或自动回复。

## 验证范围

```sh
python3 -m unittest discover -s tests -v
python3 -m py_compile qq.py client.py tests/test_client.py
```

离线测试使用内存中的临时 Ed25519 测试密钥、模拟响应和临时测试账本，不访问真实服务、不生成持久身份、不发送 QQ。覆盖双向签名、篡改/过期/错误公钥/重定向拒绝、UTF-8 与游标、TLS/代理策略、只读零状态写入、重复和不确定发送防重、账号配置默认拒绝、执行器路径拒绝、安装模板幂等。

没有做目标主机安装、真实第二身份登记、第二账号接入、双账号交叉访问拒绝或真实 QQ 发送验收。需在服务端隔离配置完成并获授权后逐项验收。

## 来源与分发

签名与防重逻辑源自本项目现有 Python QQ 客户端，整理为单入口、单配置；没有打包原运行目录。第三方依赖单独安装，遵循其各自许可证。模板不含真实服务器地址、账号、群号或密钥；测试数字仅为虚构 fixture。

只分发源码、空模板、依赖清单和测试。不要把 `config.json`、`identity/`、`state/`、`.venv/`、私钥、QQ 消息或响应文件一起压缩/提交。
