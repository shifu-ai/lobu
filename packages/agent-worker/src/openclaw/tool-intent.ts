export type ToolIntent =
  | "battle_report"
  | "community_verification"
  | "sales_performance"
  | "card_studio"
  | "media_editing"
  | "unknown";

function includesAny(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
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

  return "unknown";
}
