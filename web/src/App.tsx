import { useEffect } from "react";
import { BrowserRouter, Route, Routes, Navigate, useLocation, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { bus } from "./ws/client";
import { useMe, usePresenceBus } from "./lib/hooks";
import AppShell from "./components/AppShell";
import SignupPage from "./pages/Signup";
import LoginPage from "./pages/Login";
import InvitePage from "./pages/Invite";
import ChannelPage from "./pages/Channel";
import DMPage from "./pages/DM";
import MembersPage from "./pages/Members";
import FilesPage from "./pages/Files";
import OrgPage from "./pages/Org";
import SkillsPage from "./pages/Skills";
import AgentPage from "./pages/AgentDetail";
import ApprovalsPage from "./pages/Approvals";
import BoardPage from "./pages/Board";
import SettingsPage from "./pages/Settings";
import HomeRedirect from "./pages/HomeRedirect";

const qc = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
});

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </QueryClientProvider>
  );
}

function Shell() {
  const me = useMe();
  const location = useLocation();
  const nav = useNavigate();
  usePresenceBus();

  useEffect(() => {
    if (me.data) {
      bus.connect();
      return () => bus.disconnect();
    }
  }, [me.data]);

  if (me.isLoading) {
    return (
      <div className="h-screen grid place-items-center text-sm text-[var(--color-muted)]">
        loading…
      </div>
    );
  }

  const isStandalone =
    location.pathname === "/signup" ||
    location.pathname === "/login" ||
    location.pathname.startsWith("/invite/");

  // Invite links stay accessible to logged-in users (second-workspace flow).
  // `/signup` stays accessible too: the signup flow's step-2 agent onboarding
  // fires the auth POST mid-flow, at which point `me.data` is populated.
  // Kicking the user off /signup at that moment skips the agent step entirely.
  const redirectAwayFromAuth = location.pathname === "/login";

  if (!me.data && !isStandalone) return <Navigate to="/login" replace />;
  if (me.data && redirectAwayFromAuth) {
    void nav;
    return <Navigate to="/" replace />;
  }

  return (
    <Routes>
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/invite/:token" element={<InvitePage />} />

      <Route element={<AppShell />}>
        <Route index element={<HomeRedirect />} />
        <Route path="/c/:id" element={<ChannelPage />} />
        <Route path="/d/:memberId" element={<DMPage />} />
        <Route path="/members" element={<MembersPage />} />
        <Route path="/board" element={<BoardPage />} />
        <Route path="/files" element={<FilesPage />} />
        <Route path="/org" element={<OrgPage />} />
        <Route path="/skills" element={<SkillsPage />} />
        <Route path="/agents/:id" element={<AgentPage />} />
        <Route path="/approvals" element={<ApprovalsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  );
}
