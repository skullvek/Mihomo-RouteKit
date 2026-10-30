# AGENTS.md — 维护说明（面向 AI 代理）

本文件是给在本仓库里动手的代理 / 自动化看的操作手册。人类用户看 [README.md](./README.md)；**先读完本文件再改代码**，改完按第 6、7 节验证与提交。

- 仓库：`skullvek/Mihomo-RouteKit`
- 内容：三份 Mihomo 覆写脚本 + 自维护规则补丁 + 回归测试 + 文档
- 定位：**只提供覆写脚本，不提供节点、订阅或任何网络接入服务**

## 1. 一句话架构

脚本保留订阅里的 `proxies` / `proxy-providers`，**重建**主策略组、分流规则、Rule Providers 和整段 DNS。因此换机场通常不用改脚本。

每次执行产出：**16 个固定主策略组 + 每个「订阅里真的有节点」的地区 2 组**（可见聚合组 + 隐藏 `url-test`；9 个地区全有时共 34 组，单地区机场 18 组）、**34 个 `SKULL_*` Rule Provider**（31 个上游 `.mrs` 经 jsDelivr `@meta` + 3 个自维护 `domain/text` 经 Raw）、**39 / 41 / 41 条规则**、完整 `dns` 段。

## 2. 目录地图

| 路径 | 作用 | 关键点 |
| --- | --- | --- |
| `Clash-Verge-Rev-mihomoScript.js` | 桌面端入口 `main(config, profileName)` | 会写 `tun` 缺省项、`mode`、`find-process-mode: strict` |
| `Bettbox-mihomoScript.js` | Android 入口 `main(config)` | 顶层声明 `ruleOptionsEnable`（13 个开关）与 `serviceConfigs`（图标）；不写 `tun` |
| `FlClash-mihomoScript.js` | 多平台入口 `main(config)` | QuickJS 安全：**不用 `Object.fromEntries`、`Intl`**；客户端字段一律不写 |
| `rules/direct.list` | `SKULL_CustomDirect`，先于 CN 分类直连 | 只写域名，一行一个 |
| `rules/proxy.list` | `SKULL_CustomProxy`，先于 CN 分类走 `国外流量` | 同上 |
| `rules/fake-ip-filter.list` | `SKULL_FakeIPFilter`，仅排除 Fake-IP | 不改变直连/代理去向 |
| `tests/validate.js` | `node --test` 回归（65 项） | 契约、开关组合、地区裁剪、三端一致性、规则文件格式 |
| `tests/fixtures/*.json` | 5 份合成订阅 | 全部假数据，**不得写入真实订阅** |
| `tests/engine-cases.js` + `tests/quickjs_check.py` | Node ↔ 真实 QuickJS 对照 | 只在 CI 跑（本地通常没有 `quickjs`） |
| `.github/workflows/validate.yml` | push / PR / 手动触发 | 语法 → 测试 → QuickJS |
| `assets/proxy-groups.png` | README「结构总览」用的结构图 | 组顺序或默认值变了必须重画，**图不能与脚本矛盾** |
| `README.md` | 用户文档 | 见第 5 节的同步点清单 |
| `PROGRESS.md` | 维护进度与变更日志 | 每次改动追加一行 |

## 3. 不可破坏的契约

1. **三端一致**：共同逻辑必须同时改三份脚本；允许的差异只有客户端权威字段（见 3.4）。
2. **绝不抛错**：任何异常必须就地降级 + `[SKULL]` 告警。Clash Verge Rev 在脚本抛错时会**丢弃整份覆写**并回退原配置，用户会看到「脚本不生效」。降级目标用 `REJECT` 而不是 `DIRECT`，避免未知流量意外直连。
3. **`console.error` 只传一个参数**（CVR 注入的 console 会静默丢弃多余参数），先拼好字符串再打印。
4. **默认值与选项集合**：

   | 组 | 类型 | 选项 | 默认 |
   | --- | --- | --- | --- |
   | `全球手动` / `自动选择` / `国外流量` | `select` / `url-test` / `select` | 无 `DIRECT` | 首位 / 全节点测速 / 首位 |
   | `漏网之鱼` | `select` | `国外流量`→`自动选择`→`全球手动`→`DIRECT` | `国外流量` |
   | AI 三组 | `select` | 自动选择 / 全球手动 / 订阅实际地区的聚合组 | **`default-selected: 全球手动`**，无 `DIRECT` |
   | Google / GitHub / X / YouTube / Netflix / Telegram | `select` | 上述 + `DIRECT` | **`default-selected: 全球手动`** |
   | Microsoft / Apple / 游戏平台 | `select` | 同上 | **`default-selected: DIRECT`** |
   | 地区聚合 1–9 | `select` | 该地区隐藏自动组 + 该地区全部节点；**订阅里没有该地区节点时不建组** | 首位 |
   | 地区自动 1–9 | `url-test` | `hidden: true`，只供聚合组调用；与聚合组一一对应 | — |

   `default-selected` 是字符串成员名；`select` 组没有它就从选项第一项开始。改动默认值时必须在 `tests/validate.js` 的 `core design contracts` 里加断言。
5. **规则顺序固定**（命中即停）：
   LAN → NotebookLM/Gemini 精确域名 → OpenAI/Claude/Gemini →（Bettbox/FlClash）`pool.ntp.org` 与 UDP/123 → `SKULL_CustomDirect` → `SKULL_CustomProxy` → `apple@cn` / `microsoft@cn` / 国内游戏与下载 CDN → 7 个游戏平台 → 8 个服务组 → `cn` → `geolocation-!cn` → 5 条 IP（`no-resolve`）→ China IP → `MATCH,漏网之鱼`。
   改顺序前先想清楚谁会被提前接管（典型事故：AI 被 Google 抢走、Xbox 被 Microsoft 抢走、国内游戏走代理）。
6. **DNS 结构**：fake-ip `198.18.0.1/16` + `blacklist`（只继承订阅中同为 blacklist 的 filter）；国内域名/自定义直连走国内 DoH `#DIRECT`；默认与境外走 Cloudflare/Google DoH `#国外流量`；AI 域名 `nameserver-policy` 跟随各自 AI 组；`direct-nameserver` 与 `proxy-server-nameserver` 用国内 DoH（后者防 `nameserver → 国外流量 → 节点域名` 循环）。三端 `direct-nameserver-follow-policy: true`：直连拨号解析也遵守 `nameserver-policy`（LAN → `system`，AI/补丁域名跟随各自组），未命中 policy 的域名回落 `direct-nameserver`，内网主机名不外发。
7. **`rules/*.list` 只写域名**：`+.example.com` 匹配主域与全部子域，裸域名精确匹配。不写 `DOMAIN-SUFFIX,`、策略名或 `payload:`。CI 会校验格式、重复行、直连/代理冲突，并拒绝把共享父域整体代理（如 `mchost.guru`、`aliyuncs.com`）。
8. **不得提交**真实订阅 URL、节点密码、UUID、Token、Cookie；测试数据一律用 `*.example` 假域名。

### 3.4 三端允许的差异

| 项 | Clash Verge Rev | Bettbox | FlClash |
| --- | --- | --- | --- |
| `tun` | 只补缺失项，不强制开启 | 不写 | 不写 |
| `mode` / `unified-delay` | 写入，但客户端会回写覆盖 | 写入，客户端回写覆盖 | 不写 |
| 顶层 `ipv6` | 不强制 | 写 `false`，App 覆盖 | 不写 |
| `find-process-mode` | `strict` | `off` | 不写 |
| `profile.store-selected` | `true` | `true` | 不写（FlClash 自管） |

## 4. 改一个功能要动哪些文件

- **域名判错（该直连却走了代理 / 反之）** → `rules/direct.list` 或 `rules/proxy.list`，**不要**改脚本。
- **某服务需要真实 IP** → `rules/fake-ip-filter.list`（只影响 Fake-IP，不改去向）。
- **策略组结构、默认值、节点识别、DNS、TUN** → 三份脚本 + `tests/validate.js` + README + 结构图。
- **新增服务组**：三份脚本同时加组与规则（注意规则位置）、`Bettbox` 的 `ruleOptionsEnable` / `serviceConfigs`、测试断言、README 的组顺序表与结构图。
- **Bettbox 开关**：`featureEnabled` / `serviceTarget` 负责删组并把相关规则回落 `国外流量`；`地区分组` 开关会删掉全部聚合组与对应的隐藏自动组。
- **地区组按订阅动态出现**：`REGION_AVAILABILITY`（2.1 节，复用 `FILTER` / `REGION_EXCLUDE` 判定节点名）→ `REGION_DEFS` / `ACTIVE_REGIONS`（4 节）→ 组列表用 `...ACTIVE_REGIONS.map(...)` 展开；`preserveDependencies` 里的 `missingRegionNames` 负责把旧组对已跳过地区组的引用改指 `国外流量`。改判定逻辑要同步三份脚本，并在 `tests/validate.js` 的 `region groups follow the subscription` 里补断言。

## 5. README 同步点

行为变更通常要同步这几处，漏一处就会出现文档与代码矛盾：

1. 核心特性表
2. 默认分流逻辑表
3. 「结构总览」图与图下说明
4. 常用国际服务 / 游戏平台 / 基础组 / AI 组小节
5. 快速开始的三行版本表
6. 版本说明句（「三版脚本顶部版本标识当前统一为 …」）
7. 最近维护表
8. 必要时 `assets/proxy-groups.png` 重新出图（顺序、默认值、组数变化时）

## 6. 验证

```bash
node --check Clash-Verge-Rev-mihomoScript.js
node --check Bettbox-mihomoScript.js
node --check FlClash-mihomoScript.js
node --test tests/validate.js

# 打印每个 fixture 实际建出的地区组，确认裁剪逻辑
node -e 'const {execute,SCRIPTS,fixture}=require("./tests/helpers");for(const f of SCRIPTS){for(const n of ["direct-proxies","provider-only","mixed-provider"]){const c=execute(f,fixture(n));console.log(f,n,c["proxy-groups"].length,c["proxy-groups"].map(g=>g.name).filter(x=>/聚合$|^其他地区$/.test(x)).join(","));}}'

# 打印三端实际生效的默认项，别只看代码
node -e 'const {execute,SCRIPTS}=require("./tests/helpers");for(const f of SCRIPTS){const c=execute(f,require("./tests/fixtures/direct-proxies.json"));console.log(f,c["proxy-groups"].filter(g=>g["default-selected"]).map(g=>g.name+"="+g["default-selected"]).join(", "));}'
```

- QuickJS 对照需要 `python -m pip install quickjs`；Hermes 自带 venv 通常装不了，**交给 CI**（`gh run list -R skullvek/Mihomo-RouteKit -L 3`），并在汇报里说明「CI 通过」而不是「本地通过」。
- CI 不访问远端规则 URL，也不连真实节点：远端可达性、客户端最终覆写行为、TUN/DNS 泄露只能上设备验证。

## 7. 版本号与提交

- 版本标识在三份脚本顶部：`// Version: YYYY.MM.DD-rN`。
- **行为变更**（规则、默认值、DNS、组结构）→ 三端统一 bump 版本，并更新 README 的三行版本表与版本说明句。
- **纯文档 / 纯测试** → 不动版本号。
- 提交信息用 `feat:` / `fix:` / `docs:` / `test:` 前缀，一句话说清改了什么。
- 直接推 `main`，不走 PR；推完报告 commit id、`git ls-remote origin main` 与 CI 结果。
- 避免改写已推送的历史；确实需要时用 `--force-with-lease`，并在汇报里明确说明。

## 8. 已知坑

- **CRLF 仓库**：`.gitattributes` 里是 `*.md text`。多行 `patch` 的 `old_string` 容易因 CRLF 失配——按单行锚点改，或用 Python 在字节层替换，改完断言「无孤立 LF」。
- **README 整篇 diff**：若某次提交把 README 存成 CRLF 二进制（`git ls-files --eol` 显示 `i/-text`），diff 会变成 900+ 行噪声。修法是 `.gitattributes` 标 `*.md text` 后重新 add；必要时 amend 并用 `--force-with-lease`。
- **`direction LR/TB` 写在 subgraph 里会被忽略**（父图为 `LR` 时），表现为加不加 `direction` 的 `viewBox` 完全一致——要变布局就拆子图，别跟渲染器较劲。
- **Mermaid 10 与 11 的布局宽度不同**：GitHub 用 10.x，本地验证要以 10.9.1 为准；宽度尽量压在 950px 以内，否则被缩成小字。
- **GitHub 的 Mermaid 在跨域 iframe 里渲染**：页面 DOM 查不到图内 `<svg>` 是正常的，判断标准是 `iframe[src*="markdown/mermaid"]` 的数量。
- **客户端会在脚本之后回写自己的设置**：`mode`、`unified-delay`、顶层 `ipv6`、`find-process-mode`、TUN 全部以 App 为准，脚本里写了也可能被覆盖——不要承诺「脚本已强制」。
- **别写死 34 组**：地区组数量由订阅节点决定——`direct-proxies.json` 只有香港 / 美国 → 20 组，`provider-only.json` 只有 NRT → 18 组，`mixed-provider.json` 是新加坡 + 台湾 → 20 组。断言组数前先看 fixture 里到底有哪些地区；只有「无法枚举的远端 provider」才会退回 9 个地区全保留。
- **Bettbox / FlClash 的 DNS 覆写**：客户端一旦开启 DNS 覆写，脚本的 `nameserver-policy`、`direct-nameserver` 会被重新生成覆盖，README 已要求用户关闭，排查问题时先问这一项。

## 9. 不要做的事

- 不要为了让测试通过去改测试断言（除非契约本身被有意修改，并在提交信息里说明）。
- 不要无条件保留机场原策略组；只有 `preserveDependencies()` 判定被引用的才保留，并隐藏。
- 不要在 AI 组、`国外流量` 里加 `DIRECT`，也不要让 AI 组引用可切到 `DIRECT` 的上级组。
- 不要整体代理共享父域（`mchost.guru`、`aliyuncs.com`、`tencentcloudapi.com` 等）。
- 不要在 README 里贴真实订阅、节点名、截图中的凭据。
