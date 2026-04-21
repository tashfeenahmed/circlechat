interface Props {
  name: string;
  color: string;
  agent?: boolean;
  size?: "sm" | "md" | "lg" | "xl";
  status?: string;
}

export default function Avatar({ name, agent, size = "md", status }: Props) {
  const initial = name ? name.trim()[0]?.toUpperCase() ?? "?" : "?";
  const cls = [
    "av",
    agent ? "agent" : "",
    size === "sm" ? "sm" : "",
    size === "lg" ? "lg" : "",
    size === "xl" ? "xl" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span className="relative inline-flex">
      <span className={cls}>{initial}</span>
      {status && (
        <span
          aria-hidden
          className={`pres ${
            agent
              ? status === "working"
                ? "agent working"
                : "agent"
              : status === "online"
                ? "on"
                : status === "busy"
                  ? "busy"
                  : "off"
          }`}
          style={{
            position: "absolute",
            right: -3,
            bottom: -3,
            outline: "2px solid var(--color-paper)",
          }}
        />
      )}
    </span>
  );
}
