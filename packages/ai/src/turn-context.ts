/**
 * Uncached staff-assistant turn context (SHO-360). Clock is always present;
 * the company trade name is optional.
 *
 * It used to also carry a working-set block — the ids a previous turn produced,
 * so the model would not call a list tool to recover them. That went with the
 * runtime that assembled it: a turn now replays the exact provider messages it
 * ran with, so what it already saw is in the conversation, not in a reminder.
 */

import { staffAssistantClockLines } from "./kyiv-calendar.js";

export function staffAssistantTurnContextAddendum(options: {
  readonly now: Date;
  readonly companyName?: string;
}): string {
  const lines: string[] = [
    "Turn context (not cached; changes every turn).",
    staffAssistantClockLines(options.now),
    "Prefer period=today, period=this_week, or period=this_month on orders_list_page and orders_list_counts for those ranges. ISO createdFrom/createdTo remains valid for other intervals.",
  ];
  const companyName = options.companyName?.trim();
  if (companyName !== undefined && companyName !== "") {
    lines.push(`This company is called ${companyName}. Money is UAH.`);
  } else {
    lines.push("Money is UAH.");
  }
  return lines.join("\n");
}
