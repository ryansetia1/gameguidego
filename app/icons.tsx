import type { ReactNode, SVGProps } from "react";

export type IconProps = SVGProps<SVGSVGElement> & {
  size?: number;
};

const base = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "square" as const,
  strokeLinejoin: "miter" as const,
};

function Svg({ size = 20, className, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function IconX(props: IconProps) {
  return (
    <Svg {...props}>
      <path {...base} d="M6 6l12 12M18 6L6 18" />
    </Svg>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <Svg {...props}>
      <path {...base} d="M12 6v12M6 12h12" />
    </Svg>
  );
}

export function IconArrowLeft(props: IconProps) {
  return (
    <Svg {...props}>
      <path {...base} d="M14 6L8 12l6 6M8 12h10" />
    </Svg>
  );
}

export function IconHome(props: IconProps) {
  return (
    <Svg {...props}>
      <path {...base} d="M4 11l8-6 8 6M6 10v9h12v-9" />
    </Svg>
  );
}

export function IconArrowUpRight(props: IconProps) {
  return (
    <Svg {...props}>
      <path {...base} d="M7 17L17 7M17 7H9M17 7v8" />
    </Svg>
  );
}

export function IconPaperclip(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        {...base}
        d="M16 6.5L8.5 14a3.5 3.5 0 0 0 5 5L19 12.5a6 6 0 0 0-8.5-8.5L7 8"
      />
    </Svg>
  );
}

export function IconIncognito(props: IconProps) {
  return (
    <Svg {...props}>
      <path {...base} d="M4 9h16M7.5 9l1.2-3h6.6L16.5 9" />
      <circle {...base} cx="7.5" cy="14" r="2.8" />
      <circle {...base} cx="16.5" cy="14" r="2.8" />
      <path {...base} d="M10.3 14h3.4" />
    </Svg>
  );
}

export function IconMic(props: IconProps) {
  return (
    <Svg {...props}>
      <rect {...base} x="9" y="3" width="6" height="11" rx="3" />
      <path {...base} d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" />
    </Svg>
  );
}

export function IconStop(props: IconProps) {
  const { size = 20, className, ...rest } = props;
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      {...rest}
    >
      <rect x="7" y="7" width="10" height="10" fill="currentColor" />
    </svg>
  );
}

export function IconDotsVertical(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="6" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="18" r="1.5" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconGrid(props: IconProps) {
  return (
    <Svg {...props}>
      <rect {...base} x="4" y="4" width="6" height="6" />
      <rect {...base} x="14" y="4" width="6" height="6" />
      <rect {...base} x="4" y="14" width="6" height="6" />
      <rect {...base} x="14" y="14" width="6" height="6" />
    </Svg>
  );
}

export function IconSun(props: IconProps) {
  return (
    <Svg {...props}>
      <circle {...base} cx="12" cy="12" r="4" />
      <path {...base} d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4l1.4-1.4M17 7l1.4-1.4" />
    </Svg>
  );
}

export function IconMoon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        {...base}
        d="M20 14.5A7.5 7.5 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"
      />
    </Svg>
  );
}

export function IconSystem(props: IconProps) {
  return (
    <Svg {...props}>
      <rect {...base} x="3" y="5" width="18" height="12" />
      <path {...base} d="M9 21h6" />
    </Svg>
  );
}

const chevronThin = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function IconChevronDown(props: IconProps) {
  return (
    <Svg {...props}>
      <path {...chevronThin} d="M7 10l5 5 5-5" />
    </Svg>
  );
}

export function IconChevronLeft(props: IconProps) {
  return (
    <Svg {...props}>
      <path {...base} d="M15 18l-6-6 6-6" />
    </Svg>
  );
}

export function IconChevronRight(props: IconProps) {
  return (
    <Svg {...props}>
      <path {...base} d="M9 18l6-6-6-6" />
    </Svg>
  );
}

export function IconPencil(props: IconProps) {
  return (
    <Svg {...props}>
      <path {...base} d="M16 4l4 4-10 10H6v-4L16 4z" />
    </Svg>
  );
}

export function IconRefresh(props: IconProps) {
  return (
    <Svg {...props}>
      <path {...base} d="M20 12a8 8 0 1 1-2.3-5.7M20 4v6h-6" />
    </Svg>
  );
}

export function IconSort(props: IconProps) {
  return (
    <Svg {...props}>
      <path {...base} d="M7 4v16M7 20l-3-3M7 4l3 3M17 4v16M17 4l-3 3M17 20l3-3" />
    </Svg>
  );
}

export function IconDiamond(props: IconProps) {
  const { size = 20, className, ...rest } = props;
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      {...rest}
    >
      <path fill="currentColor" d="M12 4l8 8-8 8-8-8 8-8z" />
    </svg>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <Svg {...props}>
      <path {...base} d="M20 6L9 17l-5-5" />
    </Svg>
  );
}

export function IconClock(props: IconProps) {
  return (
    <Svg {...props}>
      <circle {...base} cx="12" cy="12" r="10" />
      <path {...base} d="M12 6v6l4 2" />
    </Svg>
  );
}

export function IconAlert(props: IconProps) {
  return (
    <Svg {...props}>
      <circle {...base} cx="12" cy="12" r="10" />
      <path {...base} d="M12 8v4M12 16h.01" />
    </Svg>
  );
}

export function IconInfo(props: IconProps) {
  return (
    <Svg {...props}>
      <circle {...base} cx="12" cy="12" r="10" />
      <path {...base} d="M12 10v6M12 7h.01" />
    </Svg>
  );
}

export function IconClipboard(props: IconProps) {
  return (
    <Svg {...props}>
      <path {...base} d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <rect {...base} x="8" y="2" width="8" height="4" rx="1" ry="1" />
    </Svg>
  );
}
