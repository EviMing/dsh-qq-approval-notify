# qq-approval-notify

DeepSeek Harness 的「需要你处理」QQ 通知插件：当 DSH 弹出审批（包括沙箱提权、命令执行、文件写入等），或者 `ask_user_question` / 计划审核在等你在界面上回答时，通过本机 NapCat 给主人发一条 QQ 消息；如果找不到可用的 NapCat，就退回 Windows 通知。

## 消息格式

```
【申请{XX}权限】申请原因
```

`XX` 会尽量说人话：

| 审批类型 | XX |
| --- | --- |
| 沙箱提权（`escalate sandbox to ...`） | `沙箱` |
| bash / shell / exec | `执行命令` |
| run_code | `执行代码` |
| write / edit / patch / delete | `修改文件` |
| read / glob / grep | `读取文件` |
| web_fetch / web_search | `联网` |
| 插件安装、技能、子代理、MCP 等 | 对应行为 |
| 其他工具 | `调用 <工具名>` |

原因优先使用 DSH 提供的 `displayReason.zh`，因此和审批弹窗里显示的文字一致。

`dsh-ops` 的 `ops_bash` 提权走的是它自己的审批通道，事件里只有 `justification`、不带沙箱模式信息，所以这类申请显示为 `执行命令`（原因就是你的 justification）；通过 `dsh-sandbox` 发起的提权会显示 `沙箱`。

### 提问 / 等待界面回答

`ask_user_question`（以及计划审核这类走 `user-questions/request` 的交互）会发：

```
【需要你回答】<标题>：<问题>（单选：选项 A / 选项 B）
```

多个问题时，第一行带 `【需要你回答】`，后续问题以 `- ` 开头；带选项时标出「单选 / 可多选」；问题附带的 `detail` 会截断后放在 `〔…〕` 里。

## 配置文件

默认读取：

```
%DSH_HOME%\qq-approval-notify.json
```

`DSH_HOME` 未设置时是 `C:\Users\<你>\.dsh`。也可以用环境变量 `DSH_QQ_APPROVAL_CONFIG` 或插件行配置里的 `configFile` 指定其他路径。

```json
{
  "ownerQQ": "2368199809",
  "selfQQ": "3641194452",
  "napcat": {
    "endpoints": ["http://127.0.0.1:3000"],
    "ports": [3000, 3001],
    "token": "你的 NapCat token",
    "timeoutMs": 1200,
    "discoveryCacheMs": 60000
  },
  "windowsNotification": {
    "enabled": true,
    "timeoutMs": 12000
  },
  "dedupeMs": 20000,
  "debug": false
}
```

- `ownerQQ`：主人（收件人）的 QQ 号。
- `selfQQ`：DSH 自己登录的 QQ 号。插件对每个候选 NapCat 调用 `get_login_info`，只有返回的 `user_id` 等于 `selfQQ` 才会使用，避免进错 NapCat / QQ 进程。
- `napcat.endpoints`：优先探测的 OneBot HTTP 地址。默认 `http://127.0.0.1:3000`。
- `napcat.ports`：配置的地址都不通时，额外的候选端口。插件还会通过 `netstat -ano -p tcp` + `tasklist` 找出 QQ / NapCat / node 进程正在监听的本地端口。
- `napcat.token`：OneBot 的 access token，作为 `Authorization: Bearer ...` 发送。
- `dedupeMs`：相同申请文本在该时间窗内只通知一次，避免重试风暴；`0` 表示关闭去重。
- `windowsNotification.enabled`：NapCat 不可用时是否尝试 Windows 通知。

缺少 `ownerQQ` 或 `selfQQ` 时，插件拒绝猜测收件人和 NapCat，只尝试 Windows 通知。

## 通知流程

1. 监听 `approval/request` 和 `user-questions/request`（只观察，不参与回答），生成消息。
2. 找 NapCat：配置地址 → 进程端口 → 默认端口；逐个 `get_login_info` 校验 `selfQQ`。
3. 用 `send_private_msg` 发给 `ownerQQ`。
4. NapCat 不可用或发送失败 → Windows Toast（WinRT），失败再试托盘气泡。
5. 都失败 → 写日志并放弃本次通知。

整个通知流程是 fire-and-forget，并且始终调用 `next()`；通知失败不会影响审批或提问本身。

## 安装 / 更新

本插件只装在 Host 侧，不需要 Client 代码。推荐用 tarball 安装（Windows 未开启开发者模式时，pnpm 对本地目录创建符号链接会被拒绝）：

```powershell
cd D:\DSH_WorkArea\qq-approval-notify
npm pack --pack-destination dist
```

然后让 DSH 的 `plugin_manager` 安装 `dist\local-qq-approval-notify-<版本>.tgz`。修改源码后重新 pack 并重装即可；配置文件在包外，重装不会丢。

装好后如果正在运行的 DSH 里没有变化，重启一次 DSH：Node 会缓存已加载的 ESM 模块，重装或开关插件都不会替换运行中进程里的旧代码。

### 实现要点（给改代码的人）

`approval/request` 和 `user-questions/request` 都是 waterfall 事件。Web 端的转发器在启动时注册了不 `prepend` 的监听器，它们把事件转发给浏览器并直接返回浏览器结果，监听链到此结束；后注册的观察者永远不会被调用。因此本插件用 `ctx.on(..., handler, { prepend: true })` 让自己排在链首，同时仍然立刻 `return next()`，不影响正常审批和提问。

## 注意

- DSH 的审批策略为 `never` 时不会产生审批请求，插件也就不会通知。需要用 `ask`（或会触发审批的模式）才有意义。
- 这个插件只是「提醒」：在 QQ 里回复不会自动批准审批，也不会替你回答问题，仍需回到 DSH 界面处理。
- Windows Toast 依赖当前用户桌面会话；在无交互会话中会退回托盘气泡，再失败则放弃。
- 只使用 Node 内置模块，无额外依赖。

## 测试

```powershell
cd D:\DSH_WorkArea\qq-approval-notify
node test/check.mjs
```

测试包含消息格式（审批 + 提问）、配置解析、假 OneBot 端到端、真实 NapCat 只读探测和 Windows 通知自检。

发送一条真实的 QQ 自检消息（可选项）：

```powershell
$env:DSH_QQ_LIVE_SEND = '1'; node test/check.mjs
```

## 文件

- `index.js`：Host 插件入口，监听 `approval/request` 与 `user-questions/request`，决定 QQ / Windows 通知。
- `lib/config.mjs`：读取并校验配置文件。
- `lib/approval.mjs`：把审批事件转成 `【申请{XX}权限】...` 文本。
- `lib/question.mjs`：把提问事件转成 `【需要你回答】...` 文本。
- `lib/onebot.mjs`：NapCat 发现、`selfQQ` 校验和 OneBot 发送。
- `lib/windows-toast.mjs`：PowerShell Toast / 托盘气泡回退。
