// FlClash 扩展脚本（Android / Windows / macOS / Linux）
// Version: 2026.10.31-r1
// 目标：国内直连、国外代理；AI 强制代理；常用国际服务独立；地区聚合（自动测速 + 手动节点，按订阅实际地区动态出现）。
// 用法：新建脚本并粘贴全文；当前订阅 -> 扩展/覆写 -> 脚本，选中本脚本。
// 在客户端使用规则模式，关闭 DNS 覆写及“追加系统 DNS”；TUN/VPN 由 FlClash 管理。

function main(config) {
  // FlClash 以 JSON 对象调用 main；不依赖 Node、浏览器或客户端私有全局变量。
  config = config || {};
  const oldGroups = Array.isArray(config["proxy-groups"])
    ? config["proxy-groups"]
    : [];

  // ---------- 0. 基础检查：保留机场 proxies / proxy-providers ----------
  const directProxyCount = Array.isArray(config.proxies) ? config.proxies.length : 0;
  const providers = config["proxy-providers"];
  const providerNames = providers && typeof providers === "object"
    ? Object.keys(providers)
    : [];
  const providerCount = providerNames.length;

  if (directProxyCount === 0 && providerCount === 0) {
    return config;
  }

  const TEST_URL = "https://www.gstatic.com/generate_204";
  const INTERVAL = 600;
  const RULE_INTERVAL = 86400;
  const BYPASS_TYPES = ["direct", "pass", "compatible"];
  const GROUP_EXCLUDE_TYPES = "Direct|Pass|Compatible";
  const isProxyCandidate = (proxy) =>
    proxy && !BYPASS_TYPES.includes(String(proxy.type || "").toLowerCase());

  // 订阅字段类型防御：listeners / tunnels / inline payload 正常是数组，畸形订阅可能写成对象。
  // 直接 for...of 会抛错，异常逃出 main() 后整份覆写会被客户端丢弃（CVR 回退原配置）。
  const asArray = (value) => (Array.isArray(value) ? value : []);

  // ---------- 诊断收集 ----------
  // FlClash 会报告脚本异常；可修复的依赖问题就地降级并写入日志，避免整套覆写中断。
  const issues = [];
  const report = (message) => {
    issues.push(message);
    console.error(`[SKULL] ${message}`);
  };

  // 提示性日志：只打到 console，不计入 issues（issues 只统计被降级处理的异常）。
  const note = (message) => {
    console.error(`[SKULL] ${message}`);
  };

  // provider 节点的 url-test 依赖 provider 自身 health-check 数据。
  // 仅补齐缺失项，尊重机场显式 enable=false，不覆盖已有的 url / interval / timeout 等配置。
  const ensureProviderHealthCheck = (provider) => {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
      return;
    }

    const current =
      provider["health-check"] &&
      typeof provider["health-check"] === "object" &&
      !Array.isArray(provider["health-check"])
        ? provider["health-check"]
        : {};

    // 内核只有 health-check.enable 为 true 时才注册周期测速（见 provider/parse.go）。
    // 机场显式写 false 通常是为了省流量，脚本不再强制打开，只补缺失项。
    const enable =
      typeof current.enable === "boolean" ? current.enable : true;

    provider["health-check"] = {
      ...current,
      enable,
      url: current.url || TEST_URL,
      interval:
        typeof current.interval === "number" && current.interval > 0
          ? current.interval
          : INTERVAL,
      lazy:
        typeof current.lazy === "boolean"
          ? current.lazy
          : true
    };

    if (!enable) {
      report(
        `provider 显式关闭了健康检查（health-check.enable=false），已保留原设置；` +
          `若该 provider 的节点在自动测速组中始终无延迟数据，请检查此项`
      );
    }

    // 仅默认 generate_204 配套补 204；自定义 URL 保持原有状态码语义。
    if (current["expected-status"] == null) {
      delete provider["health-check"]["expected-status"];
      if (provider["health-check"].url === TEST_URL) {
        provider["health-check"]["expected-status"] = 204;
      }
    }
  };

  for (let i = 0; i < providerNames.length; i += 1) {
    ensureProviderHealthCheck(providers[providerNames[i]]);
  }

  // 仅排除明确的信息/提醒节点，避免误伤“香港01｜不限流量”等正常节点。
  const PSEUDO_PATTERN_BODY =
    "到期|过期|剩余(?:流量|时间|天数|[:：]|\\s*\\d)|流量(?:剩余|到期|重置|[:：]\\s*\\d)|套餐(?:到期|剩余|[:：])|官网(?:地址)?|网址|订阅(?:到期|更新|地址)|(?:更新|刷新)\\s*订阅|(?:下次|距离).*重置|公告(?:[:：]|$)|通知(?:[:：]|$)|提示(?:[:：]|$)|教程(?:[:：]|$)|使用说明|使用须知|客服(?:邮箱|邮件|电邮)?\\s*(?:[:：]|$)|(?:^|[^A-Za-z])(?:TG|Telegram)\\s*(?:交流[群组]|群组|群|频道)\\s*(?:[:：|｜@]|$)|联系(?:客服)?|有超时|超时.*重启|请.*重启网络|重启.*网络|Expire(?:d)?(?:\\s*[:：]|\\s*\\d|$)|Traffic(?:\\s*(?:Left|Remaining)|[:：]\\s*\\d)|Remaining(?:\\s*Traffic)?|Website(?:\\s*[:：]|$)|(?:^|[^A-Za-z])(?:USED|TOTAL)(?:\\s*[:：]\\s*\\d)|(?:^|[^A-Za-z])(?:EMAIL|Panel|Channel|Author)\\s*[:：]|工单\\s*[:：]";

  const EXCLUDE = `(?i)(${PSEUDO_PATTERN_BODY})`;

  // ---------- 1. 图标 ----------
  const ICON = {
    foreign: "https://fastly.jsdelivr.net/gh/0xWans/Qure@master/IconSet/Color/Global.png",
    manual: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Proxy.png",
    auto: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Auto.png",
    final: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Final.png",

    chatgpt: "https://fastly.jsdelivr.net/gh/lobehub/lobe-icons@master/packages/static-png/light/openai.png",
    claude: "https://fastly.jsdelivr.net/gh/lobehub/lobe-icons@master/packages/static-png/light/claude-color.png",
    gemini: "https://fastly.jsdelivr.net/gh/lobehub/lobe-icons@master/packages/static-png/light/gemini-color.png",

    google: "https://fastly.jsdelivr.net/gh/0xWans/Qure@master/IconSet/Color/Google_Search.png",
    github: "https://fastly.jsdelivr.net/gh/0xWans/Qure@master/IconSet/Color/GitHub.png",
    microsoft: "https://fastly.jsdelivr.net/gh/0xWans/Qure@master/IconSet/Color/Microsoft.png",
    apple: "https://fastly.jsdelivr.net/gh/0xWans/Qure@master/IconSet/Color/Apple.png",
    telegram: "https://fastly.jsdelivr.net/gh/0xWans/Qure@master/IconSet/Color/Telegram.png",
    x: "https://fastly.jsdelivr.net/gh/0xWans/Qure@master/IconSet/Color/Twitter(X).png",
    youtube: "https://fastly.jsdelivr.net/gh/0xWans/Qure@master/IconSet/Color/YouTube.png",
    netflix: "https://fastly.jsdelivr.net/gh/0xWans/Qure@master/IconSet/Color/Netflix.png",
    games: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Game.png",

    hk: "https://flagcdn.com/w160/hk.png",
    mo: "https://flagcdn.com/w160/mo.png",
    tw: "https://flagcdn.com/w160/tw.png",
    sg: "https://flagcdn.com/w160/sg.png",
    kr: "https://flagcdn.com/w160/kr.png",
    jp: "https://flagcdn.com/w160/jp.png",
    us: "https://flagcdn.com/w160/us.png",
    eu: "https://flagcdn.com/w160/eu.png",
    other: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/World_Map.png"
  };

  // ---------- 2. 节点地区筛选 ----------
  const REGION_PATTERN_BODY = {
    hk: "🇭🇰|香港|Hong ?Kong|(?:^|[^A-Za-z｜|])HK(?:G)?(?:[0-9]|[^A-Za-z]|$)",
    mo: "🇲🇴|澳门|澳門|Macao|Macau|(?:^|[^A-Za-z｜|])MO(?:[0-9]|[^A-Za-z]|$)",
    tw: "🇹🇼|台湾|台灣|Taiwan|Taipei|(?:^|[^A-Za-z｜|])(?:TW(?:N)?|TPE|TSA|KHH)(?:[0-9]|[^A-Za-z]|$)",
    sg: "🇸🇬|新加坡|狮城|獅城|Singapore|(?:^|[^A-Za-z｜|])(?:SG(?:P)?|SIN|XSP)(?:[0-9]|[^A-Za-z]|$)",
    kr: "🇰🇷|韩国|韓國|Korea|Seoul|(?:^|[^A-Za-z｜|])(?:KR|KOR|ICN|GMP)(?:[0-9]|[^A-Za-z]|$)",
    jp: "🇯🇵|日本|东京|東京|大阪|Japan|Tokyo|Osaka|(?:^|[^A-Za-z｜|])(?:JP(?:N)?|NRT|HND|KIX|CTS|FUK)(?:[0-9]|[^A-Za-z]|$)",
    us: "🇺🇸|美国|美國|美[.·|｜_\\s-]|United ?States|America|Los ?Angeles|洛杉矶|洛杉磯|San ?Jose|圣何塞|聖何塞|Seattle|西雅图|西雅圖|New ?York|纽约|紐約|Phoenix|凤凰城|鳳凰城|Salt ?Lake(?: ?City)?|盐湖城|鹽湖城|San ?Francisco|旧金山|舊金山|Dallas|达拉斯|達拉斯|Chicago|芝加哥|Las ?Vegas|拉斯维加斯|拉斯維加斯|Ashburn|阿什本|Boston|波士顿|波士頓|Miami|迈阿密|邁阿密|Denver|丹佛|Houston|休斯顿|休士頓|Austin|奥斯汀|奧斯汀|Washington ?D\\.?C\\.?|华盛顿(?:特区)?|華盛頓(?:特區)?|(?:^|[^A-Za-z｜|])(?:LAX|SJC|SEA|NYC|PHX|SLC|SFO|DFW|ORD|LAS|IAD|BOS|MIA|DEN|IAH|HOU|DCA|US|USA)(?:[0-9]|[^A-Za-z]|$)",
    eu: "🇪🇺|🇬🇧|🇩🇪|🇫🇷|🇳🇱|🇪🇸|🇮🇹|🇨🇭|🇸🇪|🇫🇮|🇳🇴|🇵🇱|🇮🇪|🇦🇹|🇧🇪|🇨🇿|🇩🇰|🇵🇹|🇬🇷|🇮🇸|🇱🇺|欧洲|歐洲|Europe|European|英国|英國|法国|法國|德国|德國|荷兰|荷蘭|西班牙|意大利|瑞士|瑞典|芬兰|挪威|Norway|波兰|爱尔兰|奥地利|比利时|捷克|丹麦|葡萄牙|希腊|冰岛|卢森堡|维也纳|布鲁塞尔|布拉格|哥本哈根|里斯本|雅典|雷克雅未克|London|Paris|Frankfurt|Amsterdam|Madrid|Milan|Zurich|Stockholm|Helsinki|Oslo|Warsaw|Dublin|Vienna|Brussels|Prague|Copenhagen|Lisbon|Athens|Reykjavik|(?:^|[^A-Za-z｜|])(?:EU|UK|GB|GBR|DE|DEU|FR|FRA|NL|NLD|ES|ESP|IT|ITA|CH|CHE|SE|SWE|FI|FIN|NOR|PL|POL|IE|IRL|AT|AUT|BE|BEL|CZ|CZE|DK|DNK|PT|PRT|GR|GRC)(?:[0-9]|[^A-Za-z]|$)"
  };

  // 地区优先级：香港 → 澳门 → 台湾 → 新加坡 → 韩国 → 日本 → 美国 → 欧洲 → 其他
  const REGION_KEYS = ["hk", "mo", "tw", "sg", "kr", "jp", "us", "eu"];

  // 地区归属只看节点名第一个 ｜ / | 之前的部分：中转标签不参与判定，
  // 开头没有已知地区标识（含 🇧🇷 这类未收录国旗）的节点归「其他地区」。
  const LEADING_BODY = {};
  for (let i = 0; i < REGION_KEYS.length; i += 1) {
    const key = REGION_KEYS[i];
    LEADING_BODY[key] = `^(?:[^｜|]*)(?:${REGION_PATTERN_BODY[key]})`;
  }

  // QuickJS 兼容：不用 Object.fromEntries。
  const FILTER = {};
  const REGION_EXCLUDE = {};

  for (let i = 0; i < REGION_KEYS.length; i += 1) {
    const key = REGION_KEYS[i];
    FILTER[key] = `(?i)(${LEADING_BODY[key]})`;

    const higherPriorityPatterns = [];
    for (let j = 0; j < i; j += 1) {
      higherPriorityPatterns.push(LEADING_BODY[REGION_KEYS[j]]);
    }

    REGION_EXCLUDE[key] = higherPriorityPatterns.length > 0
      ? `(?i)(${PSEUDO_PATTERN_BODY}|${higherPriorityPatterns.join("|")})`
      : EXCLUDE;
  }

  const MANUAL_REGION_TESTS = REGION_KEYS.map(
    (key) => new RegExp(LEADING_BODY[key], "i")
  );

  const regionPatternList = [];
  for (let i = 0; i < REGION_KEYS.length; i += 1) {
    regionPatternList.push(LEADING_BODY[REGION_KEYS[i]]);
  }

  const OTHER_EXCLUDE =
    `(?i)(${PSEUDO_PATTERN_BODY}|${regionPatternList.join("|")})`;

  const PSEUDO_NODE_RE = new RegExp(`(?:${PSEUDO_PATTERN_BODY})`, "i");

  // ---------- 2.1 地区可用性 ----------
  // 机场只卖部分地区时，空的地区组照样占位，切过去等于断网。
  // 这里按节点名判断“这个地区到底有没有节点”，只给有节点的地区建组。
  // provider 远端节点在扩展脚本阶段枚举不到：只要有一处无法确认就退回“全部保留”，
  // 宁可多显示一个空组，也不误删有节点的地区。
  const patternMatches = (pattern, name) => {
    if (typeof pattern !== "string" || !pattern || typeof name !== "string") {
      return false;
    }
    const flags = pattern.indexOf("(?i)") === 0 ? "i" : "";
    const body = flags ? pattern.slice(4) : pattern;
    // 内核允许用反引号分隔多个正则，任一命中即算匹配。
    const parts = body.split("`");
    for (let i = 0; i < parts.length; i += 1) {
      if (!parts[i]) continue;
      try {
        if (new RegExp(parts[i], flags).test(name)) return true;
      } catch (_) {
        // 无法编译的模式不参与判断，避免误判让整组消失。
      }
    }
    return false;
  };

  // 与内核 filter / exclude-filter 同语义：先看 filter，再看 exclude-filter。
  const nodeInGroup = (name, filter, excludeFilter) =>
    patternMatches(filter, name) && !patternMatches(excludeFilter, name);

  const providerAccepts = (name, provider) =>
    (!provider.filter || patternMatches(provider.filter, name)) &&
    !patternMatches(provider["exclude-filter"], name);

  // 脚本能确认名称的节点：静态 proxies + 内联 provider payload。
  // complete=false 表示还有远端 provider，节点名要等内核加载后才知道。
  const collectKnownNodes = () => {
    const names = [];
    const statics = Array.isArray(config.proxies) ? config.proxies : [];
    for (const proxy of statics) {
      if (!isProxyCandidate(proxy)) continue;
      if (typeof proxy.name !== "string" || !proxy.name) continue;
      if (PSEUDO_NODE_RE.test(proxy.name)) continue;
      names.push(proxy.name);
    }

    let complete = true;
    for (const providerName of providerNames) {
      const provider = providers[providerName];
      if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
        complete = false;
        continue;
      }
      const override =
        provider.override &&
        typeof provider.override === "object" &&
        !Array.isArray(provider.override)
          ? provider.override
          : {};
      const payload = Array.isArray(provider.payload) ? provider.payload : null;
      // 正则改名与表达式覆写会让最终节点名不可预测，只能当作未知。
      if (
        !payload ||
        (override["proxy-name"] || []).length > 0 ||
        (override["override-expr"] || []).length > 0
      ) {
        complete = false;
        continue;
      }
      const prefix = override["additional-prefix"] || "";
      const suffix = override["additional-suffix"] || "";
      for (const proxy of payload) {
        if (!isProxyCandidate(proxy)) continue;
        if (typeof proxy.name !== "string" || !proxy.name) continue;
        const name = `${prefix}${proxy.name}${suffix}`;
        if (PSEUDO_NODE_RE.test(name)) continue;
        // provider 自身的 filter / exclude-filter 决定它到底暴露哪些节点。
        if (!providerAccepts(name, provider)) continue;
        names.push(name);
      }
    }
    return { names, complete };
  };

  const REGION_AVAILABILITY = (() => {
    const known = collectKnownNodes();
    if (!known.complete) {
      return { unknown: true, keys: REGION_KEYS.slice(), other: true };
    }
    const keys = [];
    for (const key of REGION_KEYS) {
      if (known.names.some((name) => nodeInGroup(name, FILTER[key], REGION_EXCLUDE[key]))) {
        keys.push(key);
      }
    }
    const other = known.names.some((name) => {
      for (let i = 0; i < MANUAL_REGION_TESTS.length; i += 1) {
        if (MANUAL_REGION_TESTS[i].test(name)) return false;
      }
      return true;
    });
    return { unknown: false, keys, other };
  })();

  const manualRegionRank = (name) => {
    for (let i = 0; i < MANUAL_REGION_TESTS.length; i += 1) {
      if (MANUAL_REGION_TESTS[i].test(name)) return i;
    }
    return MANUAL_REGION_TESTS.length;
  };

  // 同地区内保留订阅原顺序：机场怎么排，「全球手动」就怎么排，不再按名称重排。

  const getManualProxyNames = () => Array.isArray(config.proxies)
    ? config.proxies
        .filter(isProxyCandidate)
        .map((proxy) => proxy && proxy.name)
        .filter(
          (name) =>
            typeof name === "string" &&
            name.length > 0 &&
            !PSEUDO_NODE_RE.test(name)
        )
        .map((name, index) => ({ name, index, rank: manualRegionRank(name) }))
        .sort((a, b) => (a.rank - b.rank) || (a.index - b.index))
        .map((entry) => entry.name)
    : [];

  const manualProxyNames = getManualProxyNames();

  // ---------- 3. 工具函数 ----------
  const select = (name, icon, proxies) => ({
    name,
    type: "select",
    icon,
    proxies
  });

  // 隐藏的地区自动测速子组，只供地区聚合组调用。
  const regionAuto = (name, icon, filter, excludeFilter) => ({
    name,
    type: "url-test",
    icon,
    hidden: true,
    "include-all": true,
    "exclude-type": GROUP_EXCLUDE_TYPES,
    filter,
    "exclude-filter": excludeFilter || EXCLUDE,
    url: TEST_URL,
    interval: INTERVAL,
    tolerance: 80,
    lazy: true,
    "expected-status": 204,
    "empty-fallback": "REJECT"
  });

  // 地区聚合：首项为该地区自动测速，同时保留该地区全部节点供手动选择。
  const regionAggregate = (name, autoName, icon, filter, excludeFilter) => ({
    name,
    type: "select",
    icon,
    proxies: [autoName],
    "include-all": true,
    "exclude-type": GROUP_EXCLUDE_TYPES,
    filter,
    "exclude-filter": excludeFilter || EXCLUDE,
    "empty-fallback": "REJECT"
  });

  // 规则集来源固定为 meta-rules-dat 的 @meta 分支（可变引用）。
  // 如需更强的可复现性，可将其替换为某个 release tag 或 commit SHA（替换后需清一次缓存）。
  const RULESET_REF = "meta";
  const RULESET_HOST = "https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat";

  const DOMAIN_BASE = `${RULESET_HOST}@${RULESET_REF}/geo/geosite/`;

  const IP_BASE = `${RULESET_HOST}@${RULESET_REF}/geo/geoip/`;

  // 防呆上限（字节）：超过该体积的规则集视为异常响应，内核会拒绝加载。
  // 分流不会因此中断（匹配不到的规则集返回 false 并继续匹配后续规则），但该条规则会失效。
  const RULESET_SIZE_LIMIT = 16 * 1024 * 1024;

  // Rule Provider 属于境外资源，显式经“国外流量”下载，避免规则更新形成额外直连路径。
  // 若代理暂时不可用，Mihomo 会继续使用本地已缓存规则；首次运行仍需至少一个可用代理节点。
  const RULESET_DOWNLOAD_PROXY = "国外流量";

  const domainProvider = (file) => ({
    type: "http",
    behavior: "domain",
    format: "mrs",
    path: `./ruleset/skull/${file}`,
    url: DOMAIN_BASE + file,
    interval: RULE_INTERVAL,
    proxy: RULESET_DOWNLOAD_PROXY,
    "size-limit": RULESET_SIZE_LIMIT
  });

  // 自维护的小型域名补丁：domain/text 同时支持分流和 DNS rule-set 引用。
  // 使用 Raw 地址避免 CDN 的分支缓存延迟；热修复只需修改 rules/*.list。
  const CUSTOM_RULE_BASE =
    "https://raw.githubusercontent.com/skullvek/Mihomo-RouteKit/main/rules/";
  const customDomainProvider = (file) => ({
    type: "http",
    behavior: "domain",
    format: "text",
    path: `./ruleset/skull/custom-${file}`,
    url: CUSTOM_RULE_BASE + file,
    interval: RULE_INTERVAL,
    proxy: RULESET_DOWNLOAD_PROXY,
    "size-limit": RULESET_SIZE_LIMIT
  });

  const ipProvider = (file) => ({
    type: "http",
    behavior: "ipcidr",
    format: "mrs",
    path: `./ruleset/skull/ip-${file}`,
    url: IP_BASE + file,
    interval: RULE_INTERVAL,
    proxy: RULESET_DOWNLOAD_PROXY,
    "size-limit": RULESET_SIZE_LIMIT
  });

  // ---------- 4. 策略组 ----------
  // 地区描述表：顺序即主界面顺序，也是 AI / 服务组 / 国外流量 的选项来源。
  // 只有订阅里真的存在节点的地区才进入 ACTIVE_REGIONS（判定见 2.1）。
  const REGION_DEFS = [
    { key: "hk", aggregate: "香港聚合", auto: "香港自动", icon: ICON.hk, filter: FILTER.hk, exclude: REGION_EXCLUDE.hk },
    { key: "mo", aggregate: "澳门聚合", auto: "澳门自动", icon: ICON.mo, filter: FILTER.mo, exclude: REGION_EXCLUDE.mo },
    { key: "tw", aggregate: "台湾聚合", auto: "台湾自动", icon: ICON.tw, filter: FILTER.tw, exclude: REGION_EXCLUDE.tw },
    { key: "sg", aggregate: "新加坡聚合", auto: "新加坡自动", icon: ICON.sg, filter: FILTER.sg, exclude: REGION_EXCLUDE.sg },
    { key: "kr", aggregate: "韩国聚合", auto: "韩国自动", icon: ICON.kr, filter: FILTER.kr, exclude: REGION_EXCLUDE.kr },
    { key: "jp", aggregate: "日本聚合", auto: "日本自动", icon: ICON.jp, filter: FILTER.jp, exclude: REGION_EXCLUDE.jp },
    { key: "us", aggregate: "美国聚合", auto: "美国自动", icon: ICON.us, filter: FILTER.us, exclude: REGION_EXCLUDE.us },
    { key: "eu", aggregate: "欧洲聚合", auto: "欧洲自动", icon: ICON.eu, filter: FILTER.eu, exclude: REGION_EXCLUDE.eu },
    { key: "other", aggregate: "其他地区", auto: "其他自动", icon: ICON.other, filter: "(?i)^.*$", exclude: OTHER_EXCLUDE }
  ];

  const regionEnabled = (region) =>
    region.key === "other"
      ? REGION_AVAILABILITY.other
      : REGION_AVAILABILITY.keys.indexOf(region.key) >= 0;

  const ACTIVE_REGIONS = REGION_DEFS.filter(regionEnabled);
  const REGION_GROUPS = ACTIVE_REGIONS.map((region) => region.aggregate);

  if (!REGION_AVAILABILITY.unknown) {
    const skippedRegions = REGION_DEFS.filter((region) => !regionEnabled(region));
    if (skippedRegions.length > 0) {
      note(
        `订阅里没有这些地区的节点，已跳过对应策略组：${skippedRegions.map((region) => region.aggregate).join("、")}；当前保留：${REGION_GROUPS.join("、") || "无"}`
      );
    }
  }

  // AI 不提供 DIRECT，也不引用任何可以切到 DIRECT 的上级组。
  const AI_OPTIONS = [
    "自动选择",
    "全球手动",
    ...REGION_GROUPS
  ];
  // AI 组首次默认选中「全球手动」，与 README 结构图一致；仍不提供 DIRECT。
  const aiSelect = (name, icon) => ({
    ...select(name, icon, AI_OPTIONS),
    "default-selected": "全球手动"
  });

  // 普通国际服务允许显式 DIRECT。
  const SERVICE_OPTIONS = [
    "自动选择",
    "全球手动",
    ...REGION_GROUPS,
    "DIRECT"
  ];
  // 服务组默认选中「全球手动」，与 README 结构图一致；DIRECT 默认组显式覆盖。
  const serviceSelect = (name, icon, defaultSelected = "全球手动") => ({
    ...select(name, icon, SERVICE_OPTIONS),
    "default-selected": defaultSelected
  });

  // 一般国外流量只允许代理路径。
  const FOREIGN_OPTIONS = [
    "自动选择",
    "全球手动",
    ...REGION_GROUPS
  ];

  // 「国外流量」首次默认选中「全球手动」，与 AI / 服务组保持一致；仍不提供 DIRECT。
  const foreignSelect = (name, icon) => ({
    ...select(name, icon, FOREIGN_OPTIONS),
    "default-selected": "全球手动"
  });

  config["proxy-groups"] = [
    // 1. 全球手动：不加入 DIRECT，避免 AI 通过上级组间接直连。
    {
      name: "全球手动",
      type: "select",
      icon: ICON.manual,
      "exclude-type": GROUP_EXCLUDE_TYPES,
      // 静态节点按地区分桶、同地区保留订阅原顺序；provider 动态节点由 use 引入，顺序由内核管理。
      ...(manualProxyNames.length > 0
        ? { proxies: [...manualProxyNames] }
        : providerNames.length === 0
          ? { proxies: ["REJECT"] }
          : {}),
      ...(providerNames.length > 0
        ? {
            use: providerNames,
            "exclude-filter": EXCLUDE
          }
        : {}),
      "empty-fallback": "REJECT"
    },

    // 2. 全局自动测速
    {
      name: "自动选择",
      type: "url-test",
      icon: ICON.auto,
      "include-all": true,
      "exclude-type": GROUP_EXCLUDE_TYPES,
      "exclude-filter": EXCLUDE,
      url: TEST_URL,
      interval: INTERVAL,
      tolerance: 80,
      lazy: true,
      "expected-status": 204,
      "empty-fallback": "REJECT"
    },

    // 3. 一般国外流量
    foreignSelect("国外流量", ICON.foreign),

    // 4. 最终无法分类的流量默认交给国外流量，但保留手动 DIRECT 兜底。
    select("漏网之鱼", ICON.final, [
      "国外流量",
      "自动选择",
      "全球手动",
      "DIRECT"
    ]),

    // 5. AI：强制代理，无 DIRECT；首次默认「全球手动」
    aiSelect("ChatGPT", ICON.chatgpt),
    aiSelect("Claude", ICON.claude),
    aiSelect("Gemini / NotebookLM", ICON.gemini),

    // 6. 常用国际服务
    serviceSelect("Google", ICON.google),
    serviceSelect("GitHub", ICON.github),
    serviceSelect("X", ICON.x),
    serviceSelect("YouTube", ICON.youtube),
    serviceSelect("Netflix", ICON.netflix),
    serviceSelect("Telegram", ICON.telegram),
    // Microsoft / Apple / 游戏平台首次默认 DIRECT，其余六个服务组默认「全球手动」。
    serviceSelect("Microsoft", ICON.microsoft, "DIRECT"),
    serviceSelect("Apple", ICON.apple, "DIRECT"),
    serviceSelect("游戏平台", ICON.games, "DIRECT"),

    // 4. 地区聚合：聚合组 = 地区自动测速 + 该地区全部节点
    //    只有订阅里存在节点的地区才建组，空地区不再占用主界面。
    ...ACTIVE_REGIONS.map((region) =>
      regionAggregate(region.aggregate, region.auto, region.icon, region.filter, region.exclude)
    ),

    // 5. 地区自动测速子组
    ...ACTIVE_REGIONS.map((region) =>
      regionAuto(region.auto, region.icon, region.filter, region.exclude)
    )
  ];

  // 依赖修复只保留实际引用的旧组，避免与脚本组重名。
  const reservedGroupNames = config["proxy-groups"].map((group) => group.name);
  const activeGroupNames = new Set(reservedGroupNames);

  // ---------- 5. Rule Providers ----------
  const customRuleProviders = {
    SKULL_CustomDirect: customDomainProvider("direct.list"),
    SKULL_CustomProxy: customDomainProvider("proxy.list"),
    SKULL_FakeIPFilter: customDomainProvider("fake-ip-filter.list"),

    SKULL_Lan: domainProvider("private.mrs"),
    SKULL_China: domainProvider("cn.mrs"),
    SKULL_Foreign: domainProvider("geolocation-!cn.mrs"),

    SKULL_OpenAI: domainProvider("openai.mrs"),
    SKULL_Claude: domainProvider("anthropic.mrs"),
    SKULL_Gemini: domainProvider("google-gemini.mrs"),

    SKULL_Google: domainProvider("google.mrs"),
    SKULL_GitHub: domainProvider("github.mrs"),
    SKULL_Microsoft: domainProvider("microsoft.mrs"),
    SKULL_MicrosoftCN: domainProvider("microsoft@cn.mrs"),
    SKULL_AppleCN: domainProvider("apple@cn.mrs"),
    SKULL_Apple: domainProvider("apple.mrs"),
    SKULL_Telegram: domainProvider("telegram.mrs"),
    SKULL_X: domainProvider("x.mrs"),
    SKULL_YouTube: domainProvider("youtube.mrs"),
    SKULL_Netflix: domainProvider("netflix.mrs"),
    SKULL_GamesCN: domainProvider("category-games@cn.mrs"),
    SKULL_GamesDownloadCN: domainProvider("category-game-platforms-download@cn.mrs"),
    SKULL_Steam: domainProvider("steam.mrs"),
    SKULL_Epic: domainProvider("epicgames.mrs"),
    SKULL_BattleNet: domainProvider("blizzard.mrs"),
    SKULL_EA: domainProvider("ea.mrs"),
    SKULL_Ubisoft: domainProvider("ubisoft.mrs"),
    SKULL_Riot: domainProvider("riot.mrs"),
    SKULL_Xbox: domainProvider("xbox.mrs"),

    SKULL_LanIP: ipProvider("private.mrs"),
    SKULL_ChinaIP: ipProvider("cn.mrs"),
    SKULL_GoogleIP: ipProvider("google.mrs"),
    SKULL_TelegramIP: ipProvider("telegram.mrs"),
    SKULL_XIP: ipProvider("twitter.mrs"),
    SKULL_NetflixIP: ipProvider("netflix.mrs")
  };

  config["rule-providers"] = {
    ...(config["rule-providers"] || {}),
    ...customRuleProviders
  };

  // 仅保留节点、provider 等显式引用的旧组及其传递依赖。
  // 同名旧组使用稳定别名，避免覆盖脚本主组；辅助组隐藏，不加入 AI 选项。
  const preserveDependencies = () => {
    const reservedNames = new Set(reservedGroupNames);
    const newNames = new Set(activeGroupNames);
    const builtins = new Set(["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE", "GLOBAL"]);
    // 订阅里没有的地区组（以及 Bettbox 关闭「地区分组」后）不会出现在新配置里：
    // 旧配置对它们的引用必须改指「国外流量」，否则内核会因悬空引用拒绝整份配置。
    const missingRegionNames = new Set();
    for (const region of REGION_DEFS) {
      if (!newNames.has(region.aggregate)) missingRegionNames.add(region.aggregate);
      if (!newNames.has(region.auto)) missingRegionNames.add(region.auto);
    }
    // 别名避开全部原名，包括尚未访问的旧组与已关闭的服务组。
    const originalProxies = Array.isArray(config.proxies) ? config.proxies : [];
    const used = new Set([
      ...reservedNames, ...builtins, ...providerNames,
      ...originalProxies.map((proxy) => proxy && proxy.name),
      ...oldGroups.map((group) => group && group.name)
    ]);
    const uniqueAlias = (base) => {
      let alias = base;
      while (used.has(alias)) alias = `_${alias}`;
      used.add(alias);
      return alias;
    };
    const nodeAliases = new Map();
    const seenNodes = new Set();
    const nodes = new Map();
    for (let proxy of originalProxies) {
      if (!proxy || typeof proxy.name !== "string") continue;
      if (seenNodes.has(proxy.name)) {
        report(`订阅中存在重复节点名「${proxy.name}」，已跳过重复项`);
        continue;
      }
      seenNodes.add(proxy.name);
      if (reservedNames.has(proxy.name) || builtins.has(proxy.name)) {
        const originalName = proxy.name;
        const alias = uniqueAlias(`__SKULL_NODE__${originalName}`);
        nodeAliases.set(originalName, alias);
        proxy = { ...proxy, name: alias };
        report(
          `节点名「${originalName}」与内置策略或脚本策略组重名，已重命名为「${alias}」`
        );
      }
      nodes.set(proxy.name, proxy);
    }
    if (Array.isArray(config.proxies)) config.proxies = [...nodes.values()];
    // 手动列表生成于名称规范化之前，同步实际保留的节点名与排序。
    const manualGroup = config["proxy-groups"][0];
    const names = getManualProxyNames();
    if (names.length > 0) manualGroup.proxies = names;
    else if (providerCount === 0) manualGroup.proxies = ["REJECT"];
    else delete manualGroup.proxies;
    const old = new Map();
    // 旧组原名 -> 因与节点重名而改用的别名，供 resolve 与 default-selected 转换。
    const preAlias = new Map();
    for (const group of oldGroups) {
      if (!group || typeof group.name !== "string") continue;
      if (preAlias.has(group.name)) continue;
      if (old.has(group.name)) {
        report(`原配置中存在重复策略组「${group.name}」，已跳过重复项`);
        continue;
      }
      if (missingRegionNames.has(group.name)) {
        report(`原配置策略组「${group.name}」属于已跳过的地区，未保留`);
        continue;
      }
      if (builtins.has(group.name)) {
        report(`原配置策略组「${group.name}」与内置策略重名，已跳过`);
        continue;
      }
      if (nodes.has(group.name)) {
        // 旧组与订阅节点重名时无法按原名保留，改用稳定别名并隐藏，避免整套脚本失效。
        const alias = uniqueAlias(`__SKULL_OLD__${group.name}`);
        preAlias.set(group.name, alias);
        old.set(alias, { ...group, name: alias, hidden: true });
        report(
          `原配置策略组「${group.name}」与订阅节点重名，已重命名为「${alias}」并作为隐藏组保留`
        );
        continue;
      }
      old.set(group.name, group);
    }
    const renamed = new Map();
    const droppedReported = new Set();
    const aliases = new Set();
    const visiting = new Set();
    const retained = [];
    const unresolvedDynamicRefs = new Set();

    const resolve = (name) => {
      if (typeof name !== "string" || !name || builtins.has(name)) return name;
      // 旧组因与节点重名已被改名，引用需要先映射到别名。
      if (preAlias.has(name)) name = preAlias.get(name);
      // 仅转换原配置引用；自建规则集下载策略在下方独立保留。
      if (!old.has(name) && nodeAliases.has(name)) name = nodeAliases.get(name);
      // 已跳过的地区组不存在了：旧引用改指「国外流量」，避免落到 REJECT 断流。
      if (missingRegionNames.has(name)) {
        if (!droppedReported.has(name)) {
          droppedReported.add(name);
          report(`原配置引用了当前订阅没有节点的地区组「${name}」，已改指「国外流量」`);
        }
        return "国外流量";
      }
      if (visiting.has(name)) {
        report(`代理依赖存在循环：${name}，已切断该引用`);
        return "REJECT";
      }
      if (renamed.has(name)) return renamed.get(name);
      if (aliases.has(name)) return name;
      if (old.has(name)) {
        visiting.add(name);
        let alias = name;
        if (reservedNames.has(name)) {
          alias = uniqueAlias(`__SKULL_DEP__${name}`);
        }
        used.add(alias);
        const copy = { ...old.get(name), name: alias, hidden: true };
        if (Array.isArray(copy.proxies)) copy.proxies = copy.proxies.map(resolve);
        // default-selected 失效时由内核回退；只改写实际指向旧组的默认项。
        const defaultSelected = copy["default-selected"];
        if (preAlias.has(defaultSelected) || old.has(defaultSelected) || nodeAliases.has(defaultSelected) || missingRegionNames.has(defaultSelected)) {
          copy["default-selected"] = resolve(defaultSelected);
        }
        visiting.delete(name);
        renamed.set(name, alias);
        aliases.add(alias);
        retained.push(copy);
        return alias;
      }
      if (nodes.has(name)) {
        visiting.add(name);
        const proxy = nodes.get(name);
        rewrite(proxy, "dialer-proxy");
        visiting.delete(name);
        return name;
      }
      // 仅实际仍存在的脚本策略组可以直接放行。
      if (newNames.has(name)) return name;

      // provider 动态节点在脚本阶段无法枚举：保留引用交由 Mihomo 最终校验，但只告警一次。
      if (providerCount > 0) {
        if (!unresolvedDynamicRefs.has(name)) {
          unresolvedDynamicRefs.add(name);
          report(
            `代理依赖「${name}」无法在扩展脚本阶段确认：当前存在动态 proxy-provider，` +
              `已保留原引用；若内核提示 unknown proxy，请检查 provider 节点名或旧组依赖`
          );
        }
        return name;
      }

      report(`代理依赖不存在：${name}，已替换为 REJECT`);
      return "REJECT";
    };
    const rewrite = (object, key) => {
      if (!object || !object[key]) return;
      const original = object[key];
      const resolved = resolve(original);
      // 递归可能已切断当前字段，外层不能把原来的环重新写回。
      if (object[key] === original) object[key] = resolved;
    };
    for (const proxy of nodes.values()) rewrite(proxy, "dialer-proxy");
    for (const name of providerNames) {
      const provider = providers[name];
      if (!provider || typeof provider !== "object") continue;
      rewrite(provider, "proxy");
      rewrite(provider, "dialer-proxy");
      rewrite(provider.override, "dialer-proxy");
      for (const proxy of asArray(provider.payload)) rewrite(proxy, "dialer-proxy");
    }
    for (const [name, provider] of Object.entries(config["rule-providers"])) {
      if (!Object.prototype.hasOwnProperty.call(customRuleProviders, name)) rewrite(provider, "proxy");
    }
    for (const listener of asArray(config.listeners)) rewrite(listener, "proxy");
    for (const tunnel of asArray(config.tunnels)) rewrite(tunnel, "proxy");
    // 内核 RawNTP 里用于指定出站代理的字段名是 "dialer-proxy"，不存在 "ntp.proxy"。
    // 原脚本写成 "proxy" 导致这段检查从未生效，而真正需要保护的 dialer-proxy 反而不在范围内。
    rewrite(config.ntp, "dialer-proxy");
    config["proxy-groups"].push(...retained);

    // 新组的 include-all / 手动节点也可能让 dialer-proxy 回到节点自身。
    // 包含可见的 provider.payload；远端尚未加载的节点无法在这里枚举。
    const groups = new Map(config["proxy-groups"].map((group) => [group.name, group]));
    const regex = (pattern) => new RegExp(String(pattern).replace(/^\(\?i\)/, ""), String(pattern).startsWith("(?i)") ? "i" : "");
    const matches = (proxy, options, forGroup = false) => {
      try {
        // 自定义表达式中的 Unicode 字符类、边界及 .NET 转义可能与 JS 不同。
        // 无法确认等价时跳过成员推断；自建组沿用脚本自己的过滤表达式。
        if (!(forGroup && newNames.has(options.name)) &&
            [options.filter, options["exclude-filter"]].some(
              (pattern) => pattern && /\\[AbBdDsSwWpPzZGeEkK1-9]/.test(String(pattern))
            )) return false;
        const match = (pattern) => String(pattern).split("`").some((part) => regex(part).test(proxy.name));
        const types = String(options["exclude-type"] || "").toLowerCase().split("|");
        const rawType = String(proxy.type || "").toLowerCase();
        // provider 按 YAML 类型筛选，策略组按 AdapterType.String() 筛选。
        const type = forGroup
          ? ({ ss: "shadowsocks", ssr: "shadowsocksr" }[rawType] || rawType.replace(/-/g, ""))
          : rawType;
        return (!options.filter || match(options.filter)) &&
          (!options["exclude-filter"] || !match(options["exclude-filter"])) &&
          !types.includes(type);
      } catch (_) {
        // 无法按 JS 正则确认成员时不猜测，避免误切合法线路。
        return false;
      }
    };
    const visibleNodes = new Map([...nodes].map(([name, proxy]) => [name, { proxy, owner: proxy }]));
    for (const name of providerNames) {
      const provider = providers[name];
      if (!provider || !Array.isArray(provider.payload)) continue;
      const override = provider.override || {};
      // 正则改名及表达式覆写由内核执行，脚本无法可靠确定最终名称/依赖。
      if ((override["proxy-name"] || []).length || (override["override-expr"] || []).length) continue;
      for (const proxy of provider.payload) {
        if (!proxy || typeof proxy.name !== "string" || !matches(proxy, provider)) continue;
        const effective = { ...proxy, name: `${override["additional-prefix"] || ""}${proxy.name}${override["additional-suffix"] || ""}` };
        const owner = typeof override["dialer-proxy"] === "string" ? override
          : provider["dialer-proxy"] ? provider : proxy;
        // provider 节点不属于全局命名空间，独立身份避免与同名组/节点混淆。
        visibleNodes.set({}, { proxy: effective, owner, providerName: name });
      }
    }
    if (![...visibleNodes.values()].some((entry) => entry.owner["dialer-proxy"])) return;
    const groupMembers = new Map();
    for (const group of groups.values()) {
      const members = Array.isArray(group.proxies) ? [...group.proxies] : [];
      for (const [id, entry] of visibleNodes) {
        const included = entry.providerName
          ? group["include-all"] || group["include-all-providers"] || (group.use || []).includes(entry.providerName)
          : group["include-all"] || group["include-all-proxies"];
        if (included && matches(entry.proxy, group, true)) members.push(id);
      }
      groupMembers.set(group.name, members);
    }
    const reaches = (name, target, seen = new Set()) => {
      if (name === target) return true;
      if (!name || builtins.has(name) || seen.has(name)) return false;
      seen.add(name);
      if (visibleNodes.has(name)) return reaches(visibleNodes.get(name).owner["dialer-proxy"], target, seen);
      return (groupMembers.get(name) || []).some((member) => reaches(member, target, seen));
    };
    for (const [id, { proxy, owner }] of visibleNodes) {
      if (owner["dialer-proxy"] && reaches(owner["dialer-proxy"], id)) {
        report(`节点「${proxy.name}」经「${owner["dialer-proxy"]}」形成循环，已将 dialer-proxy 替换为 REJECT`);
        owner["dialer-proxy"] = "REJECT";
      }
    }
  };
  preserveDependencies();

  // ---------- 6. 分流规则 ----------
  // 优先级：LAN → AI → NTP 校时直连 → 自定义直连/代理补丁 → 特殊国际服务 → 中国域名 → 国外域名 → IP → MATCH
  // NotebookLM / Gemini 必须早于通用 Google。
  config.rules = [
    // LAN
    "RULE-SET,SKULL_Lan,DIRECT",

    // AI
    "DOMAIN-SUFFIX,notebooklm.google,Gemini / NotebookLM",
    "DOMAIN-SUFFIX,notebooklm.google.com,Gemini / NotebookLM",
    "DOMAIN-SUFFIX,aistudio.google.com,Gemini / NotebookLM",
    "DOMAIN-SUFFIX,ai.google.dev,Gemini / NotebookLM",
    "DOMAIN-SUFFIX,generativelanguage.googleapis.com,Gemini / NotebookLM",

    "RULE-SET,SKULL_OpenAI,ChatGPT",
    "RULE-SET,SKULL_Claude,Claude",
    "RULE-SET,SKULL_Gemini,Gemini / NotebookLM",

    // OPPO 等系统应用共用 NTP 校时；Fake-IP 排除只返回真实 IP，不决定出口。
    // 域名规则覆盖 pool 及其子域名；仅 UDP/123 直连，兼容其他校时服务器与 IP 请求。
    "DOMAIN-SUFFIX,pool.ntp.org,DIRECT",
    "AND,((NETWORK,UDP),(DST-PORT,123)),DIRECT",

    // LAN / AI 保护规则先匹配；补丁可纠正其后的服务与国内外通用分类。
    "RULE-SET,SKULL_CustomDirect,DIRECT",
    "RULE-SET,SKULL_CustomProxy,国外流量",

    // 中国区 Apple / Microsoft 优先直连。
    "RULE-SET,SKULL_AppleCN,DIRECT",
    "RULE-SET,SKULL_MicrosoftCN,DIRECT",
    // 国内游戏平台与下载 CDN 优先直连。
    "RULE-SET,SKULL_GamesCN,DIRECT",
    "RULE-SET,SKULL_GamesDownloadCN,DIRECT",

    // 游戏平台先于通用服务匹配，Xbox 等流量由独立策略组控制。
    "RULE-SET,SKULL_Steam,游戏平台",
    "RULE-SET,SKULL_Epic,游戏平台",
    "RULE-SET,SKULL_BattleNet,游戏平台",
    "RULE-SET,SKULL_EA,游戏平台",
    "RULE-SET,SKULL_Ubisoft,游戏平台",
    "RULE-SET,SKULL_Riot,游戏平台",
    "RULE-SET,SKULL_Xbox,游戏平台",

    // 常用国际服务
    "RULE-SET,SKULL_YouTube,YouTube",
    "RULE-SET,SKULL_Google,Google",
    "RULE-SET,SKULL_GitHub,GitHub",
    "RULE-SET,SKULL_Microsoft,Microsoft",
    "RULE-SET,SKULL_Apple,Apple",
    "RULE-SET,SKULL_Telegram,Telegram",
    "RULE-SET,SKULL_X,X",
    "RULE-SET,SKULL_Netflix,Netflix",

    // 中国大陆域名
    "RULE-SET,SKULL_China,DIRECT",

    // 除上述特殊服务外，其余明确的国外域名统一交给“国外流量”
    "RULE-SET,SKULL_Foreign,国外流量",

    // IP 规则
    "RULE-SET,SKULL_LanIP,DIRECT,no-resolve",
    "RULE-SET,SKULL_GoogleIP,Google,no-resolve",
    "RULE-SET,SKULL_TelegramIP,Telegram,no-resolve",
    "RULE-SET,SKULL_XIP,X,no-resolve",
    "RULE-SET,SKULL_NetflixIP,Netflix,no-resolve",

    // 中国 IP 作为未知域名的最终国内兜底
    "RULE-SET,SKULL_ChinaIP,DIRECT",

    // 无法明确判断的流量
    "MATCH,漏网之鱼"
  ];

  // ---------- 7. DNS ----------
  // 国内规则命中时直连解析；其余域名默认通过“国外流量”查询境外 DoH。
  // 未收录的国内域名可能先经境外 DNS 解析，再由中国 IP 规则判定直连。
  //
  // dns.enable=true 使客户端无需为未启用 DNS 的订阅补入整套默认 DNS。
  // FlClash 仍会在脚本之后应用 DNS 覆写，并可能追加 system:// 到 nameserver。
  // 使用本段策略时关闭 DNS 覆写（新版清除 DNS 字段的覆写选择）及“追加系统 DNS”。
  const oldDns =
    config.dns && typeof config.dns === "object" && !Array.isArray(config.dns)
      ? config.dns
      : {};
  const oldFilterMode = oldDns["fake-ip-filter-mode"];
  const compatibleFilter = oldFilterMode == null || oldFilterMode === "blacklist";
  const inheritedFilter = compatibleFilter && Array.isArray(oldDns["fake-ip-filter"])
    ? oldDns["fake-ip-filter"]
    : [];
  if (!compatibleFilter && Array.isArray(oldDns["fake-ip-filter"]) && oldDns["fake-ip-filter"].length > 0) {
    report(`原 DNS fake-ip-filter 使用「${oldFilterMode}」模式，与脚本 blacklist 不兼容；已使用脚本基础排除项`);
  }

  const DOMESTIC_DNS = [
    "https://dns.alidns.com/dns-query#DIRECT",
    "https://doh.pub/dns-query#DIRECT"
  ];
  const LAN_DNS = ["system"];
  const proxyDns = (group) => [
    `https://1.1.1.1/dns-query#${group}`,
    `https://8.8.8.8/dns-query#${group}`
  ];

  config.dns = {
    enable: true,
    ipv6: false,
    "prefer-h3": false,
    "respect-rules": true,

    "enhanced-mode": "fake-ip",
    "fake-ip-range": "198.18.0.1/16",
    "fake-ip-filter-mode": "blacklist",

    // 只继承 blacklist 模式的 fake-ip-filter；不继承 nameserver / fallback /
    // fallback-filter / nameserver-policy 等可能改变查询路径的 DNS 字段。
    "fake-ip-filter": [
      ...new Set([
        "rule-set:SKULL_FakeIPFilter",
        ...inheritedFilter,
        "*.lan",
        "*.local",
        "localhost.ptlogin2.qq.com",
        "time.*.com",
        "time.*.gov",
        "time.*.edu.cn",
        "ntp.*.com",
        "+.pool.ntp.org",
        "+.msftconnecttest.com",
        "+.msftncsi.com"
      ])
    ],

    // 仅用于 DNS 上游域名 bootstrap。
    "default-nameserver": [
      "223.5.5.5",
      "119.29.29.29"
    ],

    // 固定代理出口，不随 Google 等普通服务组切换到 DIRECT。
    nameserver: [
      "https://1.1.1.1/dns-query#国外流量",
      "https://8.8.8.8/dns-query#国外流量"
    ],

    "nameserver-policy": {
      // AI DNS 与业务流量使用同一个服务策略。
      "rule-set:SKULL_OpenAI": proxyDns("ChatGPT"),
      "rule-set:SKULL_Claude": proxyDns("Claude"),
      "rule-set:SKULL_Gemini": proxyDns("Gemini / NotebookLM"),

      // LAN / 私有域名使用系统 DNS；国内公网域名继续使用国内 DoH。
      "rule-set:SKULL_Lan": [...LAN_DNS],
      // 校时使用国内解析，避免境外 DoH 为 pool.ntp.org 选择远端服务器。
      "+.pool.ntp.org": [...DOMESTIC_DNS],
      "rule-set:SKULL_CustomDirect": [...DOMESTIC_DNS],
      "rule-set:SKULL_CustomProxy": proxyDns("国外流量"),
      "rule-set:SKULL_China": [...DOMESTIC_DNS],
      "rule-set:SKULL_AppleCN": [...DOMESTIC_DNS],
      "rule-set:SKULL_MicrosoftCN": [...DOMESTIC_DNS],
      "rule-set:SKULL_GamesCN": [...DOMESTIC_DNS],
      "rule-set:SKULL_GamesDownloadCN": [...DOMESTIC_DNS]
    },

    // DIRECT 出口默认仍使用国内 DoH；开启 follow-policy 后，LAN 等明确策略可覆盖它。
    "direct-nameserver": [...DOMESTIC_DNS],
    "direct-nameserver-follow-policy": true,

    // 节点域名独立直连解析，避免依赖尚未建立的代理连接。
    "proxy-server-nameserver": [...DOMESTIC_DNS]
  };

  // ---------- 8. 客户端设置 ----------
  // FlClash 在脚本之后管理 TUN/VPN、mode、ipv6、unified-delay、tcp-concurrent、
  // find-process-mode 等字段。这里保留订阅值，不伪造已生效的客户端设置；
  // 请在 App 中选择规则模式；如无完整 IPv6 代理链路，在 App 中关闭 IPv6。
  // config.tun 原样保留，桌面端的严格路由等参数在客户端中设置。

  // ---------- 9. 缓存 ----------
  // FlClash 自行保存策略组选择，并在后处理将 store-selected 设为 false。
  // 不依赖 Mihomo 的选择缓存；保留 Fake-IP 缓存以减少重启后的映射变化。
  const oldProfile =
    config.profile && typeof config.profile === "object" && !Array.isArray(config.profile)
      ? config.profile
      : {};
  config.profile = {
    ...oldProfile,
    "store-fake-ip": true
  };

  if (issues.length > 0) {
    console.error(
      `[SKULL] 本次共 ${issues.length} 处异常已按降级策略处理，逐条原因见上方日志`
    );
  }

  return config;
}
