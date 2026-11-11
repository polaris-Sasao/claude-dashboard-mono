// 表示灯とアイコン（手書き SVG）。色だけでなく形でも判別できるようにする

import type { SessionStatus } from "@kanseishitsu/shared";

export function Indicator({ status, size = 14 }: { status: SessionStatus; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true" className="indicator">
      {status === "run" && <circle cx="7" cy="7" r="6" fill="var(--run)" />}
      {status === "wait" && <polygon points="7,1 13,13 1,13" fill="var(--wait)" />}
      {status === "err" && <rect x="1.5" y="1.5" width="11" height="11" fill="var(--err)" />}
      {status === "ended" && <circle cx="7" cy="7" r="5" fill="none" stroke="var(--muted)" strokeWidth="1.5" />}
    </svg>
  );
}

export function LogoIcon() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
    </svg>
  );
}

export function PcIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--sub)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}
