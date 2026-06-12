import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import App from "./App";
import { initTheme } from "./lib/theme";

// Apply the stored/preferred theme before React paints to avoid a flash, and
// track OS appearance changes while in "system" mode.
initTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
