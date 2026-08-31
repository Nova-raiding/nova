import React from "react";
import ReactDOM from "react-dom/client";
import "antd/dist/reset.css";
import "./styles.css";
import App from "./App";
import { ConfigProvider } from "antd";
import { opsTheme } from "./theme/opsTheme.js";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConfigProvider theme={opsTheme}>
      <App />
    </ConfigProvider>
  </React.StrictMode>,
);
