import { Dialog } from "@base-ui/react/dialog";
import type { CSSProperties, ReactElement, ReactNode } from "react";

interface Props {
  onClose: () => void;
  /** Visual classes for the dialog panel (merged onto Dialog.Popup). */
  className?: string;
  style?: CSSProperties;
  /** Override the default backdrop chrome (e.g. the file viewer's blur). */
  backdropClassName?: string;
  /** Render the panel as a custom element, e.g. a <form onSubmit={…}>. */
  render?: ReactElement;
  children: ReactNode;
}

// Shared modal shell on Base UI Dialog. Call sites mount it conditionally
// (`{open && <Modal …>}`), exactly like the old hand-rolled backdrop divs —
// so `open` is always true here and closing goes through onClose. Base UI
// provides the portal, backdrop dismissal, Escape handling, focus trap and
// scroll lock; .cc-modal-backdrop / .cc-modal-pop provide the chrome.
export default function Modal({ onClose, className, style, backdropClassName, render, children }: Props) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={backdropClassName ?? "cc-modal-backdrop"} />
        <Dialog.Popup
          className={`cc-modal-pop ${className ?? ""}`}
          style={style}
          render={render}
        >
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
