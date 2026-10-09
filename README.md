# 校园网 WiFi 自动认证

连上 `ChinaTelecom-EDU` 后，自动在认证门户完成登录，开机即可上网，不用再手动点。

## 快速开始

```powershell
copy config.example.json config.json     # 然后编辑 config.json 填你自己的账号密码
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

`config.json` 里有你的账号密码，**已被 .gitignore 排除，不会进版本库**。
- 认证门户：`http://110.184.24.61`

---

## 它是怎么工作的

这个门户（锐捷 SMP + CAS 单点登录）的登录流程带动态加密和 `flowSessionId`，纯 HTTP 重放很脆弱。
所以本方案换了个思路：**用无头浏览器让门户自己的 JS 走完流程，脚本只负责填账号密码并点「立即登录」。**

每次运行的判断链：

1. 用 `generate_204` 探针判断是否真的能上网 → 能上网就直接退出（几乎零开销）。
2. 不能上网 → 检查当前 WiFi 名称是否是校园网（`config.json` 的 `wifiSsidPatterns`），不是就跳过，不会在家里/热点上乱试。
3. 向 `http://www.msftconnecttest.com/redirect` 发一个明文 HTTP 请求，网关会 302 到认证门户，
   从 `Location` 里取出带 `userip` / `nasip` / `wlanparameter` 的认证入口 URL。
4. 校验入口确实能跳到门户主流程，然后启动**无头 Edge**，把账号密码填进登录框、点「立即登录」。
5. 轮询网络是否恢复；成功即退出，失败会重试并保存截图。

### 掉线自愈

除了开机时登录，还有一个**常驻监听**进程（`--watch`），每 15 秒检查一次网络：

- 刚发现离线时，**只认网关下发的重定向**才动手——避免网络只是慢就被误判成离线、白做一次 CAS 登录。
- 离线超过 60 秒后升级为兜底尝试（用上次记录的 `nasip` 自己拼认证入口）。
- 离线超过 5 分钟则放慢到每 5 分钟一次，避免长时间故障时反复开浏览器。

所以 WiFi 掉线重连后，一般十几秒到一分钟内就自动恢复上网。

常驻进程有两层保命措施：

- **网络抖动不致命**：`ECONNRESET` 这类异常在常驻模式下只记日志、不退出
  （一次性执行时仍按失败处理，退出码 1）。每约 30 分钟写一条心跳日志，便于确认它还活着。
- **看门狗**：每 5 分钟的常规任务结束前会探测 `127.0.0.1:9334`（常驻进程的单例锁端口），
  端口没在监听就自动把常驻任务重新拉起。即使它意外退出，最多 5 分钟就会自愈。

> 这两条是踩坑补上的：2026-10-03 23:07 常驻进程因一次 `ECONNRESET` 退出码 1 挂掉，
> 而 Task Scheduler 的「失败后重启」并没有生效，导致监听停了 10 分钟无人接管。

---

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `autologin.js` | 主程序（Node，零第三方依赖），支持 `--watch` 常驻模式 |
| `cdp.js` | 极简 Chrome DevTools Protocol 客户端 |
| `config.json` | **账号密码和各项参数，要改就改这里** |
| `state.json` | 脚本自动维护，记录网关下发的 `nasip`，不用手改 |
| `run.ps1` | 常规任务的入口（隐藏窗口执行） |
| `run-watch.ps1` | 常驻监听任务的入口 |
| `install.ps1` | 注册两个计划任务（免管理员） |
| `uninstall.ps1` | 删除计划任务 |
| `probe.js` / `probe2.js` | 当初用来分析门户的侦察脚本，可留作排查工具 |
| `_portal-recon/` | 从门户抓下来的前端 JS（约 7MB），门户改版时用来重新找接口，可以直接删 |
| `logs\` | 运行日志与失败截图 |

---

## 安装

```powershell
powershell -ExecutionPolicy Bypass -File "D:\蹭饭图\wifi-autologin\install.ps1"
```

会注册**两个**计划任务：

**`WiFi自动认证`** —— 一次性执行
- **登录时** —— 开机登录后自动跑一次
- **每 5 分钟兜底** —— 已联网时脚本会立即退出，开销可忽略

**`WiFi自动认证-常驻`** —— 登录后一直运行
- 每 15 秒检查一次网络，掉线后尽快补认证（见上文「掉线自愈」）
- 崩溃会自动重启（最多 3 次，间隔 1 分钟）
- 用本地端口 9334 做单例锁，重复启动会自动退出

两个任务都在当前用户会话中运行，**不需要管理员权限**。

> 安装脚本里还注册了一个「网络连接事件」触发器，但实测**在这台机器上不生效**
> （`Microsoft-Windows-NetworkProfile/Operational` 的 EventID 10000 确实产生了，任务却没被拉起；
> 加上本机 `Get-ScheduledTask` 这类 CIM 接口本身就是坏的）。
> 所以重连后的恢复实际是靠常驻监听来保证的，那个触发器留着无害，不依赖它。

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File "D:\蹭饭图\wifi-autologin\uninstall.ps1"
```

---

## 日常使用

手动立刻登录一次（会弹出窗口，能看到过程）：

```powershell
cd "D:\蹭饭图\wifi-autologin"
node autologin.js
```

常用参数：

| 命令 | 说明 |
| --- | --- |
| `node autologin.js` | 已联网就退出，否则登录 |
| `node autologin.js --force` | 不管当前状态，强制走一遍登录 |
| `node autologin.js --dry-run` | 只打开页面填表、不点登录（验证用） |
| `node autologin.js --dump` | 配合 `--dry-run`，打印页面上所有按钮，便于门户改版后修选择器 |
| `node autologin.js --force --inspect` | 登录成功后打印认证成功页的结构和 localStorage，用来查"无感知认证"开关 |
| `node autologin.js --watch` | 常驻监听模式（计划任务用的就是这个，手动跑会占住终端） |

## 看日志

```
logs\autologin-YYYY-MM-DD.log   每一次认证的详细过程（推荐看这个）
logs\watch.log                  常驻监听的启停记录
logs\runner.log                 常规任务是否被触发、退出码
logs\fail-*.png                 失败时自动截的无头浏览器画面
```

---

## 常见问题

**改了 WiFi 密码 / 换了账号**
编辑 `config.json` 的 `account` 和 `password`，保存即可，不用重装任务。

**换了校园网 SSID（比如连了 2.4G 的另一个名字）**
往 `config.json` 的 `wifiSsidPatterns` 里加一条（支持正则），例如：

```json
"wifiSsidPatterns": ["ChinaTelecom-EDU", "UESTC-WiFi"]
```

**门户改版后不工作了**
先跑 `node autologin.js --dry-run --dump` 看页面结构；日志里有
`未找到登录表单` + 诊断信息，把 `config.json` 的 `loginButtonText` 调成新版按钮文字即可。

**不想让它自动跑**
执行 `uninstall.ps1`，或者临时停用：

```powershell
schtasks /change /tn "WiFi自动认证" /disable
schtasks /change /tn "WiFi自动认证-常驻" /disable
schtasks /change /tn "WiFi自动认证" /enable
schtasks /change /tn "WiFi自动认证-常驻" /enable
```

**WiFi 自己反复掉线（连上了又断）**
这跟认证无关，是无线网卡层面的问题。看事件日志：

```powershell
Get-WinEvent -LogName "Microsoft-Windows-WLAN-AutoConfig/Operational" -MaxEvents 20 |
  Where-Object Id -in @(8001,8003) | Select-Object TimeCreated, Id, Message
```

如果断开的「原因」写的是 **"网络被驱动程序断开连接"**，常见诱因是网卡的**省电模式**。
本机当前电池供电下的无线适配器节能等级是「中」（索引 2），可以改成最高性能试试：

```powershell
# 改无线适配器节能模式为「最高性能」（交流 + 电池），改成 2 即还原为「中」
powercfg /setacvalueindex SCHEME_CURRENT 19cbb8fa-5279-450e-9fac-8a3d5fedd0c1 12bbebe6-58d6-4636-95bb-3217ef867c1a 0
powercfg /setdcvalueindex SCHEME_CURRENT 19cbb8fa-5279-450e-9fac-8a3d5fedd0c1 12bbebe6-58d6-4636-95bb-3217ef867c1a 0
powercfg /setactive SCHEME_CURRENT
```

代价是续航会略降一点。另外本机 Intel 无线网卡驱动是 2022 年的（20.70.30.1），
去 Intel 或笔记本厂商官网更新驱动也值得一试。

**网页能开，但任务栏 WiFi 图标显示「无 Internet 访问」**
这不是认证问题，也不需要动认证脚本。根因是 **`NlaSvc`（网络位置感知）服务没在运行**：
它负责判定并发布网络连通状态，不跑的话 Windows 就只能显示「无 Internet」。

自检命令：

```powershell
Get-Service NlaSvc
# 正常应为 Status=Running, StartType=Automatic
# 若显示 Stopped / Manual 就是这个问题

# 再看 Windows 眼中的连通性（0 = 断开）
$nlm = [Activator]::CreateInstance([Type]::GetTypeFromCLSID([Guid]'DCB00C01-570F-4A9B-8D69-199FDBA5723B'))
$nlm.IsConnectedToInternet
$nlm.GetConnectivity()
```

修复：**双击 `fix-network-icon.cmd`**（会自动请求管理员权限），把 `NlaSvc` 启动起来并把启动类型改回「自动」。
重启一次更彻底。

> 注意：本机 `NlaSvc` 被改成了「手动」且**没有注册任何触发器**，所以开机后永远不会自己启动。
> 出厂默认是「自动」——否则每台 Windows 都会显示无 Internet。多半是网络加速/系统优化类工具改的。

**为什么在本机看到 `Get-ScheduledTask` 报 XML 错误？**
这台机器的 `Get-ScheduledTask` / `Start-ScheduledTask` CIM 接口本身有缺陷（连系统自带任务都读不了），
所以脚本统一改用 `schtasks.exe`。这不影响任务正常运行。

---

## 关于平板（鸿蒙 HarmonyOS NEXT）

**结论：鸿蒙 NEXT 上做不出"一键自动连网"的 App。** 原因是系统层面的，不是实现问题：

- NEXT 不再兼容安卓 APK；原生 `.hap` 应用要 DevEco Studio + 华为开发者签名证书才能安装。
- NEXT 的 `@ohos.wifiManager` 里连接网络那类接口属于**系统级权限**，普通应用申请不到。

好消息是**"连接"这一步本来就不用管**：`ChinaTelecom-EDU` 是开放网络，平板连过一次之后鸿蒙会记住并自动重连，
真正需要手动做的只有**门户认证**那一步。

### 推荐做法：桌面快捷方式 + 浏览器记住密码

1. 平板连上 `ChinaTelecom-EDU`。
2. 用华为浏览器访问 `http://www.msftconnecttest.com/redirect`
   —— 未认证时会被网关劫持，自动跳到认证页。这个地址比门户 IP 稳定，适合做书签。
3. 输入账号 `你的账号` / 密码 `你的密码`，选择让浏览器**记住密码**。
4. 认证成功后，浏览器菜单里选「**添加到桌面**」，命名"校园网认证"。
5. 以后点这个图标 → 认证页 → 账号密码已自动填好 → 点"立即登录"。共 2 次点击。

### 真正的零点击方案：无感知认证

这个门户**支持**无感知认证（代码里的 `swicthNosense()`，文案是"无需再次登录的终端"），
原理是把设备 MAC 绑定后由网关自动放行，平板和笔记本都不用再登录。

但我实测了你的账号：**认证成功页上没有出现这个开关**。根因是门户服务器返回的终端 MAC 是空的
（`terminalInfo.nodeMac = ""`），而前端代码恰好要求 MAC 非空才显示该开关。
另外自助服务台 `http://110.184.24.61/self/index` 会跳 `/login` 并无限重定向，校外进不去。

所以这条路目前走不通，**建议直接找电信/学校网络中心开通"无感知认证"**（也常叫"免认证""MAC 绑定"）。
开通后笔记本这边的脚本其实也就不需要了。

> 顺带一提：如果你说的其实是**旧版鸿蒙（4.x 及以下）**而不是 NEXT，那它能装 APK，
> 就能做一个真正的"一键连网"App——那种情况下告诉我，我可以出方案。

---

- **凭据是明文存在 `config.json` 里的。** 这是免交互自动登录的必然代价；这台机器只有你自己用的话问题不大。
  介意的话可以改用 Windows 凭据管理器，但会复杂不少。
- **本机 WLAN 开启了「随机硬件地址」（MAC Randomization）。** Windows 会为同一个 SSID 保持同一个随机 MAC，
  所以跨重启是稳定的，脚本每次也都会读取实时 MAC，不受影响。
- **计划任务每 5 分钟会唤醒一次。** 已联网时只是一次 HTTP 探测就退出，对性能几乎没有影响；
  如果不想有这个兜底，可以在 `install.ps1` 里删掉第 3 个触发器后重装。
- 本方案只做认证，不修改任何系统网络设置，卸载后不留残留（`logs`、`state.json` 可随时删）。
