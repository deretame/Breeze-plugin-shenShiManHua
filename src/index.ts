import { load } from "cheerio";
import ky from "ky";
import type {
  CapabilitiesBundleContract,
  ChapterContentContract,
  ChapterPage,
  ChapterPayload,
  ChapterSummary,
  ComicDetailContract,
  ComicDetailPayload,
  FetchImageBytesPayload,
  InfoContract,
  ReadSnapshotContract,
  ReadSnapshotPayload,
  SearchComicPayload,
  SearchResultContract,
  SettingsBundleContract,
} from "../types/type";
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
import { cache, pluginConfig } from "./tools";

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
const CACHE_DETAIL_PREFIX = "wnacg.detail.";
const CACHE_ITEM_PREFIX = "wnacg.item.";
const cookieJarByOrigin = new Map<string, Map<string, string>>();

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

function getCookieHeaderForOrigin(origin: string) {
  const map = cookieJarByOrigin.get(origin);
  if (!map || map.size === 0) {
    return "";
  }
  return Array.from(map.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function absorbSetCookie(origin: string, setCookie: string) {
  const first =
    String(setCookie ?? "")
      .split(";")[0]
      ?.trim() ?? "";
  if (!first || !first.includes("=")) {
    return;
  }
  const idx = first.indexOf("=");
  const name = first.slice(0, idx).trim();
  const value = first.slice(idx + 1).trim();
  if (!name) {
    return;
  }
  const map = cookieJarByOrigin.get(origin) ?? new Map<string, string>();
  map.set(name, value);
  cookieJarByOrigin.set(origin, map);
}

async function getBaseUrlFromCache() {
  const cached = String(await cache.get(CACHE_BASE_URL_KEY, "")).trim();
  return cached || FALLBACK_BASE_URL;
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
  const available = await getUrlListFromCache(CACHE_AVAILABLE_URLS_KEY);
  const candidates = await getUrlListFromCache(CACHE_CANDIDATE_URLS_KEY);
  const merged = [cachedBaseUrl, ...available, ...candidates, FALLBACK_BASE_URL]
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .filter((item, index, arr) => arr.indexOf(item) === index);
  return merged;
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

async function requestText(url: string, timeoutMs: number, referer?: string) {
  const userAgent = await getOrCreateUserAgent();
  const maxRedirects = 8;
  let currentUrl = String(url ?? "").trim();
  let currentReferer = referer;

  for (let i = 0; i <= maxRedirects; i += 1) {
    if (!currentUrl) {
      throw new Error("request url is empty");
    }
    try {
      const reqOrigin = getUrlOrigin(currentUrl);
      const cookieHeader = reqOrigin ? getCookieHeaderForOrigin(reqOrigin) : "";
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
        },
      });

      const setCookie = response.headers.get("set-cookie");
      if (setCookie && reqOrigin) {
        absorbSetCookie(reqOrigin, setCookie);
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
    await cache.set(CACHE_BASE_URL_KEY, FALLBACK_BASE_URL);
    await cache.set(CACHE_PUBLISH_PAGE_KEY, "");
    await cache.set(CACHE_CANDIDATE_URLS_KEY, JSON.stringify([]));
    await cache.set(CACHE_AVAILABLE_URLS_KEY, JSON.stringify([]));

    return {
      source: PLUGIN_ID,
      data: {
        baseUrl: FALLBACK_BASE_URL,
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

async function getInfo(): Promise<InfoContract> {
  return buildPluginInfo();
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

  let tryBaseList = await getDynamicBaseCandidates();
  if (tryBaseList.length === 0) {
    await init();
    tryBaseList = await getDynamicBaseCandidates();
  }

  let response: Response | null = null;
  let usedBaseUrl = tryBaseList[0] || FALLBACK_BASE_URL;
  let lastStatus = 0;
  let shouldRefreshByInit = false;
  const externUrl = String(extern.url ?? "").trim();
  const useExternUrl =
    externUrl.startsWith("http://") || externUrl.startsWith("https://");

  for (let round = 0; round < 2 && !response; round += 1) {
    for (const baseUrl of tryBaseList) {
      usedBaseUrl = baseUrl;
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
      response = await requestText(searchUrl, 15000);
      if (response.ok) {
        const resolvedBaseUrl = getUrlOrigin(response.url) || baseUrl;
        usedBaseUrl = resolvedBaseUrl;
        await cache.set(CACHE_BASE_URL_KEY, resolvedBaseUrl);
        break;
      }
      lastStatus = response.status;
      if (response.status === 403) {
        shouldRefreshByInit = true;
      }
      response = null;
    }
    if (!response && round === 0 && shouldRefreshByInit) {
      await init();
      tryBaseList = await getDynamicBaseCandidates();
      shouldRefreshByInit = false;
    }
  }

  if (!response) {
    throw new Error(`搜索请求失败(${lastStatus || 0})`);
  }

  const html = await response.text();
  const $ = load(html);
  const items = $("li.gallary_item")
    .toArray()
    .map((li) => {
      const node = $(li);
      const titleAnchor = node.find(".title a").first();
      const href = String(titleAnchor.attr("href") ?? "").trim();
      if (!href) {
        return null;
      }

      const detailUrl = normalizeUrl(href, usedBaseUrl);
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
      const coverUrl = getImageUrlFromNode(img, usedBaseUrl);
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
  let tryBaseList = await getDynamicBaseCandidates();
  if (tryBaseList.length === 0) {
    await init();
    tryBaseList = await getDynamicBaseCandidates();
  }

  let response: Response | null = null;
  let usedBaseUrl = tryBaseList[0] || FALLBACK_BASE_URL;
  let lastStatus = 0;
  let shouldRefreshByInit = false;

  for (let round = 0; round < 2 && !response; round += 1) {
    for (const baseUrl of tryBaseList) {
      usedBaseUrl = baseUrl;
      const detailUrl = normalizeUrl(
        `/photos-index-aid-${comicId}.html`,
        baseUrl,
      );
      response = await requestText(detailUrl, 15000);
      if (response.ok) {
        const resolvedBaseUrl = getUrlOrigin(response.url) || baseUrl;
        usedBaseUrl = resolvedBaseUrl;
        await cache.set(CACHE_BASE_URL_KEY, resolvedBaseUrl);
        break;
      }
      lastStatus = response.status;
      if (response.status === 403) {
        shouldRefreshByInit = true;
      }
      response = null;
    }
    if (!response && round === 0 && shouldRefreshByInit) {
      await init();
      tryBaseList = await getDynamicBaseCandidates();
      shouldRefreshByInit = false;
    }
  }

  if (!response) {
    throw new Error(`详情请求失败(${lastStatus || 0})`);
  }

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

async function getSettingsBundle(): Promise<SettingsBundleContract> {
  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "settings",
      sections: [],
    },
    data: {
      canShowUserInfo: false,
      values: {},
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

  getSettingsBundle,
  getCapabilitiesBundle,
};
