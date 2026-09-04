import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import "./index.css";

// Tab-title environment tag. The two LOCAL stacks (dev, and .env.test
// which shifts every port by a fixed dev+1000 offset - see CLAUDE.md's
// "Two isolated local container groups") run identical UIs on localhost,
// so they're told apart by port: this frontend's own dev port is 8081.
// Any non-localhost host is the single deployed stack - tag it LIVE.
// (The deploy reuses the dev port numbers, so the old port-only check
// mislabelled the VPS as DEV.)
const DEV_PORT = 8081;
function envTag(): string {
  const h = location.hostname;
  if (h !== "localhost" && h !== "127.0.0.1" && h !== "::1" && h !== "[::1]") return "LIVE";
  return (Number(location.port) || DEV_PORT) === DEV_PORT ? "DEV" : "TEST";
}
document.title = `execution [${envTag()}]`;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
