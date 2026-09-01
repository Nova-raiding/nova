import React from "react";
import ReactDOM from "react-dom/client";
import "antd/dist/reset.css";
import "./styles.css";
import App from "./App";
import { App as AntdApp, ConfigProvider } from "antd";
import { opsTheme } from "./theme/opsTheme.js";
import { purgeLocalOpsCredentialsForManagedSession } from "./api/opsClient.js";

purgeLocalOpsCredentialsForManagedSession(localStorage);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConfigProvider theme={opsTheme}>
      <AntdApp>
        <App />
      </AntdApp>
    </ConfigProvider>
  </React.StrictMode>,
);
