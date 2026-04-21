import Board from "../components/Board";

export default function BoardPage() {
  return (
    <main className="flex h-full min-w-0 min-h-0 flex-1 bg-white overflow-hidden">
      <div className="workspace flex-1 min-w-0">
        <header className="chan-head">
          <div className="ch-title">
            <span className="text-[var(--color-muted)]">◈</span>
            Board
          </div>
          <div className="ch-meta">
            <span>One board per workspace · drag cards between columns</span>
          </div>
        </header>
        <Board />
      </div>
    </main>
  );
}
