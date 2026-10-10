// One stroke icon set (24px grid, 1.8 stroke), drawn for this app.
const P = {
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4.2-4.2",
  star: "M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z",
  plus: "M12 5v14M5 12h14",
  compare: "M8 4v16M16 4v16M3 8h5M16 16h5M4 12h4M16 12h4",
  graph: "M6 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM12 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM7.5 6.2l8.7 1.3M7 7l4.2 10.2M17 9l-4.1 8.2",
  quote: "M9 7H6a2 2 0 0 0-2 2v3h5v5H4M20 7h-3a2 2 0 0 0-2 2v3h5v5h-5",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  copy: "M9 9h10v11H9zM5 15V4h10",
  check: "M5 12.5l4.5 4.5L19 7.5",
  x: "M6 6l12 12M18 6L6 18",
  down: "M6 9l6 6 6-6",
  right: "M9 6l6 6-6 6",
  left: "M15 6l-6 6 6 6",
  filter: "M4 5h16l-6 7.5V19l-4 1v-7.5z",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  upload: "M12 16V5M7 10l5-5 5 5M5 20h14",
  book: "M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h10",
  layers: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5",
  users: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a6 6 0 0 1 12 0v1M16 3.5a4 4 0 0 1 0 7.5M18 14a6 6 0 0 1 4 5.6V21",
  flag: "M5 21V4M5 4h11l-2 4 2 4H5",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7.5v.5",
  warn: "M12 4l9 16H3zM12 10v4.5M12 17.5v.5",
  shield: "M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z",
  lock: "M6 11h12v10H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18",
  bolt: "M13 3L5 13.5h6L10 21l9-11h-6z",
  code: "M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1.5v2M12 20.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1.5 12h2M20.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z",
  monitor: "M3 4h18v12H3zM8 20h8M12 16v4",
  keyboard: "M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10",
  list: "M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  edit: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
  stop: "M7 7h10v10H7z",
  dots: "M5 12h.01M12 12h.01M19 12h.01",
  arrowRight: "M5 12h14M13 6l6 6-6 6",
  history: "M3 12a9 9 0 1 0 3-6.7M3 4v4h4M12 8v4l3 2",
  home: "M4 11l8-7 8 7v9h-5v-6H9v6H4z",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  help: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17v.01",
  vote: "M4 11h4v9H4zM8 11l4-7a2 2 0 0 1 2 2v4h5a2 2 0 0 1 2 2.2l-1 6A2 2 0 0 1 18 20H8",
  pin: "M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  pack: "M4 7l8-4 8 4v10l-8 4-8-4zM4 7l8 4 8-4M12 11v10",
  insights: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  review: "M9 11l2 2 4-4M5 4h14v16H5z",
  route: "M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 17h7a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h7",
  printer: "M7 9V3h10v6M7 17H4v-7h16v7h-3M7 14h10v7H7z",
  minus: "M5 12h14",
  up: "M6 15l6-6 6 6",
  refresh: "M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4",
  agent: "M12 3v3M8 21h8M5 8h14v9H5zM9 12h.01M15 12h.01M10 15h4",
  tree: "M10 3h4v4h-4zM12 7v4M5 11h14M5 11v3M19 11v3M12 11v3M3 14h4v4H3zM10 14h4v4h-4zM17 14h4v4h-4z",
};

export function Icon({ name, size, title, className, filled }) {
  const d = P[name] || P.info;
  return (
    <svg className={"icon-svg " + (className || "")} viewBox="0 0 24 24" width={size || 16} height={size || 16} aria-hidden={title ? undefined : "true"}
      role={title ? "img" : undefined} fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {title ? <title>{title}</title> : null}
      <path d={d} />
    </svg>
  );
}

/** The app mark: sign, object, interpretant — three nodes, one triad. */
export function Mark({ className }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="8" fill="var(--ink)" />
      <path d="M16 8.5L8.8 21.5h14.4z" fill="none" stroke="var(--bg)" strokeWidth="1.6" strokeLinejoin="round" opacity=".55" />
      <circle cx="16" cy="8.5" r="3.1" fill="var(--k-notion)" />
      <circle cx="8.8" cy="21.5" r="3.1" fill="var(--k-enactable)" />
      <circle cx="23.2" cy="21.5" r="3.1" fill="var(--k-system)" />
    </svg>
  );
}
