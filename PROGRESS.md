# PROGRESS.md — 维护进度与变更日志

面向代理的进度板：**每次改动后在最上面的「变更记录」追加一行，并更新「当前状态」**。操作规范见 [AGENTS.md](./AGENTS.md)，用户文档见 [README.md](./README.md)。

## 当前状态

| 项目 | 值 |
| --- | --- |
| 三端版本 | `2026.11.06-r1`（Clash Verge Rev / Bettbox / FlClash） |
| 策略组 | 17 固定 + 每个有节点的地区 2 组（19–35；9 地区全有 = 26 可见 + 9 隐藏） |
| 分流规则 | 45 / 47 / 47（CVR / Bettbox / FlClash） |
| Rule Providers | 40（37 上游 `.mrs` @meta + 3 自维护 `domain/text`） |
| 回归测试 | Node 179/179（既有 74 + 审计回归 105）；QuickJS 148 用例；Mihomo v1.19.33 完整配置及隔离成员 86 用例 |
| 最近 CI | success — `Validate scripts`，run 41624420766，head `8a8587e`（`2026.11.03-r1`；Node 179/179 + QuickJS 148 + Mihomo 86） |
| 结构图 | `assets/proxy-groups.png` 已重绘：26 组顺序（含 `流媒体` / `WhatsApp`），仍对应 9 个地区全有的情形 |

## 变更记录（新 → 旧）

| 日期 | 提交 | 类型 | 内容 | 验证 |
| --- | --- | --- | --- | --- |
| 2026-11-06 | 待填 | feat | 「Netflix」扩为「流媒体」：新增 `disney` / `primevideo` / `hbo` / `spotify` / `tiktok` 五个 `.mrs` 规则集与对应规则，Netflix IP 规则改指 `流媒体`；新增 `WhatsApp` 组与 `whatsapp.mrs` 规则；Bettbox 开关扩到 14 个；版本升 `2026.11.06-r1`；测试断言与 README/AGENTS 全部同步，结构图重绘 | 待云端 CI |
| 2026-11-03 | `70b1da7` | fix | 七项审计修复同步三端 `2026.11.03-r1`：引用保留/有效成员判环分离，纯组环独立切断；统一 AdapterType/保守三值正则；provider 原名/原 YAML 类型过滤再改名；只裁剪确定完整的 inline，HTTP/file fallback 与未知语义保留全部地区；非法 use 规范化、空组 REJECT。先补共享审计复现及 Node 行为断言，再改生产 JS；扩展 QuickJS，新增固定 Mihomo 完整配置 + 隔离运行态 CI 门禁；文档同步，结构图不需改 | 独立静态复核通过；云端 CI success，run 41624420766（head `8a8587e`）：语法三端通过、Node 179/179、QuickJS 148、Mihomo v1.19.33 `-t` + 隔离运行态 86/86；按用户要求未运行本地测试/构建/内核 |
| 2026-10-31 | `6cb6fce` | fix | 欧洲与「其他地区」增加国家二级分组：`countryKey` 取节点名开头的国旗（代理对比较，不依赖 `u` 标志），桶内同国家相邻、国家内部保持订阅原顺序；其余七个大区不再拆分；版本升 `2026.10.31-r2` | `node --check` ×3、`node --test` 74/74（新增 `Europe and 其他地区 keep the same country together`）、mihomo v1.19.33 `-t` ×4 全 `test is successful`、真实订阅（76 节点）复算：同国家被拆从 9 个降到 0 个 |
| 2026-10-31 | `a3b0fb0` | fix | 地区归属改为只看节点名第一个 `｜` / `|` 之前的部分：`🇯🇵日本01｜HK｜三网优化` 归日本聚合（原先被中转地抢进香港聚合），未收录国旗 `🇧🇷` / `🇹🇷` 归「其他地区」；`REGION_PATTERN_BODY` 的字母边界不再把分隔符当边界；`全球手动` 同地区内改回订阅原顺序（`.map(...).sort(rank, index)`，删除 `naturalCompare`）；版本升 `2026.10.31-r1` | `node --check` ×3、`node --test` 71/71（新增 relay 标签 / 订阅顺序两项断言）、mihomo v1.19.33 `-t` ×3 全 `test is successful`、运行态 `/proxies` 核对：香港聚合 5（无外区）、日本聚合含 `日本01｜HK`、其他地区含 `巴西01｜HK`、`全球手动` 18 节点按地区分桶且同地区保持订阅顺序 |
| 2026-10-30 | `533ceea` | feat | 基础组 `国外流量` 改 `default-selected: 全球手动`（`foreignSelect` 工厂，仍无 `DIRECT`），首次加载默认选中「全球手动」；`漏网之鱼` 首选出口不变；版本升 `2026.10.30-r2` | `node --check` ×3、`node --test` 65/65、三端默认项打印（`国外流量=全球手动`）、mihomo v1.19.33 `-t` ×3 全 `test is successful` |
| 2026-10-30 | `992d816` | feat | 地区策略组按订阅实际节点动态出现：`REGION_AVAILABILITY` 复用地区正则判定节点名，没有节点的地区不再建聚合组与隐藏自动组，AI / 服务组 / `国外流量` 的选项同步收缩；远端 `proxy-providers` 无法枚举时退回全部 9 组；`preserveDependencies` 把旧组对已跳过地区组的引用改指 `国外流量`；版本升 `2026.10.30-r1` | `node --check` ×3、`node --test` 65/65、真实订阅（2 节点单地区 → 18 组 / 59 节点 → 34 组）复算、mihomo v1.19.33 `-t` ×12（合成 + 3 份真实订阅 ×3 端）全 `test is successful`、运行态 `/proxies` 核对地区组成员 |
| 2026-10-29 | `8502eee` | feat | ChatGPT / Claude / Gemini / NotebookLM 三个 AI 组改 `default-selected: 全球手动`（仍无 `DIRECT`）；`rules/direct.list` 补 Wise 域名 `wise.com` / `transferwise.com` / `wise.us` / `wise.jobs` / `wi.se`，业务与 DNS 直连；版本升 `2026.10.29-r1` | `node --check` ×3、`node --test` 62/62、三端默认项打印、mihomo v1.19.33 `-t` ×3、CI success（run 40851422547，Node 62/62 + QuickJS 44） |
| 2026-10-26 | `8700253` | fix | 复核国内识别：`cn.mrs` 11.0 万条（含 `+.cn`），抽查 356 个国内域名仅 `cnbeta.com` 被 `!cn` 误判；`rules/direct.list` 补 `cnbeta.com` / `cnbetacdn.com` 与 11 个国内统计、广告、推送后端；版本升 `2026.10.26-r3` | `node --test` 62/62、`mihomo convert-ruleset` 语法回读、mihomo `-t` ×3 |
| 2026-10-26 | `8719a0f` | fix | Clash Verge Rev 的 `direct-nameserver-follow-policy` 改为 `true`：直连拨号解析也遵守 `nameserver-policy`（LAN → `system`，AI / 补丁域名跟随各自组），内网主机名不再发往公共 DNS；未命中 policy 的域名仍回落 `direct-nameserver`（国内 DoH）；版本升 `2026.10.26-r2` | `node --check` ×3、`node --test` 62/62、mihomo v1.19.33 `-t` ×3 |
| 2026-10-26 | `881bdf6` | fix | 三端补字段类型防御：`listeners` / `tunnels` / `inline payload` 非数组时用 `asArray` 兜底，不再因 `for...of` 抛错导致整份覆写被丢弃；欧洲补奥地利/比利时/捷克/丹麦/葡萄牙/希腊/冰岛/卢森堡 8 个中文国名与 7 个城市名；Bettbox 只对仍存在的脚本组名做节点改名；`profile` 非对象不再展开；统一 `RULESET_SIZE_LIMIT`；版本升 `2026.10.26-r1` | `node --check` ×3、`node --test` 62/62、mihomo v1.19.33 `-t` ×3 |
| 2026-10-25 | — | docs | 删除误建的 `AGENT.md`，维护说明统一为 `AGENTS.md` | `git grep AGENT.md` 无残留引用 |
| 2026-10-25 | — | docs | 新增 `AGENTS.md`（维护规范）与 `PROGRESS.md`（本文件）；README 仓库目录表补两行 | 链接目标存在性检查、`node --test` 53/53 |
| 2026-10-25 | `cf41ffe` | feat | Google / GitHub / X / YouTube / Netflix / Telegram 六组改 `default-selected: 全球手动`；`Microsoft` / `Apple` / `游戏平台` 保持 `DIRECT`；版本升 `2026.10.25-r1`；README 同步 7 处 | `node --check` ×3、`node --test` 53/53、三端默认项打印、CI success |
| 2026-10-25 | `20090fb` | docs | README「结构总览」由 Mermaid 改为 `assets/proxy-groups.png`；仓库目录表补 `assets/` | 远端 `img` 加载校验（2337×3304）、CI success |
| 2026-10-25 | `667e4a1` | docs | Mermaid 结构图改为与主界面一致的纵向单列顺序（25 组 + 隐藏组） | Mermaid 10/11 渲染、节点顺序程序化比对、CI success |
| 2026-10-25 | `e5da5f4` | docs | 新增「结构总览」Mermaid 交互图（后续被图片替代） | 本地渲染 + GitHub iframe 校验 |
| 2026-10-25 | `f58480e` | docs | 版本表与「最近维护」对齐脚本实际版本（`2026.10.22-r2`） | 全仓版本号一致性检查、CI success |

### 更早的里程碑（来源：`git log`，未在本文件逐条复验）

| 日期 | 提交 | 内容 |
| --- | --- | --- |
| 2026-10-22 | `03a4fcf` | 国际服务例外改由 `SKULL_CustomProxy` 前置接管；补丁 URL 迁到 `skullvek/Mihomo-RouteKit` |
| 2026-10-22 | `59720b1` | WorkBuddy 国际站经代理补丁分流 |
| 2026-10-18 | `a6da139` / `17c6095` | 新增 FlClash 扩展脚本与导入说明 |
| 2026-10-15 | `9c37e02` | 伪节点过滤排除客服邮箱与 TG 群组公告 |
| 2026-10-04 | `d7e93f6` | Bettbox 系统 NTP 直连（域名 + UDP/123） |
| 2026-10-02 | `f0c0418` / `02af2f9` | 引入 `rules/` 自维护补丁、地区识别增强、Node/QuickJS 回归与 CI |

## 待办 / 已知限制

- [ ] **结构图需人工维护**：`assets/proxy-groups.png` 是位图，组顺序、默认值或组数变化时必须重画；当前图对应「9 个地区全有节点」的 26 组情形，单地区机场实际组数更少。
- [ ] **本次修复云端验收**：Node 原 74 项 + 审计回归、QuickJS 对拍、固定 Mihomo v1.19.33 完整配置 `-t` 与隔离运行态成员/dialer 门禁均已编写，尚未执行。
- [ ] **QuickJS 对照只能靠 CI**：Hermes venv 无 pip，本地跑不了 `tests/quickjs_check.py`；汇报时以 CI 结果为准。
- [ ] **`RULESET_REF = "meta"` 是可变的**：上游 `meta-rules-dat` 改动会在下一个 `interval`（86400s）静默生效；需要确定性时改固定 tag/SHA，改完必须清一次规则集缓存。
- [ ] **设备端验证缺口**：真实节点连通性、TUN 严格路由、DNS 泄露、客户端最终覆写行为无法在 CI 覆盖，只能按 README「注意事项」在设备上复核。
- [ ] **隐藏地区自动组不在结构图中**：README 正文有单独小节，图里只保留可见组。
- [ ] **Bettbox / FlClash DNS 覆写开关**：用户开启客户端 DNS 覆写会覆盖脚本策略，属已知行为，只能在文档中提示。
- [ ] **`@meta` 上游规则集体积**：已加 `size-limit: 16 MiB` 兜底，触发即视为上游异常。

## 发布前检查清单

1. 云端 CI 的三份脚本 `node --check` 通过（本轮不本地执行）。
2. CI 中 `node --test tests/validate.js tests/repair.test.js`、QuickJS 与 `tests/mihomo-ci.js` 全绿；行为变更已加审计断言，未验证前标待验。
3. 三端默认项打印与预期一致（`default-selected`）。
4. 版本号是否需要 bump（行为变更 bump，纯文档不动）。
5. README 七处同步点已更新；结构图与脚本不矛盾。
6. 本文件「当前状态」与「变更记录」已更新。
7. 由父任务提交/推送 `main` 后确认 `git ls-remote origin main` 与本地 `HEAD` 一致，CI 通过。
