import type { ReactNode } from "react";
export type IconName = "arrow" | "chart" | "shield" | "layers" | "activity" | "download" | "key" | "user" | "clock" | "check" | "menu" | "close" | "chevron" | "terminal" | "spark" | "target" | "lock" | "refresh" | "globe" | "info" | "trend" | "external";
const paths: Record<IconName, ReactNode> = {
  arrow: <><path d="M5 12h14M13 6l6 6-6 6" /></>,
  chart: <><path d="M3 3v18h18"/><path d="m6 16 5-6 4 3 5-7"/></>,
  shield: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></>,
  layers: <><path d="m12 2 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 17l9 5 9-5"/></>,
  activity: <><path d="M3 12h4l3-8 4 16 3-8h4"/></>,
  download: <><path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/></>,
  key: <><circle cx="7.5" cy="15" r="4.5"/><path d="m11 12 9-9 2 2-3 3 1.5 1.5L18 12l-1.5-1.5-3 3"/></>,
  user: <><circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  check: <path d="m5 12 5 5L20 7"/>,
  menu: <path d="M4 6h16M4 12h16M4 18h16"/>,
  close: <path d="M5 5l14 14M19 5 5 19"/>,
  chevron: <path d="m6 9 6 6 6-6"/>,
  terminal: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M12 16h5"/></>,
  spark: <><path d="m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5L12 2Z"/></>,
  target: <><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></>,
  lock: <><rect x="5" y="11" width="14" height="11" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></>,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5 9a8 8 0 0 1 13-3l2 1M4 17l2 1a8 8 0 0 0 13-3"/></>,
  globe: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c-6 5-6 13 0 18M12 3c6 5 6 13 0 18"/></>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></>,
  trend: <><path d="m3 17 7-7 4 4 7-8M15 6h6v6"/></>,
  external: <><path d="M12 4h8v8M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></>,
};
export function Icon({name, size = 20, className = ""}: {name: IconName; size?: number; className?: string}) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
