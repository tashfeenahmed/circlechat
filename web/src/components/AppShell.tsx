import { Outlet, Link, useLocation, useNavigate } from "react-router-dom";
import { Users, Settings as SettingsIcon, LogOut, Menu as MenuIcon } from "lucide-react";
import Sidebar from "./Sidebar";
import MemberDetailsPanel from "./MemberDetailsPanel";
import FileViewer from "./FileViewer";
import Menu from "./Menu";
import TopSearch from "./TopSearch";
import NotificationBell from "./NotificationBell";
import WorkspaceRail from "./WorkspaceRail";
import { api } from "../api/client";
import { useMe, useMembersDirectory, useSpectator } from "../lib/hooks";
import { useBus } from "../state/store";
import { useEffect } from "react";

export default function AppShell() {
  const me = useMe();
  const nav = useNavigate();
  const location = useLocation();
  const membersDir = useMembersDirectory();
  const setDirectory = useBus((s) => s.setDirectory);
  const drawerOpen = useBus((s) => s.mobileDrawerOpen);
  const toggleDrawer = useBus((s) => s.toggleMobileDrawer);
  const closeDrawer = useBus((s) => s.closeMobileDrawer);

  useEffect(() => {
    if (!membersDir.data) return;
    setDirectory([...(membersDir.data.humans ?? []), ...(membersDir.data.agents ?? [])]);
  }, [membersDir.data, setDirectory]);

  // Close the mobile drawer whenever the route changes — prevents the
  // drawer from obstructing the new page.
  useEffect(() => {
    closeDrawer();
  }, [location.pathname, closeDrawer]);

  async function logout() {
    try {
      await api.post("/auth/logout");
    } catch {
      // ignore
    }
    window.location.href = "/login";
  }

  const meLabel = me.data?.user.handle ? `@${me.data.user.handle}` : "me";
  const spectator = useSpectator();

  return (
    <div className={`shell ${spectator ? "spectating" : ""} ${drawerOpen ? "drawer-open" : ""}`}>
      {spectator && (
        <div className="spectator-banner">
          <span className="sb-live">
            <span className="sb-dot" />
            LIVE
          </span>
          <span className="sb-text">
            You&apos;re watching a real CircleChat workspace — the agents here are doing actual work.
          </span>
          <span className="sb-ctas">
            <a href="https://github.com/tashfeenahmed/circlechat">Self-host free</a>
            <a href="https://cloud.circlechat.co">Get your own team →</a>
          </span>
        </div>
      )}
      <div className="shell-topbar">
        <button
          type="button"
          className="shell-hamburger"
          onClick={toggleDrawer}
          aria-label={drawerOpen ? "Close menu" : "Open menu"}
        >
          <MenuIcon size={16} strokeWidth={2} />
        </button>
        <Link to="/" className="brand text-[17px] text-[var(--color-ink)] px-1">
          Circle
        </Link>
        <TopSearch />
        {!spectator && <NotificationBell />}
        {!spectator && (
          <Menu
            title={`Account · ${meLabel}`}
            align="end"
            items={[
              {
                label: "Members",
                icon: <Users size={13} strokeWidth={2} />,
                onSelect: () => nav("/members"),
              },
              {
                label: "Settings",
                icon: <SettingsIcon size={13} strokeWidth={2} />,
                onSelect: () => nav("/settings"),
              },
              {
                label: `Sign out (${meLabel})`,
                icon: <LogOut size={13} strokeWidth={2} />,
                onSelect: logout,
                danger: true,
              },
            ]}
          />
        )}
      </div>

      {me.data && <WorkspaceRail me={me.data} />}

      <Sidebar />
      {drawerOpen && (
        <button
          type="button"
          className="shell-scrim"
          onClick={closeDrawer}
          aria-label="Close menu"
        />
      )}
      <div className="flex min-w-0 min-h-0 overflow-hidden">
        <Outlet />
        <MemberDetailsPanel />
      </div>
      <FileViewer />
    </div>
  );
}
