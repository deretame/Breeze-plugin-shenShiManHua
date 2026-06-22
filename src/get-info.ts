import { InfoContract } from "../types/type";
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
    version: "0.0.2",
    home: "https://github.com/deretame/Breeze-plugin-shenShiManHua",
    updateUrl:
      "https://api.github.com/repos/deretame/Breeze-plugin-shenShiManHua/releases/latest",
    npmName: "breeze-plugin-shen-shi-man-hua",
    function: [],
  };
}

export function buildManifestInfo() {
  return buildPluginInfo();
}
