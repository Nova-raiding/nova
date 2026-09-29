import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { OpsSidebar } from "../src/components/OpsSidebar.js";
import "../src/styles.css";

const visibleDomains = ["overview", "users", "customer-delivery", "stores", "rules", "finance", "audit"] as const;
const titles: Record<string, string> = {
  overview: "平台运营实时概况",
  finance: "平台财务中心",
};

function Harness() {
  const [activeDomain, setActiveDomain] = useState<string>("overview");
  return <div style={{ display: "grid", gridTemplateColumns: "220px minmax(0, 1fr)", minHeight: "100vh", background: "#f7f9f7" }}>
    <OpsSidebar activeDomain={activeDomain as never} visibleDomains={visibleDomains} onNavigate={(domain) => setActiveDomain(domain)} />
    <main style={{ padding: 48 }}>
      <h1>{titles[activeDomain] ?? activeDomain}</h1>
      <p>当前页面：{activeDomain}</p>
    </main>
  </div>;
}

createRoot(document.getElementById("root")!).render(<Harness />);
