export type ToolIntent =
  | "battle_report"
  | "community_verification"
  | "course_context"
  | "sales_performance"
  | "workspace_docs"
  | "diagnostics"
  | "card_studio"
  | "media_editing"
  | "automation"
  | "unknown";

function includesAny(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

function hasAutomationIntent(text: string): boolean {
  if (
    /\b(?:plan_automation|create_automation|wake[ -]agent|automations?|automate|automatically)\b/.test(
      text
    ) ||
    /(?:自動化|自動工作)/.test(text) ||
    /(?:建立|新增|取消|列出|查看|停止|刪除|删除|設定|设定).{0,12}(?:提醒|自動工作|自动工作|排程)/.test(
      text
    ) ||
    /(?:提醒我|提醒他|提醒她|提醒大家|提醒團隊|提醒团队)/.test(text) ||
    /\bremind(?:\s+(?:me|us|him|her|them))?\b/.test(text)
  ) {
    return true;
  }

  const englishAction =
    /\b(?:schedule|track(?:ing)?|monitor|follow[ -]?up|check|notify)\b/.test(
      text
    );
  const englishTemporal =
    /\b(?:tomorrow|later|every|daily|weekly|monthly|recurring|continuously|until|next\s+(?:hour|day|week|month)|in\s+\d+\s+(?:minutes?|hours?|days?)|for\s+\d+\s+(?:minutes?|hours?|days?))\b/.test(
      text
    );
  if (englishAction && englishTemporal) return true;

  const chineseAction =
    /(?:建立|新增|安排|設定|设定|排程|追蹤|追踪|監控|监控|檢查|检查|告訴|告诉|回報|回报|通知|觀察|观察)/.test(
      text
    );
  const chineseTemporal =
    /(?:明天|後天|后天|下週|下周|未來|未来|每隔|每天|每日|每週|每周|每月|定期|持續|持续|直到|分鐘後|分钟后|小時後|小时后|\d+[點点時时])/.test(
      text
    );
  return chineseAction && chineseTemporal;
}

export function classifyToolIntent(text: string): ToolIntent {
  const normalized = text.toLowerCase();

  if (
    includesAny(normalized, [
      "battle_report",
      "battle report",
      "戰報",
      "战报",
      "battle-report",
    ])
  ) {
    return "battle_report";
  }

  if (
    includesAny(normalized, [
      "community_verification",
      "community verification",
      "審核",
      "审核",
      "驗證",
      "验证",
      "社群",
    ])
  ) {
    return "community_verification";
  }

  if (
    includesAny(normalized, [
      "sales_performance",
      "sales performance",
      "sales",
      "營收",
      "营收",
      "業績",
      "业绩",
      "銷售",
      "销售",
    ])
  ) {
    return "sales_performance";
  }

  if (
    includesAny(normalized, [
      "card_studio",
      "card studio",
      "卡片",
      "圖卡",
      "图卡",
    ])
  ) {
    return "card_studio";
  }

  if (
    includesAny(normalized, [
      "media_editing",
      "media editing",
      "image",
      "video",
      "圖片",
      "图片",
      "影片",
      "剪輯",
      "剪辑",
    ])
  ) {
    return "media_editing";
  }

  if (hasAutomationIntent(normalized)) {
    return "automation";
  }

  return "unknown";
}
