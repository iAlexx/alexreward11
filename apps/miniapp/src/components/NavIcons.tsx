import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { readonly size?: number };

function baseProps({ size = 20, ...rest }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
    ...rest,
  };
}

export function IconHome(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M3 10.8 12 3l9 7.8" />
      <path d="M5.5 9.5V21h13V9.5M9 21v-7h6v7" />
    </svg>
  );
}

export function IconEarn(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="m13.5 2-9 12h7L10.5 22l9-13h-7z" />
    </svg>
  );
}

export function IconTasks(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M9 6h12M9 12h12M9 18h12" />
      <path d="m3 6 1.5 1.5L7 4.5m-4 7.5 1.5 1.5L7 10.5m-4 7.5 1.5 1.5L7 16.5" />
    </svg>
  );
}

export function IconFriends(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M17 11a4 4 0 0 0 0-8m5 18v-2a4 4 0 0 0-3-3.87" />
    </svg>
  );
}

export function IconWallet(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M3 6.5h16a2 2 0 0 1 2 2v11H5a2 2 0 0 1-2-2v-11Z" />
      <path d="M3 8V5a2 2 0 0 1 2-2h12v3.5M16 12h5v4h-5a2 2 0 0 1 0-4Z" />
    </svg>
  );
}

export function IconBell(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
      <path d="M10 21h4" />
    </svg>
  );
}

export function IconUser(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 22a8 8 0 0 1 16 0" />
    </svg>
  );
}

export function IconChevron(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}
