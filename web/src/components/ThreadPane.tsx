import { X } from "lucide-react";
import MessageList from "./MessageList";
import Composer from "./Composer";
import { useMessages, usePostMessage, useMe } from "../lib/hooks";
import type { Message } from "../api/client";
import { useBus } from "../state/store";
import { usePaneResize } from "../lib/usePaneResize";

interface Props {
  conversationId: string;
  rootMessage: Message;
  onClose: () => void;
}

export default function ThreadPane({ conversationId, rootMessage, onClose }: Props) {
  const me = useMe();
  const replies = useMessages(conversationId, rootMessage.id);
  const post = usePostMessage(conversationId, rootMessage.id);
  const width = useBus((s) => s.threadWidth);
  const setWidth = useBus((s) => s.setThreadWidth);
  const startResize = usePaneResize(width, setWidth);

  const all = [rootMessage, ...(replies.data?.messages ?? [])];

  return (
    <aside className="thread-pane" style={{ width }}>
      <div
        className="pane-resize"
        onMouseDown={startResize}
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize"
      />
      <header className="thread-head">
        <div>
          <div className="th-title">Thread</div>
          <div className="th-sub">
            {(replies.data?.messages ?? []).length} repl
            {(replies.data?.messages ?? []).length === 1 ? "y" : "ies"}
          </div>
        </div>
        <button onClick={onClose} className="th-close" title="Close thread">
          <X size={15} strokeWidth={2} />
        </button>
      </header>
      <div className="thread-body">
        <MessageList messages={all} meMemberId={me.data?.memberId ?? undefined} inThread />
      </div>
      <Composer
        placeholder="Reply in thread…"
        conversationId={conversationId}
        hideHint
        onSend={async (bodyMd, attachments) => {
          await post.mutateAsync({ bodyMd, attachments });
        }}
      />
    </aside>
  );
}
