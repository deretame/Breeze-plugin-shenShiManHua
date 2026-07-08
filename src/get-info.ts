import { InfoContract } from "breeze-plugin-kit";
import { PLUGIN_ID } from "./common";

export function buildPluginInfo(): InfoContract {
  return {
    name: "绅士漫画",
    uuid: PLUGIN_ID,
    iconUrl: "404",
    creator: {
      name: "",
      describe: "",
    },
    describe: "绅士漫画插件",
    version: "0.0.4",
    home: "https://github.com/deretame/Breeze-plugin-shenShiManHua",
    updateUrl:
      "https://api.github.com/repos/deretame/Breeze-plugin-shenShiManHua/releases/latest",
    npmName: "breeze-plugin-shen-shi-man-hua",
    function: [
      {
        id: "ranking",
        title: "排行",
        action: {
          type: "openComicList",
          payload: {
            scene: {
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
            },
          },
        },
      },
      {
        id: "recent",
        title: "最新",
        action: {
          type: "openComicList",
          payload: {
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
        },
      },
      {
        id: "cloudFavorite",
        title: "云端收藏",
        action: {
          type: "openCloudFavorite",
          payload: { title: "云端收藏" },
        },
      },
    ],
  };
}

export function buildManifestInfo() {
  return buildPluginInfo();
}
