import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";

interface Props {
  content: React.ReactNode;
  children: React.ReactElement;
  placement?: "top" | "bottom";
  delay?: number;
  className?: string;
}

// Tooltip on Base UI primitives: portal, positioning + viewport flipping,
// hover/focus triggering, and delays come from the library. Wraps a single
// child via the render prop so the child keeps its own click handlers.
// Shows after `delay` ms (default 120).
export default function Tooltip({ content, children, placement = "top", delay = 120, className }: Props) {
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger delay={delay} render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner className="cc-z-tip" side={placement} sideOffset={6} collisionPadding={8}>
          <BaseTooltip.Popup className={`tooltip ${className ?? ""}`}>{content}</BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
