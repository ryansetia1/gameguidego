import { formatUsd, type ApiCostSummary } from "./admin-api-cost.js";

const idrFormatter = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

export function usdToIdrAmount(usd: number, rate: number): number {
  return Math.round(usd * rate);
}

export function formatIdr(amountIdr: number | null): string {
  if (amountIdr == null) return "—";
  return idrFormatter.format(amountIdr);
}

/** Admin display money: IDR when rate is known, otherwise USD fallback. */
export function formatAdminMoney(usd: number | null, usdToIdr: number | null): string {
  if (usd == null) return "—";
  if (!usdToIdr || !Number.isFinite(usdToIdr)) return formatUsd(usd);
  return formatIdr(usdToIdrAmount(usd, usdToIdr));
}

export function formatApiCostCompactIdr(summary: ApiCostSummary, usdToIdr: number): string {
  return summary.lines
    .filter((line) => line.costUsd != null)
    .map((line) => `${line.label.toLowerCase()}: ${formatAdminMoney(line.costUsd, usdToIdr)}`)
    .join(" · ");
}
