import { load } from "cheerio";
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
import { cache, pluginConfig } from "./tools";

type BasePayload = {
  extern?: Record<string, unknown>;
};

type SearchPayload = BasePayload & {
  keyword?: string;
  page?: number;
};

type ComicDetailPayload = BasePayload & {
  comicId?: string;
};

type ReadSnapshotPayload = BasePayload & {
  comicId?: string;
  chapterId?: string;
};

type FetchImagePayload = BasePayload & {
  url?: string;
  timeoutMs?: number;
  taskGroupKey?: string;
  extern?: Record<string, unknown>;
};

const RELEASE_PAGES = [
  "https://wnacg01.link/",
  "https://wnacg02.link/",
] as const;
const FALLBACK_BASE_URL = "https://wnacg.com";
const SEARCH_BASE_CANDIDATES = [
  "https://www.wn04.cfd",
  "https://www.wn04.shop",
  "https://www.wn03.cfd",
  "https://www.wn03.shop",
  "https://wnacg.com",
] as const;
export const CACHE_BASE_URL_KEY = "wnacg.base_url";
export const CACHE_PUBLISH_PAGE_KEY = "wnacg.publish_page";
const CONFIG_USER_AGENT_KEY = "wnacg.user_agent";

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

async function getBaseUrlFromCache() {
  const cached = String(await cache.get(CACHE_BASE_URL_KEY, "")).trim();
  return cached || FALLBACK_BASE_URL;
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
  const stored = String(
    await pluginConfig.load(CONFIG_USER_AGENT_KEY, ""),
  ).trim();
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
  try {
    return await ky.get(url, {
      timeout: Math.max(0, timeoutMs),
      throwHttpErrors: false,
      headers: {
        "User-Agent": userAgent,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        ...(referer ? { Referer: referer } : {}),
      },
    });
  } catch (error) {
    throw new Error(`ky request failed: ${String(error)}`);
  }
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
      const response = await requestText(url, 8000);
      if (!response.ok) {
        return null;
      }
      return { url, latency: Date.now() - startedAt };
    } catch {
      return null;
    }
  });

  const checked = (await Promise.all(probeTasks)).filter(
    (item): item is { url: string; latency: number } => item !== null,
  );

  checked.sort((a, b) => a.latency - b.latency);
  return {
    fastest: checked[0]?.url ?? "",
    available: checked.map((item) => item.url),
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

async function getInfo() {
  return buildPluginInfo();
}

async function searchComic(payload: SearchPayload = {}) {
  const extern = toStringMap(payload.extern);
  const page = Math.max(1, Number(payload.page ?? 1) || 1);
  const keyword = String(payload.keyword ?? extern.keyword ?? "").trim();
  if (!keyword) {
    throw new Error("keyword 不能为空");
  }

  const cachedBaseUrl = await getBaseUrlFromCache();
  const tryBaseList = [cachedBaseUrl, ...SEARCH_BASE_CANDIDATES].filter(
    (item, index, arr) => arr.indexOf(item) === index,
  );

  let response: Response | null = null;
  let usedBaseUrl = cachedBaseUrl;
  let lastStatus = 0;
  const externUrl = String(extern.url ?? "").trim();
  const useExternUrl =
    externUrl.startsWith("http://") || externUrl.startsWith("https://");

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
    response = await requestText(searchUrl, 15000, `${baseUrl}/`);
    if (response.ok) {
      await cache.set(CACHE_BASE_URL_KEY, baseUrl);
      break;
    }
    lastStatus = response.status;
    if (response.status === 403) {
      // 403 时刷新发布页域名，再继续重试。
      await init();
    }
    response = null;
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
  };
}

async function getComicDetail(payload: ComicDetailPayload = {}) {
  const comicId = String(payload.comicId ?? "").trim();
  if (!comicId) {
    throw new Error("comicId 不能为空");
  }
  const cachedBaseUrl = await getBaseUrlFromCache();
  const tryBaseList = [cachedBaseUrl, ...SEARCH_BASE_CANDIDATES].filter(
    (item, index, arr) => arr.indexOf(item) === index,
  );

  let response: Response | null = null;
  let usedBaseUrl = cachedBaseUrl;
  let lastStatus = 0;

  for (const baseUrl of tryBaseList) {
    usedBaseUrl = baseUrl;
    const detailUrl = normalizeUrl(
      `/photos-index-aid-${comicId}.html`,
      baseUrl,
    );
    response = await requestText(detailUrl, 15000, `${baseUrl}/`);
    if (response.ok) {
      await cache.set(CACHE_BASE_URL_KEY, baseUrl);
      break;
    }
    lastStatus = response.status;
    if (response.status === 403) {
      await init();
    }
    response = null;
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
    detailUrl: normalizeUrl(`/photos-index-aid-${comicId}.html`, usedBaseUrl),
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
      },
    },
    eps: normalizedInfo.series.map((item) => ({
      id: String(item.id),
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
    allowDownload: false,
    extern: {},
  };

  const scheme = {
    version: "1.0.0",
    type: "comicDetail",
    source: PLUGIN_ID,
  };

  const data = {
    normal,
    raw: {
      comicInfo: normalizedInfo,
      series: normalizedInfo.series,
    },
  };

  return {
    source: PLUGIN_ID,
    comicId,
    extern: payload.extern ?? null,
    scheme,
    data,
  };
}

async function getReadSnapshot(payload: ReadSnapshotPayload = {}) {
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

  async function fetchAlbumPage(page: number) {
    const pageUrl =
      page <= 1
        ? normalizeUrl(`/photos-index-aid-${comicId}.html`, baseUrl)
        : normalizeUrl(
            `/photos-index-page-${page}-aid-${comicId}.html`,
            baseUrl,
          );
    const response = await requestText(pageUrl, 15000, `${baseUrl}/`);
    if (!response.ok) {
      throw new Error(`获取章节分页失败(${response.status})`);
    }
    return {
      pageUrl,
      html: await response.text(),
    };
  }

  const first = await fetchAlbumPage(1);
  const $first = load(first.html);
  const totalPages = Math.max(
    1,
    ...$first(".paginator a")
      .toArray()
      .map((a) => {
        const href = String($first(a).attr("href") ?? "").trim();
        const m = href.match(/photos-index-page-(\d+)-aid-/);
        return Number(m?.[1] ?? 0) || 0;
      })
      .filter((n) => n > 0),
  );

  type ParsedPage = {
    id: string;
    name: string;
    thumbUrl: string;
    viewUrl: string;
  };
  const parsedPages: ParsedPage[] = [];

  function collectFromHtml(html: string) {
    const $ = load(html);
    $("li.gallary_item").each((idx, li) => {
      const node = $(li);
      const href = String(
        node.find(".pic_box a").first().attr("href") ?? "",
      ).trim();
      const imgNode = node.find(".pic_box img").first();
      const thumbUrl = getImageUrlFromNode(imgNode, baseUrl);
      if (!href || !thumbUrl) {
        return;
      }
      const photoId =
        (href.match(/photos-view-id-(\d+)\.html/) ?? [])[1] ??
        `page-${parsedPages.length + idx + 1}`;
      const pageName =
        node.find(".title .name").first().text().replace(/\s+/g, " ").trim() ||
        imgNode.attr("alt")?.toString().trim() ||
        photoId;

      parsedPages.push({
        id: photoId,
        name: pageName,
        thumbUrl,
        viewUrl: normalizeUrl(href, baseUrl),
      });
    });
  }

  collectFromHtml(first.html);
  for (let p = 2; p <= totalPages; p += 1) {
    const next = await fetchAlbumPage(p);
    collectFromHtml(next.html);
  }

  const uniquePages = parsedPages.filter(
    (item, index, arr) => arr.findIndex((x) => x.id === item.id) === index,
  );
  const pages = uniquePages.map((item, index) => ({
    id: item.id,
    name: item.name || `${index + 1}`,
    path: `comic/${comicId}/${chapterId}/${index + 1}.jpg`,
    url: NOT_FOUND_IMAGE_URL,
    extern: {
      order: index + 1,
      viewUrl: item.viewUrl,
      thumbUrl: item.thumbUrl,
      baseUrl,
    },
  }));

  const chapters = [
    {
      id: chapterId,
      name: `全1话${pages.length > 0 ? `（${pages.length}P）` : ""}`,
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
        description: String(comicInfo.description ?? ""),
        cover: {
          ...toStringMap(comicInfo.cover),
          extern: toStringMap(toStringMap(comicInfo.cover).extern),
        },
        creator: {
          ...toStringMap(comicInfo.creator),
          avatar: {
            ...toStringMap(toStringMap(comicInfo.creator).avatar),
            extern: toStringMap(
              toStringMap(toStringMap(comicInfo.creator).avatar).extern,
            ),
          },
          extern: toStringMap(toStringMap(comicInfo.creator).extern),
        },
        titleMeta: Array.isArray(comicInfo.titleMeta)
          ? comicInfo.titleMeta
          : [],
        metadata: Array.isArray(comicInfo.metadata) ? comicInfo.metadata : [],
        extern: toStringMap(comicInfo.extern),
      },
      chapter: {
        id: chapterId,
        name: `全1话${pages.length > 0 ? `（${pages.length}P）` : ""}`,
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
}: FetchImagePayload = {}) {
  const externMap = toStringMap(extern);
  let targetUrl = String(url).trim();
  const viewUrl = String(externMap.viewUrl ?? "").trim();
  const thumbUrl = String(externMap.thumbUrl ?? "").trim();
  const baseUrlFromExtern = String(externMap.baseUrl ?? "").trim();
  const baseUrlCached = await getBaseUrlFromCache();
  const baseUrl = baseUrlFromExtern || baseUrlCached;

  if ((!targetUrl || targetUrl === NOT_FOUND_IMAGE_URL) && viewUrl) {
    try {
      const response = await requestText(viewUrl, 15000, `${baseUrl}/`);
      if (response.ok) {
        const html = await response.text();
        const $ = load(html);
        const resolved = getImageUrlFromNode($("#picarea").first(), baseUrl);
        if (resolved) {
          targetUrl = resolved;
        }
      }
    } catch {
      // ignore parse failure and fallback below
    }
  }
  if ((!targetUrl || targetUrl === NOT_FOUND_IMAGE_URL) && thumbUrl) {
    targetUrl = thumbUrl;
  }
  if (!targetUrl || targetUrl === NOT_FOUND_IMAGE_URL) {
    throw new Error("url 不能为空");
  }

  const userAgent = await getOrCreateUserAgent();
  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : undefined;
  const resolvedTimeout = Math.max(0, Number(timeoutMs) || 30000);
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
        Referer: `${baseUrl}/`,
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
  const nativeBufferId = await native.put(bytes);

  return {
    nativeBufferId: Number(nativeBufferId),
  };
}

async function getSettingsBundle() {
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
            { key: "auth.account", kind: "text", label: "用户名" },
            { key: "auth.password", kind: "password", label: "密码" },
          ],
        },
      ],
    },
    data: {
      canShowUserInfo: false,
      values: {
        "auth.account": "",
        "auth.password": "",
      },
    },
  };
}

export default {
  init,
  getInfo,
  searchComic,
  getComicDetail,
  getReadSnapshot,
  fetchImageBytes,
  getSettingsBundle,
};
