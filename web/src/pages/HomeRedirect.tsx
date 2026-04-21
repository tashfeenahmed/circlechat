import { Navigate } from "react-router-dom";
import { useConversations } from "../lib/hooks";

export default function HomeRedirect() {
  const conversations = useConversations();
  if (conversations.isLoading) return null;
  const channels = (conversations.data?.conversations ?? []).filter((c) => c.kind === "channel");
  if (channels.length) return <Navigate to={`/c/${channels[0].id}`} replace />;
  return <Navigate to="/members" replace />;
}
