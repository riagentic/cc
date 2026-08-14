/**
 * @module
 * The icon set: hand-drawn 24×24 stroke paths, no dependency, no icon font.
 *
 * They inherit `currentColor` and the surrounding font size, so an icon is
 * always the same weight as the text beside it and themes for free.
 */
import type { VNode } from "aio/air";

type Props = { size?: number; class?: string; strokeWidth?: number };

const svg = (path: unknown, p: Props = {}) => (
  <svg
    width={p.size ?? 18}
    height={p.size ?? 18}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width={p.strokeWidth ?? 1.7}
    stroke-linecap="round"
    stroke-linejoin="round"
    class={p.class}
    aria-hidden="true"
    focusable="false"
  >
    {path}
  </svg>
);

export const IconChat = (p?: Props) =>
  svg(
    <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.5 9.5 0 0 1-3.2-.5L3 21l1.7-4.6A8.2 8.2 0 0 1 3.6 11.5 8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4Z" />,
    p,
  );

export const IconAgents = (p?: Props) =>
  svg(
    <>
      <path d="M9 11a3.2 3.2 0 1 0 0-6.4A3.2 3.2 0 0 0 9 11Z" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M17 4.6a3.2 3.2 0 0 1 0 6.2" />
      <path d="M18.4 14.2A6.5 6.5 0 0 1 21.5 20" />
    </>,
    p,
  );

export const IconTasks = (p?: Props) =>
  svg(
    <>
      <path d="m3 6 2 2 3-3.4" />
      <path d="m3 13 2 2 3-3.4" />
      <path d="M11 6.2h10" />
      <path d="M11 13.2h10" />
      <path d="M11 20h10" />
      <path d="m3 20 2 2 3-3.4" />
    </>,
    p,
  );

export const IconActivity = (p?: Props) =>
  svg(<path d="M2.5 12h4l2.5-7 4 14 2.5-7h6" />, p);

export const IconMemory = (p?: Props) =>
  svg(
    <>
      <rect x="3.2" y="7.4" width="17.6" height="9.2" rx="2" />
      <path d="M7.4 7.4V4.2M12 7.4V4.2M16.6 7.4V4.2" />
      <path d="M7.4 19.8v-3.2M12 19.8v-3.2M16.6 19.8v-3.2" />
      <path d="M8.6 11.2h6.8v1.6H8.6z" />
    </>,
    p,
  );

export const IconSettings = (p?: Props) =>
  svg(
    <>
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
      <circle cx="16" cy="7" r="2.4" />
      <circle cx="8" cy="17" r="2.4" />
    </>,
    p,
  );

export const IconFolder = (p?: Props) =>
  svg(
    <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4L11 8.4h8.5A1.5 1.5 0 0 1 21 9.9v7.6a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5Z" />,
    p,
  );

export const IconBranch = (p?: Props) =>
  svg(
    <>
      <circle cx="6.5" cy="5.5" r="2.2" />
      <circle cx="6.5" cy="18.5" r="2.2" />
      <circle cx="17.5" cy="8.5" r="2.2" />
      <path d="M6.5 7.7v8.6" />
      <path d="M17.5 10.7c0 3.4-2.6 4.6-5.4 5.2-1.8.4-3.1.9-3.6 2" />
    </>,
    p,
  );

export const IconModel = (p?: Props) =>
  svg(
    <>
      <path d="m12 3 1.7 4.6L18.4 9l-4.7 1.4L12 15l-1.7-4.6L5.6 9l4.7-1.4Z" />
      <path d="m18.5 15.5.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8Z" />
    </>,
    p,
  );

export const IconSend = (p?: Props) =>
  svg(
    <>
      <path d="M4 12 20.5 4.2 13.4 20.5l-2-6.9Z" />
      <path d="m11.4 13.6 5-5" />
    </>,
    p,
  );

export const IconStop = (p?: Props) =>
  svg(<rect x="6.2" y="6.2" width="11.6" height="11.6" rx="2.2" />, p);

export const IconPlay = (p?: Props) =>
  svg(<path d="M7.5 5.4 19 12 7.5 18.6Z" />, p);

export const IconPower = (p?: Props) =>
  svg(
    <>
      <path d="M12 3.5v8" />
      <path d="M17.6 6.6a7.6 7.6 0 1 1-11.2 0" />
    </>,
    p,
  );

export const IconRefresh = (p?: Props) =>
  svg(
    <>
      <path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" />
      <path d="M20.7 4.2v4.6h-4.6" />
    </>,
    p,
  );

export const IconClock = (p?: Props) =>
  svg(
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 7.3V12l3.2 2" />
    </>,
    p,
  );

export const IconCoins = (p?: Props) =>
  svg(
    <>
      <ellipse cx="12" cy="6.6" rx="7.4" ry="3.1" />
      <path d="M4.6 6.6v10.8c0 1.7 3.3 3.1 7.4 3.1s7.4-1.4 7.4-3.1V6.6" />
      <path d="M4.6 12c0 1.7 3.3 3.1 7.4 3.1s7.4-1.4 7.4-3.1" />
    </>,
    p,
  );

export const IconCheck = (p?: Props) =>
  svg(<path d="m4.5 12.5 4.8 4.8L19.5 7" />, p);

export const IconX = (p?: Props) =>
  svg(<path d="M6.2 6.2 17.8 17.8M17.8 6.2 6.2 17.8" />, p);

export const IconAlert = (p?: Props) =>
  svg(
    <>
      <path d="M12 3.8 21.4 20H2.6Z" />
      <path d="M12 10v4.2M12 17.2h.01" />
    </>,
    p,
  );

/** Permission: a shield, because what it guards is the answer to "may I?". */
export const IconShield = (p?: Props) =>
  svg(
    <>
      <path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6l7-3Z" />
      <path d="M9.2 12.2l2 2 3.6-3.9" />
    </>,
    p,
  );

export const IconPlus = (p?: Props) =>
  svg(<path d="M12 5.2v13.6M5.2 12h13.6" />, p);

export const IconTrash = (p?: Props) =>
  svg(
    <>
      <path d="M4.5 6.6h15" />
      <path d="M9.4 6.6V4.8h5.2v1.8" />
      <path d="M6.6 6.6 7.5 20h9l.9-13.4" />
      <path d="M10.4 10.2v6M13.6 10.2v6" />
    </>,
    p,
  );

export const IconTerminal = (p?: Props) =>
  svg(
    <>
      <rect x="2.8" y="4.4" width="18.4" height="15.2" rx="2.4" />
      <path d="m7 9.4 3 2.8-3 2.8" />
      <path d="M12.6 15.4h4.4" />
    </>,
    p,
  );

export const IconSpark = (p?: Props) =>
  svg(
    <>
      <path d="M12 4.2 13.4 9l4.8 1.4L13.4 12 12 16.8 10.6 12 5.8 10.4 10.6 9Z" />
    </>,
    p,
  );

export const IconUser = (p?: Props) =>
  svg(
    <>
      <circle cx="12" cy="8" r="3.6" />
      <path d="M4.8 20a7.2 7.2 0 0 1 14.4 0" />
    </>,
    p,
  );

export const IconChevron = (p?: Props) =>
  svg(<path d="m9.5 5.5 6.5 6.5-6.5 6.5" />, p);

export const IconFile = (p?: Props) =>
  svg(
    <>
      <path d="M13.4 3.2H6.8a1.8 1.8 0 0 0-1.8 1.8v14a1.8 1.8 0 0 0 1.8 1.8h10.4a1.8 1.8 0 0 0 1.8-1.8V8.6Z" />
      <path d="M13.4 3.2v5.4H19" />
    </>,
    p,
  );

export const IconPlug = (p?: Props) =>
  svg(
    <>
      <path d="M9 3.4v5M15 3.4v5" />
      <path d="M6.5 8.4h11v2.9a5.5 5.5 0 0 1-11 0Z" />
      <path d="M12 16.8v3.8" />
    </>,
    p,
  );

export const IconEye = (p?: Props) =>
  svg(
    <>
      <path d="M2.2 12S5.8 5.6 12 5.6 21.8 12 21.8 12 18.2 18.4 12 18.4 2.2 12 2.2 12Z" />
      <circle cx="12" cy="12" r="2.9" />
    </>,
    p,
  );

/** The app mark — a stylised control aperture, not a re-drawn Claude logo. */
export const IconLogo = (p?: Props) => (
  <svg
    width={p?.size ?? 20}
    height={p?.size ?? 20}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    aria-hidden="true"
  >
    <path d="M12 3.2v4.4M12 16.4v4.4M3.2 12h4.4M16.4 12h4.4" />
    <circle cx="12" cy="12" r="3.4" />
  </svg>
);

/** Icon for a tool name — a familiar glyph beats a generic dot. */
export function toolIcon(name: string, size = 15): VNode {
  const p = { size };
  if (name === "Task" || name === "Agent" || name === "Workflow") {
    return IconAgents(p);
  }
  if (name === "Bash" || name === "BashOutput") return IconTerminal(p);
  if (
    name === "Read" || name === "Write" || name === "Edit" ||
    name === "NotebookEdit"
  ) {
    return IconFile(p);
  }
  if (name === "Grep" || name === "Glob") return IconEye(p);
  if (name === "WebFetch" || name === "WebSearch") return IconPlug(p);
  if (name.startsWith("Task") || name.startsWith("Cron")) return IconTasks(p);
  if (name === "Skill") return IconSpark(p);
  return IconTerminal(p);
}
