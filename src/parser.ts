import type { FilterOption } from "breeze-plugin-kit";
import { createComicItem, toStringMap } from "./common";

const load = BreezeHtml.load;

export function normalizeUrl(input: string, baseUrl: string) {
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

export function parsePageNumberFromHref(href: string) {
  const value = String(href ?? "").trim();
  const match = value.match(/[?&]p=(\d+)/i);
  return Number(match?.[1] ?? 0) || 0;
}

export function parseSearchMaxPage(html: string) {
  const $ = load(html);
  const pageValues = $(".paginator a")
    .toArray()
    .map((a) => parsePageNumberFromHref(String($(a).attr("href") ?? "")))
    .filter((value) => value > 0);
  return Math.max(...pageValues, 1);
}

export function parsePhotoItemPageUrls(html: string): string[] {
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
  for (let i = jsonStart; i < html.length; i += 1) {
    if (html[i] === "{") {
      depth += 1;
    } else if (html[i] === "}") {
      depth -= 1;
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

export function parseLatestComicUrls(html: string) {
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

export function hasLoginForm(html: string) {
  return load(html)("#login_form").length > 0;
}

export function parseFavoriteCategories(html: string, baseUrl: string) {
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

export function parseFavoriteComics(html: string, baseUrl: string) {
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
      const deleteOnclick = String(
        $el.find('a[onclick*="users-fav_del-id-"]').first().attr("onclick") ??
          "",
      );
      const favoriteEntryId =
        deleteOnclick.match(/users-fav_del-id-(\d+)/)?.[1] ?? "";

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
          favoriteEntryId,
        },
        extern: {
          ...toStringMap(item.extern),
          favoriteEntryId,
        },
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
}

export function parseFavoriteStatus(html: string) {
  const $ = load(html);
  const deleteOnclick = String(
    $("a[onclick*='users-fav_del-id-']").first().attr("onclick") ?? "",
  );
  const entryId = deleteOnclick.match(/users-fav_del-id-(\d+)/)?.[1] ?? "";
  const hasCollectedLabel = $("a")
    .toArray()
    .some(
      (element) => $(element).text().replace(/\s+/g, "").trim() === "已收藏",
    );

  return {
    isFavorite: entryId.length > 0 || hasCollectedLabel,
    entryId,
  };
}

export type FavoriteFolder = {
  id: string;
  name: string;
};

export type FavoriteEntry = {
  comicId: string;
  entryId: string;
};

export type FavoritePage = {
  html: string;
  entries: FavoriteEntry[];
  hasNext: boolean;
};

export function parseFavoriteFoldersFromDialog(html: string): FavoriteFolder[] {
  const $ = load(html);
  return $("select[name='favc_id'] option")
    .toArray()
    .map((option) => {
      const $option = $(option);
      return {
        id: String($option.attr("value") ?? "").trim(),
        name: $option.text().replace(/\s+/g, " ").trim(),
      };
    })
    .filter((folder) => folder.id.length > 0 && folder.name.length > 0);
}

export function parseFavoriteEntries(
  html: string,
  baseUrl: string,
): FavoriteEntry[] {
  const $ = load(html);
  return $(".asTB")
    .toArray()
    .map((element) => {
      const $element = $(element);
      const href = String(
        $element.find(".l_title a").first().attr("href") ?? "",
      ).trim();
      const detailUrl = normalizeUrl(href, baseUrl);
      const comicId =
        detailUrl.split("aid-")[1]?.split(".html")[0]?.trim() ?? "";
      const onclick = String(
        $element
          .find('a[onclick*="users-fav_del-id-"]')
          .first()
          .attr("onclick") ?? "",
      );
      const entryId = onclick.match(/users-fav_del-id-(\d+)/)?.[1] ?? "";
      if (!comicId || !entryId) {
        return null;
      }
      return { comicId, entryId };
    })
    .filter((entry): entry is FavoriteEntry => entry !== null);
}

export function hasNextFavoritePage(html: string) {
  const $ = load(html);
  return $(".paginator .next a").length > 0;
}

export function parseRankingCategories(html: string): FilterOption[] {
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

export function parseRankingTypes(html: string) {
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

export function parseRecentCategories(html: string): FilterOption[] {
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

export function parseRecentComics(html: string, baseUrl: string) {
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

export function hasNextRecentPage(html: string) {
  const $ = load(html);
  return $(".block-pagination .next a").length > 0;
}

export function parseGalleryItems(html: string, baseUrl: string) {
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

export type ComicDetailPage = {
  title: string;
  coverUrl: string;
  uploader: string;
  uploaderAvatar: string;
  description: string;
  pageCount: number;
  tags: string[];
  categories: string[];
  uploadDate: string;
  firstViewUrl: string;
  albumIndexUrl: string;
  isFavorite: boolean;
  favoriteEntryId: string;
};

export function parseComicDetailPage(
  html: string,
  baseUrl: string,
  comicId: string,
  fallbackFavoriteEntryId = "",
): ComicDetailPage {
  const pageFavorite = parseFavoriteStatus(html);
  const resolvedFavoriteEntryId = pageFavorite.entryId || fallbackFavoriteEntryId;
  const $ = load(html);
  const pageTitle = $("h2").first().text().replace(/\s+/g, " ").trim();
  const title = pageTitle || `漫画 #${comicId}`;
  const coverUrl = getImageUrlFromNode($(".uwthumb img").first(), baseUrl);

  const uploader =
    $(".uwuinfo a p").first().text().replace(/\s+/g, " ").trim() ||
    "unknown";
  const uploaderAvatar = getImageUrlFromNode(
    $(".uwuinfo img").first(),
    baseUrl,
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
    ? normalizeUrl(firstViewHref, baseUrl)
    : "";
  const albumIndexUrl = normalizeUrl(
    `/photos-index-aid-${comicId}.html`,
    baseUrl,
  );

  return {
    title,
    coverUrl,
    uploader,
    uploaderAvatar,
    description: descriptionText,
    pageCount,
    tags,
    categories,
    uploadDate,
    firstViewUrl,
    albumIndexUrl,
    isFavorite: pageFavorite.isFavorite || fallbackFavoriteEntryId.length > 0,
    favoriteEntryId: resolvedFavoriteEntryId,
  };
}
