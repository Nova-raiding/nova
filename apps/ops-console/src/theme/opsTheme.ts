import type { ThemeConfig } from "antd";

export const opsTheme: ThemeConfig = {
  token: {
    colorPrimary: "#1D4ED8",
    colorInfo: "#2563EB",
    colorSuccess: "#15803D",
    colorWarning: "#B45309",
    colorError: "#B91C1C",
    colorText: "#0F172A",
    colorTextSecondary: "#475569",
    colorBgLayout: "#F5F7FA",
    colorBgContainer: "#FFFFFF",
    colorBorderSecondary: "#E2E8F0",
    borderRadius: 6,
    borderRadiusLG: 8,
    controlHeight: 36,
    controlHeightSM: 30,
    fontSize: 14,
    wireframe: false,
  },
  components: {
    Layout: { siderBg: "#10234F", headerBg: "#FFFFFF" },
    Button: { controlHeight: 44, controlHeightSM: 36, borderRadius: 6 },
    Input: { controlHeight: 44, activeBorderColor: "#1D4ED8", hoverBorderColor: "#2563EB" },
    Menu: { itemHeight: 40, itemBorderRadius: 6, itemMarginInline: 8 },
    Table: { headerBg: "#F8FAFC", headerColor: "#334155", rowHoverBg: "#EFF6FF", cellPaddingBlockSM: 10 },
    Card: { borderRadiusLG: 8 },
    Drawer: { paddingLG: 24 },
    Modal: { borderRadiusLG: 8 },
  },
};
