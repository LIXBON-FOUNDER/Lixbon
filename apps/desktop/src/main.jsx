import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "@xterm/xterm/css/xterm.css";
import "./styles/base.css";
import "./styles/shell.css";
import "./styles/editor.css";
import "./styles/terminal.css";
import "./styles/chat.css";
import "./styles/views.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
