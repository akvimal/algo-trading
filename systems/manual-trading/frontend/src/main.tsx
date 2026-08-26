import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import "./index.css";

// This frontend's own dev port is 8084; a second local stack (e.g.
// .env.test) shifts every port by the same fixed offset (dev+1000) - see
// CLAUDE.md's "Two isolated local container groups". Comparing our own
// actual port to that dev reference tells us which stack we're in, shown
// in the tab title so dev/test (identical UI otherwise) can't be
// confused for each other.
const DEV_PORT = 8084;
document.title = `manual-trading [${(Number(location.port) || DEV_PORT) === DEV_PORT ? "DEV" : "TEST"}]`;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
