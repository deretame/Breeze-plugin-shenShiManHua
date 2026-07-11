import type {
  CapabilitiesBundleContract,
  ChapterContentContract,
  ChapterPage,
  ChapterPayload,
  ChapterSummary,
  ComicDetailContract,
  ComicDetailPayload,
  ComicListSceneBundleContract,
  ComicPagedListContract,
  FetchImageBytesPayload,
  FilterBundleContract,
  FilterOption,
  InfoContract,
  ReadSnapshotContract,
  ReadSnapshotPayload,
  SearchComicPayload,
  SearchResultContract,
  SettingsBundleContract,
} from "breeze-plugin-kit";
import { cache, flutterTools, pluginConfig } from "breeze-plugin-kit";
import ky from "ky";
import {
  NOT_FOUND_IMAGE_URL,
  PLUGIN_ID,
  createActionItem,
  createComicItem,
  createImage,
  createMetadataActionList,
  toStringMap,
} from "./common";
import { buildPluginInfo } from "./get-info";

const load = BreezeHtml.load;

const RELEASE_PAGES = [
  "https://wnacg01.link/",
  "https://wnacg02.link/",
] as const;
const FALLBACK_BASE_URL = "https://wnacg.com";
export const CACHE_BASE_URL_KEY = "wnacg.base_url";
export const CACHE_PUBLISH_PAGE_KEY = "wnacg.publish_page";
export const CACHE_CANDIDATE_URLS_KEY = "wnacg.candidate_urls";
export const CACHE_AVAILABLE_URLS_KEY = "wnacg.available_urls";
const CONFIG_USER_AGENT_KEY = "wnacg.user_agent";
const AUTH_ACCOUNT_CONFIG_KEY = "auth.account";
const AUTH_PASSWORD_CONFIG_KEY = "auth.password";
const LOGIN_PATH = "/users-check_login.html";
const CACHE_DETAIL_PREFIX = "wnacg.detail.";
const CACHE_ITEM_PREFIX = "wnacg.item.";
const CACHE_COOKIE_KEY = "wnacg.cookie";
const CACHE_RANKING_FILTER_KEY = "wnacg.ranking.filter";

type InitResult = {
  source: string;
  data: {
    baseUrl: string;
    fallbackUrl: string;
    publishPage: string;
    candidates: string[];
    availableUrls: string[];
  };
};

function normalizeUrl(input: string, baseUrl: string) {
  const raw = String(input ?? "").trim();
  if (!raw) {
    return "";
  }
  if (raw.startsWith("//")) {
    return `https:${raw}`;
  }
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return "";
  }
}

function getUrlOrigin(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function upgradeToHttps(url: string) {
  return url.startsWith("http://")
    ? `https://${url.slice("http://".length)}`
    : url;
}

async function getBaseUrlFromCache() {
  return String(await cache.get(CACHE_BASE_URL_KEY, "")).trim();
}

async function getUrlListFromCache(key: string) {
  const raw = String(await cache.get(key, "")).trim();
  if (!raw) {
    return [] as string[];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [] as string[];
    }
    return parsed
      .map((item) => String(item ?? "").trim())
      .filter(
        (item) => item.startsWith("http://") || item.startsWith("https://"),
      )
      .map((item) => item.replace(/\/+$/, ""))
      .filter((item, index, arr) => arr.indexOf(item) === index);
  } catch {
    return [] as string[];
  }
}

async function getDynamicBaseCandidates() {
  const cachedBaseUrl = await getBaseUrlFromCache();
  if (!cachedBaseUrl) {
    return [] as string[];
  }
  return [cachedBaseUrl];
}

function randomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickOne<T>(list: readonly T[]) {
  return list[randomInt(0, list.length - 1)] as T;
}

function buildRandomUserAgent() {
  const platform = pickOne(["windows", "macos", "linux"] as const);
  const browser = pickOne(["chrome", "firefox", "safari"] as const);

  if (browser === "firefox") {
    const ffMajor = randomInt(118, 126);
    if (platform === "windows") {
      return `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${ffMajor}.0) Gecko/20100101 Firefox/${ffMajor}.0`;
    }
    if (platform === "macos") {
      const macMajor = randomInt(12, 14);
      const macMinor = randomInt(0, 6);
      return `Mozilla/5.0 (Macintosh; Intel Mac OS X ${macMajor}_${macMinor}) Gecko/20100101 Firefox/${ffMajor}.0`;
    }
    return `Mozilla/5.0 (X11; Linux x86_64; rv:${ffMajor}.0) Gecko/20100101 Firefox/${ffMajor}.0`;
  }

  if (browser === "safari") {
    const safariMajor = randomInt(16, 17);
    const safariMinor = randomInt(0, 6);
    const webkitPatch = randomInt(1, 20);
    const macMajor = randomInt(13, 14);
    const macMinor = randomInt(0, 6);
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X ${macMajor}_${macMinor}) AppleWebKit/605.1.${webkitPatch} (KHTML, like Gecko) Version/${safariMajor}.${safariMinor} Safari/605.1.${webkitPatch}`;
  }

  const chromeMajor = randomInt(120, 126);
  const chromeBuild = randomInt(6000, 6999);
  const chromePatch = randomInt(0, 199);
  if (platform === "windows") {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.${chromeBuild}.${chromePatch} Safari/537.36`;
  }
  if (platform === "macos") {
    const macMajor = randomInt(12, 14);
    const macMinor = randomInt(0, 6);
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X ${macMajor}_${macMinor}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.${chromeBuild}.${chromePatch} Safari/537.36`;
  }
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.${chromeBuild}.${chromePatch} Safari/537.36`;
}

async function getOrCreateUserAgent() {
  const stored = decodeConfigString(
    await pluginConfig.load(CONFIG_USER_AGENT_KEY, ""),
  );
  if (stored) {
    return stored;
  }

  const picked = buildRandomUserAgent();
  await pluginConfig.save(CONFIG_USER_AGENT_KEY, picked);
  return picked;
}

function parsePageNumberFromHref(href: string) {
  const value = String(href ?? "").trim();
  const match = value.match(/[?&]p=(\d+)/i);
  return Number(match?.[1] ?? 0) || 0;
}

function parsePhotoItemPageUrls(html: string): string[] {
  const prefix = "mReader.initData(";
  const startIdx = html.indexOf(prefix);
  if (startIdx === -1) {
    throw new Error("无法解析图片列表数据");
  }
  const jsonStart = html.indexOf("{", startIdx);
  if (jsonStart === -1) {
    throw new Error("无法定位JSON起始位置");
  }
  let depth = 0;
  let jsonEnd = jsonStart;
  for (let i = jsonStart; i < html.length; i++) {
    if (html[i] === "{") {
      depth++;
    } else if (html[i] === "}") {
      depth--;
      if (depth === 0) {
        jsonEnd = i + 1;
        break;
      }
    }
  }
  let jsonStr = html.slice(jsonStart, jsonEnd);
  jsonStr = jsonStr.replace(/,\s*([\]}])/g, "$1");
  let data: { page_url?: string[] };
  try {
    data = JSON.parse(jsonStr);
  } catch {
    throw new Error("图片列表JSON解析失败");
  }
  if (!Array.isArray(data.page_url) || data.page_url.length === 0) {
    throw new Error("图片列表为空");
  }
  return data.page_url;
}

function getImageUrlFromNode(
  imageNode: { attr: (name: string) => string | undefined },
  baseUrl: string,
) {
  const raw = [
    String(imageNode.attr("data-src") ?? "").trim(),
    String(imageNode.attr("data-original") ?? "").trim(),
    String(imageNode.attr("data-lazyload") ?? "").trim(),
    String(imageNode.attr("src") ?? "").trim(),
  ].find((item) => item.length > 0);

  return normalizeUrl(raw ?? "", baseUrl);
}

function buildSearchUrl(baseUrl: string, keyword: string, page: number) {
  const url = new URL("/search/", String(baseUrl));
  url.searchParams.set("q", keyword);
  url.searchParams.set("f", "_all");
  url.searchParams.set("s", "create_time_DESC");
  url.searchParams.set("syn", "yes");
  if (page > 1) {
    url.searchParams.set("p", String(page));
  }
  return url.toString();
}

async function requestText(
  url: string,
  timeoutMs: number,
  referer?: string,
  getMobile: boolean = false,
) {
  const userAgent = getMobile
    ? "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
    : await getOrCreateUserAgent();
  const maxRedirects = 8;
  let currentUrl = String(url ?? "").trim();
  let currentReferer = referer;

  for (let i = 0; i <= maxRedirects; i += 1) {
    if (!currentUrl) {
      throw new Error("request url is empty");
    }
    try {
      const reqOrigin = getUrlOrigin(currentUrl);
      const cookieHeader = reqOrigin
        ? String(await cache.get(CACHE_COOKIE_KEY, "")).trim()
        : "";
      const response = await ky.get(currentUrl, {
        timeout: Math.max(0, timeoutMs),
        throwHttpErrors: false,
        redirect: "manual",
        headers: {
          "User-Agent": userAgent,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          ...(currentReferer ? { Referer: currentReferer } : {}),
          "sec-ch-ua-mobile": getMobile ? "?1" : "?0",
          "sec-ch-ua-platform": getMobile ? '"Android"' : '"Windows"',
        },
      });

      const setCookie = response.headers.get("set-cookie");
      if (setCookie && reqOrigin) {
        await cache.set(CACHE_COOKIE_KEY, setCookie);
      }

      // Some runtimes auto-follow to http URL (e.g. qy0.ru) and stop there with 403.
      // Force one more hop to https in this case.
      if (
        ![301, 302, 303, 307, 308].includes(response.status) &&
        response.url &&
        response.url.startsWith("http://")
      ) {
        const upgradedFinal = upgradeToHttps(response.url);
        if (upgradedFinal !== currentUrl) {
          currentReferer = getUrlOrigin(response.url)
            ? `${getUrlOrigin(response.url)}/`
            : currentReferer;
          currentUrl = upgradedFinal;
          continue;
        }
      }

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = String(response.headers.get("location") ?? "").trim();
        if (!location) {
          // Some runtimes may auto-upgrade without exposing Location on manual redirects.
          if (currentUrl.startsWith("http://")) {
            const httpsUrl = `https://${currentUrl.slice("http://".length)}`;
            currentReferer = getUrlOrigin(currentUrl)
              ? `${getUrlOrigin(currentUrl)}/`
              : currentReferer;
            currentUrl = httpsUrl;
            continue;
          }
          return response;
        }
        const nextUrl = normalizeUrl(location, currentUrl);
        if (!nextUrl) {
          return response;
        }
        currentReferer = getUrlOrigin(currentUrl)
          ? `${getUrlOrigin(currentUrl)}/`
          : currentReferer;
        currentUrl = upgradeToHttps(nextUrl);
        continue;
      }

      if (
        response.status === 429 ||
        response.headers.get("cf-mitigated") === "challenge"
      ) {
        throw new Error("请求过于频繁，请于六分钟后重试");
      }
      return response;
    } catch (error) {
      if (error instanceof TypeError && String(error).includes("fetch")) {
        throw new Error("网络请求失败，请检查网络连接");
      }
      throw error;
    }
  }

  throw new Error(`too many redirects: ${url}`);
}

async function loginWithPassword(
  payload: {
    account?: string;
    password?: string;
    notifyResult?: boolean;
  } = {},
) {
  const account = String(payload.account ?? "").trim();
  const password = String(payload.password ?? "");
  if (!account || !password.trim()) {
    const message = "账号或密码不能为空";
    if (payload.notifyResult) {
      await flutterTools.showToast({ message, level: "error" });
    }
    throw new Error(message);
  }

  const baseUrl = await getBaseUrlFromCache();
  if (!baseUrl) {
    const message = "尚未初始化，请等待插件初始化完成";
    if (payload.notifyResult) {
      await flutterTools.showToast({ message, level: "error" });
    }
    throw new Error(message);
  }
  const loginUrl = normalizeUrl(LOGIN_PATH, baseUrl);
  const userAgent = await getOrCreateUserAgent();
  const loginOrigin = getUrlOrigin(loginUrl);
  const cookieHeader = loginOrigin
    ? String(await cache.get(CACHE_COOKIE_KEY, "")).trim()
    : "";
  const body = `login_name=${encodeURIComponent(account)}&login_pass=${encodeURIComponent(password)}&remember_pass=1`;

  let response: Response;
  try {
    response = await ky.post(loginUrl, {
      timeout: 15000,
      throwHttpErrors: false,
      headers: {
        "User-Agent": userAgent,
        Accept: "application/json, text/javascript, */*; q=0.01",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      body,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error ?? "网络请求失败");
    if (payload.notifyResult) {
      await flutterTools.showToast({ message, level: "error" });
    }
    throw new Error(message);
  }

  const setCookie = response.headers.get("set-cookie");
  if (setCookie && loginOrigin) {
    await cache.set(CACHE_COOKIE_KEY, setCookie);
  }

  let data: { ret?: unknown; html?: unknown };
  try {
    data = await response.json();
  } catch {
    const message = "登录响应解析失败";
    if (payload.notifyResult) {
      await flutterTools.showToast({ message, level: "error" });
    }
    throw new Error(message);
  }

  if (data.ret !== true) {
    const message = String(data.html ?? "");
    if (payload.notifyResult) {
      await flutterTools.showToast({ message, level: "error" });
    }
    throw new Error(message);
  }

  if (payload.notifyResult) {
    await flutterTools.showToast({
      message: "绅士漫画登录成功",
      level: "success",
    });
  }

  return data;
}

async function fetchFirstReleasePage() {
  return new Promise<{ url: string; html: string }>((resolve, reject) => {
    let failedCount = 0;
    const total = RELEASE_PAGES.length;
    let settled = false;

    RELEASE_PAGES.forEach((url) => {
      requestText(url, 10000)
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`发布页请求失败: ${url} (${response.status})`);
          }
          const html = await response.text();
          if (!settled) {
            settled = true;
            resolve({ url, html });
          }
        })
        .catch(() => {
          failedCount += 1;
          if (!settled && failedCount >= total) {
            reject(new Error("所有发布页都不可用"));
          }
        });
    });
  });
}

function parseLatestComicUrls(html: string) {
  const $ = load(html);
  const urlSet = new Set<string>();

  $("li").each((_, li) => {
    const liText = $(li).text();
    if (!liText.includes("紳士漫畫最新地址")) {
      return;
    }
    $(li)
      .find("a[href]")
      .each((__, a) => {
        const href = String($(a).attr("href") ?? "").trim();
        if (!href) {
          return;
        }
        try {
          const absolute = normalizeUrl(href, "https://wnacg01.link/");
          if (
            absolute.startsWith("http://") ||
            absolute.startsWith("https://")
          ) {
            urlSet.add(absolute.replace(/\/+$/, ""));
          }
        } catch {
          // ignore invalid URL
        }
      });
  });

  return Array.from(urlSet);
}

async function pickFastestAvailableUrl(urls: string[]) {
  const probeTasks = urls.map(async (url) => {
    const startedAt = Date.now();
    try {
      const probeUrl = buildSearchUrl(url, "1", 1);
      const response = await requestText(probeUrl, 8000);
      if (!response.ok) {
        return null;
      }
      const resolved = getUrlOrigin(response.url) || getUrlOrigin(url) || url;
      return { url: resolved, latency: Date.now() - startedAt };
    } catch {
      return null;
    }
  });

  const checked = (await Promise.all(probeTasks)).filter(
    (item): item is { url: string; latency: number } => item !== null,
  );

  checked.sort((a, b) => a.latency - b.latency);
  const available = checked
    .map((item) => item.url)
    .filter((item, index, arr) => arr.indexOf(item) === index);
  return {
    fastest: available[0] ?? "",
    available,
  };
}

async function init(): Promise<InitResult> {
  try {
    const releasePage = await fetchFirstReleasePage();
    const candidates = parseLatestComicUrls(releasePage.html);
    const { fastest, available } = await pickFastestAvailableUrl(candidates);
    const baseUrl = fastest || FALLBACK_BASE_URL;

    await cache.set(CACHE_BASE_URL_KEY, baseUrl);
    await cache.set(CACHE_PUBLISH_PAGE_KEY, releasePage.url);
    await cache.set(CACHE_CANDIDATE_URLS_KEY, JSON.stringify(candidates));
    await cache.set(CACHE_AVAILABLE_URLS_KEY, JSON.stringify(available));

    const [account, password] = await Promise.all([
      loadAuthAccount(),
      loadAuthPassword(),
    ]);
    if (account && password.trim()) {
      try {
        await loginWithPassword({ account, password });
      } catch {
        // ignore eager login failure
      }
    }

    return {
      source: PLUGIN_ID,
      data: {
        baseUrl,
        fallbackUrl: FALLBACK_BASE_URL,
        publishPage: releasePage.url,
        candidates,
        availableUrls: available,
      },
    };
  } catch {
    return {
      source: PLUGIN_ID,
      data: {
        baseUrl: (await getBaseUrlFromCache()) || FALLBACK_BASE_URL,
        fallbackUrl: FALLBACK_BASE_URL,
        publishPage: "",
        candidates: [],
        availableUrls: [],
      },
    };
  }
}

function openSearchAction(keyword: string) {
  return {
    type: "openSearch",
    payload: {
      source: PLUGIN_ID,
      keyword,
      extern: {},
    },
  };
}

function openSearchByUrlAction(keyword: string, url: string) {
  return {
    type: "openSearch",
    payload: {
      source: PLUGIN_ID,
      keyword,
      extern: {
        url,
      },
    },
  };
}

function decodeConfigString(raw: unknown, fallback = "") {
  if (raw === undefined || raw === null) {
    return fallback;
  }

  if (typeof raw === "object") {
    const map = raw as Record<string, unknown>;
    if (map.ok === true && "value" in map) {
      return decodeConfigString(map.value, fallback);
    }
    return fallback;
  }

  const text = String(raw);
  if (!text.trim()) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(text.trim());
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as Record<string, unknown>).ok === true &&
      "value" in (parsed as Record<string, unknown>)
    ) {
      return decodeConfigString(
        (parsed as Record<string, unknown>).value,
        fallback,
      );
    }
    if (
      typeof parsed === "string" ||
      typeof parsed === "number" ||
      typeof parsed === "boolean"
    ) {
      return String(parsed);
    }
  } catch {
    // use raw text
  }
  return text;
}

async function saveConfigString(key: string, value: string) {
  await pluginConfig.save(key, decodeConfigString(value, ""));
}

async function loadConfigString(key: string, fallback = "") {
  const raw = await pluginConfig.load(key, fallback);
  return decodeConfigString(raw, fallback);
}

async function loadAuthAccount() {
  return loadConfigString(AUTH_ACCOUNT_CONFIG_KEY, "");
}

async function loadAuthPassword() {
  return loadConfigString(AUTH_PASSWORD_CONFIG_KEY, "");
}

async function saveAuthAccount(value: string) {
  await saveConfigString(AUTH_ACCOUNT_CONFIG_KEY, value);
}

async function saveAuthPassword(value: string) {
  await saveConfigString(AUTH_PASSWORD_CONFIG_KEY, value);
}

type SaveSettingsPayload = {
  values?: Record<string, unknown>;
  value?: unknown;
} & Record<string, unknown>;

async function getInfo(): Promise<InfoContract> {
  return buildPluginInfo();
}

function buildCloudFavoriteUrl(
  baseUrl: string,
  page: number,
  folderId?: string,
) {
  const c = folderId && folderId !== "0" ? folderId : "0";
  if (page <= 1 && c === "0") {
    return normalizeUrl("/users-users_fav.html", baseUrl);
  }
  return normalizeUrl(`/users-users_fav-page-${page}-c-${c}.html`, baseUrl);
}

function parseFavoriteCategories(html: string, baseUrl: string) {
  const $ = load(html);
  return $(".fav_nav .nav_list a")
    .toArray()
    .map((a) => {
      const $a = $(a);
      const name = $a.text().trim();
      const href = String($a.attr("href") ?? "").trim();
      const url = normalizeUrl(href, baseUrl);
      const match = href.match(/\/users-users_fav(?:-c-(\d+))?\.html/);
      const id = match?.[1] ?? "0";
      return { id, name: name || (id === "0" ? "全部" : id), url };
    })
    .filter((item) => item.id);
}

function parseFavoriteComics(html: string, baseUrl: string) {
  const $ = load(html);
  return $(".asTB")
    .toArray()
    .map((el) => {
      const $el = $(el);
      const titleAnchor = $el.find(".l_title a").first();
      const title = titleAnchor.text().trim();
      const href = String(titleAnchor.attr("href") ?? "").trim();
      const detailUrl = normalizeUrl(href, baseUrl);
      const comicId =
        detailUrl.split("aid-")[1]?.split(".html")[0]?.trim() ?? "";
      if (!comicId) return null;

      const coverRaw = String(
        $el.find(".asTBcell.thumb img").attr("src") ?? "",
      ).trim();
      const coverUrl = normalizeUrl(coverRaw, baseUrl);
      const category = $el.find(".l_catg a").text().trim();
      const detailText = $el
        .find(".l_detla")
        .text()
        .replace(/\s+/g, " ")
        .trim();

      const item = createComicItem(comicId, title || comicId);
      return {
        ...item,
        subtitle: category || detailText || item.subtitle,
        cover: {
          ...item.cover,
          url: coverUrl || item.cover.url,
          path: `comic/${comicId}/cover.jpg`,
          extern: {
            ...toStringMap(item.cover.extern),
            url: coverUrl || item.cover.url,
          },
        },
        raw: {
          ...toStringMap(item.raw),
          detailUrl,
          category,
        },
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
}

function hasNextFavoritePage(html: string) {
  const $ = load(html);
  return $(".paginator .next a").length > 0;
}

type CloudFavoritePayload = {
  page?: number;
  folderId?: string;
  extern?: Record<string, unknown>;
};

async function getCloudFavoriteData(
  payload: CloudFavoritePayload = {},
): Promise<ComicPagedListContract> {
  const extern = toStringMap(payload.extern);
  const page = Math.max(1, Number(payload.page ?? extern.page ?? 1) || 1);
  const folderId = String(payload.folderId ?? extern.folderId ?? "").trim();

  const [account, password] = await Promise.all([
    loadAuthAccount(),
    loadAuthPassword(),
  ]);
  if (!account || !password.trim()) {
    throw new Error("请先登录账号密码");
  }

  const baseUrl = await getBaseUrlFromCache();
  if (!baseUrl) {
    throw new Error("尚未初始化，请等待插件初始化完成");
  }
  const url = buildCloudFavoriteUrl(baseUrl, page, folderId);

  const response = await requestText(url, 15000, `${baseUrl}/`);
  if (!response.ok) {
    throw new Error(`收藏请求失败(${response.status})`);
  }
  const html = await response.text();
  // console.log(html);
  const items = parseFavoriteComics(html, baseUrl);
  const hasNext = hasNextFavoritePage(html);

  return {
    source: PLUGIN_ID,
    extern: payload.extern ?? null,
    scheme: {
      version: "1.0.0",
      type: "cloudFavoriteFeed",
      card: "comicGrid",
    },
    data: {
      items,
      hasReachedMax: !hasNext,
    },
  };
}

async function getCloudFavoriteFilterBundle(
  payload: CloudFavoritePayload = {},
): Promise<FilterBundleContract> {
  const baseUrl = await getBaseUrlFromCache();
  if (!baseUrl) {
    throw new Error("尚未初始化，请等待插件初始化完成");
  }
  const url = buildCloudFavoriteUrl(baseUrl, 1, "");

  const response = await requestText(url, 15000, `${baseUrl}/`);
  if (!response.ok) {
    throw new Error(`收藏分类请求失败(${response.status})`);
  }
  const html = await response.text();
  const categories = parseFavoriteCategories(html, baseUrl);

  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "filter",
      title: "分类",
      fields: [
        {
          key: "folderId",
          kind: "choice",
          label: "收藏夹",
          options: categories.map((cat) => ({
            label: cat.name,
            value: cat.id,
            result: {
              core: { folderId: cat.id },
              extern: { folderId: cat.id },
            },
          })),
        },
      ],
    },
    data: {
      values: {
        folderId: String(payload.folderId ?? ""),
      },
    },
  };
}

async function getCloudFavoriteSceneBundle(): Promise<ComicListSceneBundleContract> {
  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "comicListSceneBundle",
    },
    data: {
      scene: {
        title: "云端收藏",
        source: PLUGIN_ID,
        body: {
          type: "pluginPagedComicList",
          request: {
            fnPath: "getCloudFavoriteData",
            core: {},
            extern: {},
          },
        },
        filter: {
          fnPath: "getCloudFavoriteFilterBundle",
          core: {},
          extern: {},
        },
      },
    },
  };
}

type RankingPayload = {
  page?: number;
  type?: string;
  cate?: string;
  extern?: Record<string, unknown>;
};

function buildRankingUrl(
  baseUrl: string,
  page: number,
  type: string,
  cate?: string,
) {
  if (page <= 1 && !cate) {
    return normalizeUrl(`/albums-favorite_ranking-type-${type}.html`, baseUrl);
  }
  if (page <= 1 && cate) {
    return normalizeUrl(
      `/albums-favorite_ranking-type-${type}-cate-${cate}.html`,
      baseUrl,
    );
  }
  if (!cate) {
    return normalizeUrl(
      `/albums-favorite_ranking-page-${page}-type-${type}.html`,
      baseUrl,
    );
  }
  return normalizeUrl(
    `/albums-favorite_ranking-page-${page}-type-${type}-cate-${cate}.html`,
    baseUrl,
  );
}

function parseRankingCategories(html: string): FilterOption[] {
  const $ = load(html);
  const options = $("#ranking_cate_select option")
    .toArray()
    .map((option) => {
      const $option = $(option);
      const value = String($option.attr("value") ?? "").trim();
      const text = $option.text().trim();
      const match = value.match(
        /\/albums-favorite_ranking-type-\w+(?:-cate-(\d+))?\.html/,
      );
      const id = match?.[1] ?? "";
      const isChild = /^\s*└\s*/.test(text) || /\s*└\s*/.test(text);
      const label = text.replace(/^\s*└\s*/, "").trim();
      return { id, label, value, isChild };
    })
    .filter((item) => item.value);

  const allOption: FilterOption = {
    label: "全部分類",
    value: "",
    result: { extern: { cate: "" } },
  };
  const result: FilterOption[] = [allOption];
  let currentParent: FilterOption | null = null;

  for (const option of options) {
    if (option.id === "" && option.label === "全部分類") {
      continue;
    }

    const categoryOption: FilterOption = {
      label: option.label,
      value: option.id,
      result: { extern: { cate: option.id } },
    };

    if (option.isChild) {
      if (currentParent) {
        if (!currentParent.children) {
          currentParent.children = [
            {
              label: "全部",
              value: currentParent.value,
              result: { extern: { cate: currentParent.value } },
            },
          ];
        }
        currentParent.children.push(categoryOption);
      }
    } else {
      result.push(categoryOption);
      currentParent = categoryOption;
    }
  }

  return result;
}

function parseRankingTypes(html: string) {
  const $ = load(html);
  return $(".selectlist ul li a")
    .toArray()
    .map((a) => {
      const $a = $(a);
      const href = String($a.attr("href") ?? "").trim();
      const label = $a.text().trim();
      const match = href.match(
        /\/albums-favorite_ranking-type-(\w+)-cate\.html/,
      );
      const type = match?.[1] ?? "";
      return { label, value: type, result: { extern: { type } } };
    })
    .filter((item) => item.value);
}

async function getRankingData(
  payload: RankingPayload = {},
): Promise<ComicPagedListContract> {
  const extern = toStringMap(payload.extern);
  const page = Math.max(1, Number(payload.page ?? extern.page ?? 1) || 1);
  const type = String(extern.type ?? "week").trim() || "week";
  const cate = String(extern.cate ?? "").trim();

  const baseUrl = await getBaseUrlFromCache();
  if (!baseUrl) {
    throw new Error("尚未初始化，请等待插件初始化完成");
  }

  const url = buildRankingUrl(baseUrl, page, type, cate);
  const response = await requestText(url, 15000, `${baseUrl}/`);
  if (!response.ok) {
    throw new Error(`排行请求失败(${response.status})`);
  }
  const html = await response.text();
  const items = parseGalleryItems(html, baseUrl);
  const hasNext = hasNextFavoritePage(html);

  return {
    source: PLUGIN_ID,
    extern: payload.extern ?? null,
    scheme: {
      version: "1.0.0",
      type: "rankingFeed",
      card: "comicGrid",
    },
    data: {
      items,
      hasReachedMax: !hasNext,
    },
  };
}

async function getRankingFilterBundle(
  payload: RankingPayload = {},
): Promise<FilterBundleContract> {
  const baseUrl = await getBaseUrlFromCache();
  if (!baseUrl) {
    throw new Error("尚未初始化，请等待插件初始化完成");
  }

  const cached = await cache.get(CACHE_RANKING_FILTER_KEY, null);
  if (
    cached &&
    typeof cached === "object" &&
    Array.isArray((cached as Record<string, unknown>).categories) &&
    Array.isArray((cached as Record<string, unknown>).types)
  ) {
    const { categories, types } = cached as {
      categories: FilterOption[];
      types: ReturnType<typeof parseRankingTypes>;
    };
    return {
      source: PLUGIN_ID,
      scheme: {
        version: "1.0.0",
        type: "filter",
        title: "筛选排行",
        fields: [
          { key: "type", kind: "choice", label: "时间", options: types },
          {
            key: "cate",
            kind: "choice",
            label: "分类",
            options: categories,
          },
        ],
      },
      data: {
        values: {
          type: String(payload.type ?? "week"),
          cate: String(payload.cate ?? ""),
        },
      },
    };
  }

  const url = normalizeUrl("/albums-favorite_ranking-type-week.html", baseUrl);
  const response = await requestText(url, 15000, `${baseUrl}/`);
  if (!response.ok) {
    throw new Error(`排行分类请求失败(${response.status})`);
  }
  const html = await response.text();
  const categories = parseRankingCategories(html);
  const types = parseRankingTypes(html);
  await cache.set(CACHE_RANKING_FILTER_KEY, { categories, types });

  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "filter",
      title: "筛选排行",
      fields: [
        { key: "type", kind: "choice", label: "时间", options: types },
        {
          key: "cate",
          kind: "choice",
          label: "分类",
          options: categories,
        },
      ],
    },
    data: {
      values: {
        type: String(payload.type ?? "week"),
        cate: String(payload.cate ?? ""),
      },
    },
  };
}

async function getRankingSceneBundle(): Promise<ComicListSceneBundleContract> {
  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "comicListSceneBundle",
    },
    data: {
      scene: {
        title: "收藏排行",
        source: PLUGIN_ID,
        body: {
          type: "pluginPagedComicList",
          request: {
            fnPath: "getRankingData",
            core: {},
            extern: {},
          },
        },
        filter: {
          fnPath: "getRankingFilterBundle",
          core: {},
          extern: {},
        },
      },
    },
  };
}

const CACHE_RECENT_FILTER_KEY = "wnacg.recent.filter";

type RecentPayload = {
  page?: number;
  cate?: string;
  extern?: Record<string, unknown>;
};

function buildRecentUrl(baseUrl: string, page: number, cate?: string) {
  if (page <= 1 && !cate) {
    return normalizeUrl("/albums.html", baseUrl);
  }
  if (page <= 1 && cate) {
    return normalizeUrl(`/albums-index-cate-${cate}.html`, baseUrl);
  }
  if (!cate) {
    return normalizeUrl(`/albums-index-page-${page}.html`, baseUrl);
  }
  return normalizeUrl(`/albums-index-page-${page}-cate-${cate}.html`, baseUrl);
}

function parseRecentCategories(html: string): FilterOption[] {
  const $ = load(html);
  const parents = $("#classTit li")
    .toArray()
    .map((li) => $(li).text().trim())
    .filter(Boolean);
  const childrenGroups = $("#classCon ul")
    .toArray()
    .map((ul) => {
      return $(ul)
        .find("li a")
        .toArray()
        .map((a) => {
          const $a = $(a);
          const href = String($a.attr("href") ?? "").trim();
          const label = $a.text().trim();
          const match = href.match(/\/albums-index-cate-(\d+)\.html/);
          const id = match?.[1] ?? "";
          return { id, label };
        })
        .filter((item) => item.id);
    });

  const allOption: FilterOption = {
    label: "全部",
    value: "",
    result: { extern: { cate: "" } },
  };
  const result: FilterOption[] = [allOption];

  for (let i = 0; i < parents.length; i += 1) {
    const parentLabel = parents[i];
    const children = childrenGroups[i];
    if (!children || children.length === 0) continue;

    const firstChild = children[0];
    const parentValue = firstChild.id;
    const parentOption: FilterOption = {
      label: parentLabel,
      value: parentValue,
      result: { extern: { cate: parentValue } },
    };

    const childOptions: FilterOption[] = children.map((child) => ({
      label: child.label,
      value: child.id,
      result: { extern: { cate: child.id } },
    }));

    if (childOptions.length > 1) {
      parentOption.children = childOptions;
    }

    result.push(parentOption);
  }

  return result;
}

function parseRecentComics(html: string, baseUrl: string) {
  const $ = load(html);
  return $("#classify_container li")
    .toArray()
    .map((li) => {
      const $li = $(li);
      const imgAnchor = $li.find("a.ImgA").first();
      const href = String(imgAnchor.attr("href") ?? "").trim();
      const detailUrl = normalizeUrl(href, baseUrl);
      const comicId =
        detailUrl.split("aid-")[1]?.split(".html")[0]?.trim() ?? "";
      if (!comicId) return null;

      const title = $li.find("a.txtA").text().replace(/\s+/g, " ").trim();
      const coverRaw = String(imgAnchor.find("img").attr("src") ?? "").trim();
      const coverUrl = normalizeUrl(coverRaw, baseUrl);
      const infoText = $li.find("span.info").text().replace(/\s+/g, " ").trim();

      const item = createComicItem(comicId, title || comicId);
      return {
        ...item,
        subtitle: infoText || item.subtitle,
        cover: {
          ...item.cover,
          url: coverUrl || item.cover.url,
          path: `comic/${comicId}/cover.jpg`,
          extern: {
            ...toStringMap(item.cover.extern),
            url: coverUrl || item.cover.url,
          },
        },
        raw: {
          ...toStringMap(item.raw),
          detailUrl,
          recentInfo: infoText,
        },
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
}

function hasNextRecentPage(html: string) {
  const $ = load(html);
  return $(".block-pagination .next a").length > 0;
}

async function getRecentData(
  payload: RecentPayload = {},
): Promise<ComicPagedListContract> {
  const extern = toStringMap(payload.extern);
  const page = Math.max(1, Number(payload.page ?? extern.page ?? 1) || 1);
  const cate = String(payload.cate ?? extern.cate ?? "").trim();

  const baseUrl = await getBaseUrlFromCache();
  if (!baseUrl) {
    throw new Error("尚未初始化，请等待插件初始化完成");
  }

  const url = buildRecentUrl(baseUrl, page, cate);
  const response = await requestText(url, 15000, `${baseUrl}/`, true);
  if (!response.ok) {
    throw new Error(`最新请求失败(${response.status})`);
  }
  const html = await response.text();
  const items = parseRecentComics(html, baseUrl);
  const hasNext = hasNextRecentPage(html);

  return {
    source: PLUGIN_ID,
    extern: payload.extern ?? null,
    scheme: {
      version: "1.0.0",
      type: "recentFeed",
      card: "comicGrid",
    },
    data: {
      items,
      hasReachedMax: !hasNext,
    },
  };
}

async function getRecentFilterBundle(
  payload: RecentPayload = {},
): Promise<FilterBundleContract> {
  const baseUrl = await getBaseUrlFromCache();
  if (!baseUrl) {
    throw new Error("尚未初始化，请等待插件初始化完成");
  }

  const cached = await cache.get(CACHE_RECENT_FILTER_KEY, null);
  if (
    cached &&
    typeof cached === "object" &&
    Array.isArray((cached as Record<string, unknown>).categories)
  ) {
    const { categories } = cached as { categories: FilterOption[] };
    return {
      source: PLUGIN_ID,
      scheme: {
        version: "1.0.0",
        type: "filter",
        title: "筛选最新",
        fields: [
          {
            key: "cate",
            kind: "choice",
            label: "分类",
            options: categories,
          },
        ],
      },
      data: {
        values: {
          cate: String(payload.cate ?? ""),
        },
      },
    };
  }

  const url = normalizeUrl("/albums.html", baseUrl);
  const response = await requestText(url, 15000, `${baseUrl}/`, true);
  if (!response.ok) {
    throw new Error(`最新分类请求失败(${response.status})`);
  }
  const html = await response.text();
  const categories = parseRecentCategories(html);
  await cache.set(CACHE_RECENT_FILTER_KEY, { categories });

  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "filter",
      title: "筛选最新",
      fields: [
        {
          key: "cate",
          kind: "choice",
          label: "分类",
          options: categories,
        },
      ],
    },
    data: {
      values: {
        cate: String(payload.cate ?? ""),
      },
    },
  };
}

async function getRecentSceneBundle(): Promise<ComicListSceneBundleContract> {
  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "comicListSceneBundle",
    },
    data: {
      scene: {
        title: "最新",
        source: PLUGIN_ID,
        body: {
          type: "pluginPagedComicList",
          request: {
            fnPath: "getRecentData",
            core: {},
            extern: {},
          },
        },
        filter: {
          fnPath: "getRecentFilterBundle",
          core: {},
          extern: {},
        },
      },
    },
  };
}

function parseGalleryItems(html: string, baseUrl: string) {
  const $ = load(html);
  return $("li.gallary_item")
    .toArray()
    .map((li) => {
      const node = $(li);
      const titleAnchor = node.find(".title a").first();
      const href = String(titleAnchor.attr("href") ?? "").trim();
      if (!href) {
        return null;
      }

      const detailUrl = normalizeUrl(href, baseUrl);
      if (!detailUrl) {
        return null;
      }

      const aidSegment = detailUrl.split("aid-")[1] ?? "";
      const comicId = aidSegment.split(".html")[0]?.trim() ?? "";
      if (!comicId) {
        return null;
      }

      const title = titleAnchor.text().replace(/\s+/g, " ").trim();
      const img = node.find(".pic_box img").first();
      const coverUrl = getImageUrlFromNode(img, baseUrl);
      const infoText = node
        .find(".info_col")
        .text()
        .replace(/\s+/g, " ")
        .trim();

      const item = createComicItem(comicId, title || comicId);
      return {
        ...item,
        subtitle: infoText || item.subtitle,
        cover: {
          ...item.cover,
          url: coverUrl || item.cover.url,
          path: `comic/${comicId}/cover.jpg`,
          extern: {
            ...toStringMap(item.cover.extern),
            url: coverUrl || item.cover.url,
          },
        },
        raw: {
          ...toStringMap(item.raw),
          detailUrl,
          searchInfo: infoText,
        },
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
}

async function searchComic(
  payload: SearchComicPayload = {},
): Promise<SearchResultContract> {
  const extern = toStringMap(payload.extern);
  const page = Math.max(1, Number(payload.page ?? 1) || 1);
  const keyword = String(payload.keyword ?? extern.keyword ?? "").trim();
  if (!keyword) {
    throw new Error("keyword 不能为空");
  }

  const baseUrl = await getBaseUrlFromCache();
  if (!baseUrl) {
    throw new Error("尚未初始化，请等待插件初始化完成");
  }

  const externUrl = String(extern.url ?? "").trim();
  const useExternUrl =
    externUrl.startsWith("http://") || externUrl.startsWith("https://");

  const searchUrl = useExternUrl
    ? (() => {
        try {
          const url = new URL(externUrl);
          url.searchParams.set("p", String(page));
          if (!url.searchParams.get("q")) {
            url.searchParams.set("q", keyword);
          }
          return url.toString();
        } catch {
          return buildSearchUrl(baseUrl, keyword, page);
        }
      })()
    : buildSearchUrl(baseUrl, keyword, page);

  const response = await requestText(searchUrl, 15000);
  if (!response.ok) {
    throw new Error(`搜索请求失败(${response.status})`);
  }
  const usedBaseUrl = getUrlOrigin(response.url) || baseUrl;

  const html = await response.text();
  const items = parseGalleryItems(html, usedBaseUrl);

  const $ = load(html);
  const pageValues = $(".paginator a")
    .toArray()
    .map((a) => {
      const href = String($(a).attr("href") ?? "").trim();
      if (!href) {
        return 0;
      }
      return parsePageNumberFromHref(href);
    })
    .filter((value) => value > 0);
  const maxPage = Math.max(page, ...pageValues, 1);
  const paging = {
    page,
    pages: maxPage,
    total: items.length,
    hasReachedMax: page >= maxPage,
  };

  return {
    source: PLUGIN_ID,
    extern: payload.extern ?? null,
    scheme: {
      version: "1.0.0",
      type: "searchResult",
      source: PLUGIN_ID,
      list: "comicGrid",
    },
    data: {
      paging,
      items,
    },
    paging,
    items,
  } satisfies SearchResultContract;
}

async function getComicDetail(
  payload: ComicDetailPayload = {},
): Promise<ComicDetailContract> {
  const comicId = String(payload.comicId ?? "").trim();
  if (!comicId) {
    throw new Error("comicId 不能为空");
  }
  const cachedDetail = await cache.get(
    `${CACHE_DETAIL_PREFIX}${comicId}`,
    null,
  );
  if (cachedDetail) {
    return cachedDetail as ComicDetailContract;
  }
  const baseUrl = await getBaseUrlFromCache();
  if (!baseUrl) {
    throw new Error("尚未初始化，请等待插件初始化完成");
  }

  const detailUrl = normalizeUrl(`/photos-index-aid-${comicId}.html`, baseUrl);
  const response = await requestText(detailUrl, 15000);
  if (!response.ok) {
    throw new Error(`详情请求失败(${response.status})`);
  }

  const usedBaseUrl = getUrlOrigin(response.url) || baseUrl;
  const html = await response.text();
  const $ = load(html);
  const pageTitle = $("h2").first().text().replace(/\s+/g, " ").trim();
  const title = pageTitle || `漫画 #${comicId}`;
  const coverUrl = getImageUrlFromNode($(".uwthumb img").first(), usedBaseUrl);

  const uploader =
    $(".uwuinfo a p").first().text().replace(/\s+/g, " ").trim() || "unknown";
  const uploaderAvatar = getImageUrlFromNode(
    $(".uwuinfo img").first(),
    usedBaseUrl,
  );
  const uploaderSearchUrl = normalizeUrl(
    `/search/index.php?q=${encodeURIComponent(
      uploader,
    )}&m=&syn=yes&f=user_nicename&s=create_time_DESC&p=1`,
    usedBaseUrl,
  );
  const descriptionText = $(".uwconn p")
    .first()
    .text()
    .replace(/\s+/g, " ")
    .replace(/^簡介[:：]?\s*/u, "")
    .trim();

  const labelText = $(".uwconn label")
    .toArray()
    .map((item) => $(item).text().replace(/\s+/g, " ").trim())
    .join(" | ");
  const pageMatch = labelText.match(/頁數[:：]\s*(\d+)\s*P?/u);
  const pageCount = Number(pageMatch?.[1] ?? 0) || 0;

  const tags = $(".addtags a.tagshow")
    .toArray()
    .map((item) => $(item).text().replace(/\s+/g, " ").trim())
    .filter(
      (item, index, arr) => item.length > 0 && arr.indexOf(item) === index,
    );

  const categoryLabel =
    $(".uwconn label")
      .toArray()
      .map((item) => $(item).text().replace(/\s+/g, " ").trim())
      .find((item) => item.startsWith("分類")) ?? "";
  const categories = categoryLabel
    .replace(/^分類[:：]/u, "")
    .split("／")
    .map((item) => item.trim())
    .filter(Boolean);

  const uploadText = $(".gallary_wrap .gallary_item .info_col")
    .first()
    .text()
    .replace(/\s+/g, " ")
    .trim();
  const uploadDate = (uploadText.match(/(\d{4}-\d{2}-\d{2})/) ?? [])[1] ?? "";
  const firstViewHref = String(
    $(".gallary_wrap .gallary_item .pic_box a").first().attr("href") ?? "",
  ).trim();
  const firstViewUrl = firstViewHref
    ? normalizeUrl(firstViewHref, usedBaseUrl)
    : "";
  const albumIndexUrl = normalizeUrl(
    `/photos-index-aid-${comicId}.html`,
    usedBaseUrl,
  );

  const normalizedInfo = {
    id: comicId,
    name: title,
    description: descriptionText,
    addtime: uploadDate,
    total_views: "0",
    likes: "0",
    comment_total: "0",
    tags,
    liked: false,
    is_favorite: false,
    series: [
      {
        id: "ep-1",
        name: `全1话${pageCount > 0 ? `（${pageCount}P）` : ""}`,
        order: 1,
        rawOrder: 1,
      },
    ],
    cover: coverUrl,
    pageCount,
    detailUrl: albumIndexUrl,
    albumIndexUrl,
    firstViewUrl,
    categories,
  };

  const normal = {
    comicInfo: {
      id: String(normalizedInfo.id),
      title: normalizedInfo.name,
      titleMeta: [
        createActionItem(
          `分類：${normalizedInfo.categories.join("／") || "未知"}`,
        ),
        createActionItem(`頁數：${normalizedInfo.pageCount || "?"}P`),
        createActionItem(`更新：${normalizedInfo.addtime || "unknown"}`),
        createActionItem(`標籤：${normalizedInfo.tags.length}`),
        createActionItem(`章節：${normalizedInfo.series.length}`),
        createActionItem(`车号：${normalizedInfo.id}`),
      ],
      creator: {
        id: `uploader-${normalizedInfo.id}`,
        name: uploader || "unknown",
        avatar: createImage({
          id: `uploader-${normalizedInfo.id}`,
          url: uploaderAvatar || NOT_FOUND_IMAGE_URL,
          name: "avatar.jpg",
          path: `creator/${normalizedInfo.id}.jpg`,
          extern: {},
        }),
        onTap: openSearchByUrlAction(uploader, uploaderSearchUrl),
        extern: {},
      },
      description: normalizedInfo.description,
      cover: createImage({
        id: String(normalizedInfo.id),
        url: normalizedInfo.cover || NOT_FOUND_IMAGE_URL,
        name: `${normalizedInfo.id}.jpg`,
        path: `comic/${normalizedInfo.id}/cover.jpg`,
        extern: {
          detailUrl: normalizedInfo.detailUrl,
          albumIndexUrl: normalizedInfo.albumIndexUrl,
          firstViewUrl: normalizedInfo.firstViewUrl,
        },
      }),
      metadata: [
        createMetadataActionList("tags", "标签", normalizedInfo.tags, (item) =>
          createActionItem(item, openSearchAction(item)),
        ),
        createMetadataActionList(
          "categories",
          "分類",
          normalizedInfo.categories,
          (item) => createActionItem(item, openSearchAction(item)),
        ),
      ],
      extern: {
        detailUrl: normalizedInfo.detailUrl,
        albumIndexUrl: normalizedInfo.albumIndexUrl,
        firstViewUrl: normalizedInfo.firstViewUrl,
      },
    },
    eps: normalizedInfo.series.map((item) => ({
      id: String(item.id),
      requestId: String(item.id),
      logicalKey: String(item.id),
      storageChapterId: String(item.id),
      name: String(item.name),
      order: Number(item.order),
      extern: {
        sort: Number(item.rawOrder),
      },
    })),
    recommend: [],
    totalViews: Number(normalizedInfo.total_views),
    totalLikes: Number(normalizedInfo.likes),
    totalComments: Number(normalizedInfo.comment_total),
    isFavourite: normalizedInfo.is_favorite,
    isLiked: normalizedInfo.liked,
    allowComments: false,
    allowLike: false,
    allowCollected: false,
    allowDownload: true,
    extern: {},
  };

  const scheme = {
    version: "1.0.0" as const,
    type: "comicDetail" as const,
    source: PLUGIN_ID,
  };

  const data = {
    normal,
    raw: {
      comicInfo: normalizedInfo,
      series: normalizedInfo.series,
    },
  };

  const result: ComicDetailContract = {
    source: PLUGIN_ID,
    comicId,
    extern: payload.extern ?? null,
    scheme,
    data,
  };

  await cache.set(`${CACHE_DETAIL_PREFIX}${comicId}`, result);
  return result;
}

async function getReadSnapshot(
  payload: ReadSnapshotPayload = {},
): Promise<ReadSnapshotContract> {
  const comicId = String(payload.comicId ?? "").trim();
  if (!comicId) {
    throw new Error("comicId 不能为空");
  }
  const chapterId = String(payload.chapterId ?? "ep-1").trim() || "ep-1";

  const detail = await getComicDetail({ comicId, extern: payload.extern });
  const normal = toStringMap(toStringMap(detail.data).normal);
  const comicInfo = toStringMap(normal.comicInfo);
  const comicInfoRaw = toStringMap(toStringMap(detail.data).raw).comicInfo;
  const detailInfo = toStringMap(comicInfoRaw);
  const detailUrl = String(detailInfo.detailUrl ?? "").trim();
  const cachedBaseUrl = await getBaseUrlFromCache();
  const baseUrl = detailUrl
    ? (() => {
        try {
          return new URL(detailUrl).origin;
        } catch {
          return cachedBaseUrl;
        }
      })()
    : cachedBaseUrl;

  const itemCacheKey = `${CACHE_ITEM_PREFIX}${comicId}`;
  let pageUrls: string[] | null = null;
  const cachedItem = await cache.get(itemCacheKey, null);
  if (Array.isArray(cachedItem)) {
    pageUrls = cachedItem as string[];
  }
  if (!pageUrls) {
    const itemUrl = normalizeUrl(`/photos-item-aid-${comicId}.html`, baseUrl);
    const itemResponse = await requestText(itemUrl, 15000, `${baseUrl}/`);
    if (!itemResponse.ok) {
      throw new Error(`获取图片数据失败(${itemResponse.status})`);
    }
    const itemHtml = await itemResponse.text();
    pageUrls = parsePhotoItemPageUrls(itemHtml);
    await cache.set(itemCacheKey, pageUrls);
  }

  const pages: ChapterPage[] = pageUrls.map((imageUrl, index) => ({
    id: String(index + 1),
    name: String(index + 1),
    path: `comic/${comicId}/${chapterId}/${index + 1}.jpg`,
    url: upgradeToHttps(imageUrl),
    extern: { order: index + 1 },
  }));

  const chapters: ChapterSummary[] = [
    {
      id: chapterId,
      requestId: chapterId,
      logicalKey: chapterId,
      storageChapterId: chapterId,
      name: `全1话（${pages.length}P）`,
      order: 1,
      extern: {},
    },
  ];

  return {
    source: PLUGIN_ID,
    extern: payload.extern ?? null,
    data: {
      comic: {
        id: String(comicInfo.id ?? comicId),
        source: PLUGIN_ID,
        title: String(comicInfo.title ?? ""),
        extern: toStringMap(comicInfo.extern),
      },
      chapter: {
        id: chapterId,
        requestId: chapterId,
        logicalKey: chapterId,
        storageChapterId: chapterId,
        name: `全1话（${pages.length}P）`,
        order: 1,
        pages,
        extern: {},
      },
      chapters,
    },
  };
}

async function fetchImageBytes({
  url = "",
  timeoutMs = 30000,
  extern = {},
}: FetchImageBytesPayload = {}): Promise<Uint8Array<ArrayBufferLike>> {
  const targetUrl = String(url).trim();
  if (!targetUrl || targetUrl === NOT_FOUND_IMAGE_URL) {
    throw new Error("url 不能为空");
  }

  const userAgent = await getOrCreateUserAgent();
  const resolvedTimeout = Math.max(0, Number(timeoutMs) || 30000);
  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : undefined;
  const timer = controller
    ? setTimeout(() => {
        controller.abort();
      }, resolvedTimeout)
    : undefined;

  let response: Response;
  try {
    response = await fetch(targetUrl, {
      method: "GET",
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "User-Agent": userAgent,
      },
      signal: controller?.signal,
    });
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }

  if (!response.ok) {
    throw new Error(`图片请求失败(${response.status})`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new Error("图片数据为空");
  }

  return bytes;
}

async function saveSettings(payload: SaveSettingsPayload = {}) {
  const payloadMap = toStringMap(payload);
  const values = toStringMap(payloadMap.values);
  const keys = new Set<string>([
    ...Object.keys(payloadMap),
    ...Object.keys(values),
  ]);

  for (const key of keys) {
    if (key === "values" || key === "value") continue;
    const rawValue =
      values[key] ??
      payloadMap[key] ??
      ([AUTH_ACCOUNT_CONFIG_KEY, AUTH_PASSWORD_CONFIG_KEY].includes(key)
        ? payloadMap.value
        : undefined);
    if (rawValue === undefined) continue;
    await saveConfigString(key, String(rawValue ?? ""));
  }

  const nextAccount = await loadAuthAccount();
  const nextPassword = await loadAuthPassword();
  if (nextAccount && nextPassword.trim()) {
    try {
      await loginWithPassword({
        account: nextAccount,
        password: nextPassword,
        notifyResult: true,
      });
    } catch {
      // 登录失败已由 loginWithPassword 内部通知，这里不再抛出
    }
  }

  return { ok: true };
}

async function getSettingsBundle(): Promise<SettingsBundleContract> {
  const [account, password] = await Promise.all([
    loadAuthAccount(),
    loadAuthPassword(),
  ]);

  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "settings",
      sections: [
        {
          id: "account",
          title: "账号",
          fields: [
            {
              key: AUTH_ACCOUNT_CONFIG_KEY,
              kind: "text",
              label: "账号",
              fnPath: "saveSettings",
            },
            {
              key: AUTH_PASSWORD_CONFIG_KEY,
              kind: "password",
              label: "密码",
              fnPath: "saveSettings",
            },
          ],
        },
      ],
    },
    data: {
      canShowUserInfo: false,
      values: {
        [AUTH_ACCOUNT_CONFIG_KEY]: account,
        [AUTH_PASSWORD_CONFIG_KEY]: password,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// getChapter — 章节内容（下载场景）
// ---------------------------------------------------------------------------

async function getChapter(
  payload: ChapterPayload = {},
): Promise<ChapterContentContract> {
  const comicId = String(payload.comicId ?? "").trim();
  if (!comicId) throw new Error("comicId 不能为空");
  const chapterId = String(payload.chapterId ?? "ep-1").trim() || "ep-1";

  const snapshot = await getReadSnapshot({
    comicId,
    chapterId,
    extern: payload.extern,
  });

  const chapters = snapshot.data.chapters as ChapterSummary[];

  return {
    source: PLUGIN_ID,
    comicId,
    chapterId,
    extern: payload.extern ?? null,
    scheme: {
      version: "1.0.0",
      type: "chapterContent",
      source: PLUGIN_ID,
    },
    data: {
      comic: {
        id: comicId,
        source: PLUGIN_ID,
        title: snapshot.data.comic.title,
        extern: snapshot.data.comic.extern,
      },
      chapter: snapshot.data.chapter,
      chapters,
    },
  };
}

// ---------------------------------------------------------------------------
// getCapabilitiesBundle — 设置页操作区段
// ---------------------------------------------------------------------------

async function getCapabilitiesBundle(): Promise<CapabilitiesBundleContract> {
  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "capabilities",
      actions: [],
    },
    data: {},
  };
}

export default {
  init,
  getInfo,
  searchComic,
  getComicDetail,
  getChapter,
  getReadSnapshot,
  fetchImageBytes,

  getCloudFavoriteData,
  getCloudFavoriteFilterBundle,
  getCloudFavoriteSceneBundle,

  getRankingData,
  getRankingFilterBundle,
  getRankingSceneBundle,

  getRecentData,
  getRecentFilterBundle,
  getRecentSceneBundle,

  getSettingsBundle,
  saveSettings,
  getCapabilitiesBundle,
};
