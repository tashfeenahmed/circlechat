import { Menu as BaseMenu } from "@base-ui/react/menu";
import { MoreHorizontal } from "lucide-react";

export interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

interface Props {
  items: MenuItem[];
  title?: string;
  className?: string;
  align?: "start" | "end";
  children?: React.ReactNode; // trigger content; defaults to horizontal dots
}

// Dropdown menu on Base UI primitives: positioning, portal, outside-click,
// Escape, and full keyboard nav (arrows + typeahead) come from the library;
// the .menu-popover / .menu-item styling stays ours.
export default function Menu({ items, title = "More", className, align = "end", children }: Props) {
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger
        className={className ?? "tb-btn inline-flex items-center gap-1"}
        title={title}
      >
        {children ?? <MoreHorizontal size={14} strokeWidth={2} />}
      </BaseMenu.Trigger>
      <BaseMenu.Portal>
        <BaseMenu.Positioner className="cc-z-menu" side="bottom" align={align} sideOffset={4} collisionPadding={8}>
          <BaseMenu.Popup className="menu-popover">
            {items.map((it, i) => (
              <BaseMenu.Item
                key={i}
                disabled={it.disabled}
                className={`menu-item ${it.danger ? "danger" : ""}`}
                onClick={() => it.onSelect()}
              >
                {it.icon && <span className="menu-icon">{it.icon}</span>}
                <span>{it.label}</span>
              </BaseMenu.Item>
            ))}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}
