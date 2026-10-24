import type { ComicListScene } from "breeze-plugin-kit";
import { PLUGIN_ID } from "./common";

export function buildRankingScene(): ComicListScene {
  return {
    title: "排行",
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
  };
}

export function buildRecentScene(): ComicListScene {
  return {
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
  };
}

export function buildCloudFavoriteScene(): ComicListScene {
  return {
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
  };
}

export function buildPluginInfo() {
  return {
    name: "绅士漫画",
    uuid: PLUGIN_ID,
    iconUrl: "404",
    describe: "绅士漫画插件",
    version: "0.1.1",
    home: "https://github.com/deretame/Breeze-plugin-shenShiManHua",
    updateUrl: "https://api.github.com/repos/deretame/Breeze-plugin-shenShiManHua/releases/latest",
    npmName: "breeze-plugin-shen-shi-man-hua",
    haveHome: true,
    haveCloudFavorite: true,
    function: [
      {
        id: "ranking",
        title: "排行",
        action: {
          type: "openComicList" as const,
          payload: { scene: buildRankingScene() },
        },
      },
      {
        id: "recent",
        title: "最新",
        action: {
          type: "openComicList" as const,
          payload: { scene: buildRecentScene() },
        },
      },
      {
        id: "cloudFavorite",
        title: "云端收藏",
        action: {
          type: "openComicList" as const,
          payload: { scene: buildCloudFavoriteScene() },
        },
      },
    ],
  };
}

export function buildManifestInfo() {
  return buildPluginInfo();
}
