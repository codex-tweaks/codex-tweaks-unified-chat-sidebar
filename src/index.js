import "./sidebar.css";
import "./refresh.css";
import "./home.css";
import { activateSidebar } from "./sidebar.js";
import { activateRefresh } from "./refresh.js";
import { activateHomeMode } from "./home.js";

const FEATURES = [
  ["统一聊天侧栏", activateSidebar],
  ["聊天记录刷新", activateRefresh],
  ["首页模式切换", activateHomeMode],
];

export function activate(context) {
  for (const [name, activateFeature] of FEATURES) {
    try {
      activateFeature(context);
    } catch (error) {
      console.warn(`[Codex Tweaks] 无法启用${name}。`, error);
    }
  }
}
