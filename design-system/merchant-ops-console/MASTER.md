# Design System Master File

> **LOGIC:** When building a specific page, first check `design-system/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.

---

**Project:** Merchant Ops Console
**Generated:** 2026-08-30 11:49:19
**Category:** Analytics Dashboard
**Design Dials:** Variance 4/10 (Balanced / Modern) | Motion 3/10 (Subtle) | Density 8/10 (Dense / Dashboard)

---

## 2026-08-31 Desktop Ops + RBAC Override（权威）

本节覆盖下方自动生成内容中与真实运营台冲突的部分。完整交互规范见 `doc/todo/ops/ops-rbac-ui-design-2026-08-31.md`。

- **平台与范围：** 仅桌面运营工作台；1280×800、1440×900、1920×1080。手机、平板、触控导航不属于需求、验收或上线门禁。
- **技术基线：** React + Ant Design；全局视觉通过根 `ConfigProvider` 的 global/component tokens 管理，不在业务组件内散落颜色、圆角和阴影。
- **结构：** 224px 左侧任务导航 + 56px 身份/范围上下文条 + 页面标题/筛选工具条 + Table/工作队列主区 + Drawer 详情。禁止大页头连接表单和 Card 套 Table 的卡片拼盘。
- **权限语义：** `hidden`（无读权不泄露入口）、`read-only`（数据可读，区块标只读）、`disabled`（有能力但前置条件不足，必须解释）、`403`（权威拒绝，显示当前身份/范围/request ID/返回路径）。服务端 API 是最终权限门。
- **身份范围：** 平台级、工作区、店铺、受控支持会话必须持续可见；禁止对租户角色硬编码“全平台”。不得用本地“角色切换”模拟真实授权。
- **颜色：** 主色 `#1D4ED8`；正文 `#0F172A`；次文 `#475569`；布局底 `#F5F7FA`；容器 `#FFFFFF`；分隔 `#E2E8F0`；成功 `#15803D`；警告 `#B45309`；危险 `#B91C1C`。
- **字体：** 正文 `Fira Sans, Noto Sans SC, sans-serif`；中文标题 `Noto Sans SC` 600；ID/金额/数字列用 `Fira Code` 和 tabular numbers。
- **密度：** 4px 基础网格，间距 4/8/12/16/24/32；默认控件 36px、紧凑控件 30px、表格行约 44px；圆角只用 4/6/8。
- **表面：** 数据容器以 1px border 分层，常态无阴影；Drawer/Modal 才使用 elevation。卡片只有在“卡片本身是交互对象”时使用。
- **动效：** 只保留 Drawer/Modal/Collapse/加载反馈，150–200ms；禁用滚动 reveal、卡片上浮和装饰动效；尊重 `prefers-reduced-motion`。
- **无障碍：** 正文 4.5:1、非文本/焦点 3:1；键盘完整操作；页面切换聚焦 H1；Drawer 关闭焦点回触发器；状态不能只靠颜色；Table 保留语义和 `aria-sort`。

### Ant Design token baseline

```ts
{
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
    wireframe: false
  }
}
```

下方 `Enterprise Gateway` 营销页 pattern、移动端 checklist、通用卡片 hover 上浮和 scroll reveal 不适用于运营工作台，均由本节明确废止。

---

## Global Rules

### Color Palette

| Role | Hex | CSS Variable |
|------|-----|--------------|
| Primary | `#1E40AF` | `--color-primary` |
| On Primary | `#FFFFFF` | `--color-on-primary` |
| Secondary | `#3B82F6` | `--color-secondary` |
| On Secondary | `#000000` | `--color-on-secondary` |
| Accent/CTA | `#D97706` | `--color-accent` |
| On Accent/CTA | `#000000` | `--color-on-accent` |
| Background | `#F8FAFC` | `--color-background` |
| Foreground | `#1E3A8A` | `--color-foreground` |
| Card | `#FFFFFF` | `--color-card` |
| Card Foreground | `#1E3A8A` | `--color-card-foreground` |
| Muted | `#E9EEF6` | `--color-muted` |
| Muted Foreground | `#475569` | `--color-muted-foreground` |
| Border | `#DBEAFE` | `--color-border` |
| Destructive | `#DC2626` | `--color-destructive` |
| On Destructive | `#FFFFFF` | `--color-on-destructive` |
| Ring | `#1E40AF` | `--color-ring` |

**Color Notes:** Blue data + amber highlights [Accent adjusted from #F59E0B]

### Typography

- **Heading Font:** Fira Code
- **Body Font:** Fira Sans
- **Mood:** dashboard, data, analytics, code, technical, precise
- **Google Fonts:** [Fira Code + Fira Sans](https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600;700&family=Fira+Sans:wght@300;400;500;600;700&display=swap)

**CSS Import:**
```css
@import url('https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600;700&family=Fira+Sans:wght@300;400;500;600;700&display=swap');
```

### Spacing Variables

*Density: 8/10 — Dense / Dashboard*

| Token | Value | Usage |
|-------|-------|-------|
| `--space-xs` | `2px` / `0.125rem` | Tight gaps |
| `--space-sm` | `4px` / `0.25rem` | Icon gaps, inline spacing |
| `--space-md` | `8px` / `0.5rem` | Standard padding |
| `--space-lg` | `12px` / `0.75rem` | Section padding |
| `--space-xl` | `16px` / `1rem` | Large gaps |
| `--space-2xl` | `24px` / `1.5rem` | Section margins |
| `--space-3xl` | `32px` / `2rem` | Hero padding |

### Shadow Depths

| Level | Value | Usage |
|-------|-------|-------|
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,0.05)` | Subtle lift |
| `--shadow-md` | `0 4px 6px rgba(0,0,0,0.1)` | Cards, buttons |
| `--shadow-lg` | `0 10px 15px rgba(0,0,0,0.1)` | Modals, dropdowns |
| `--shadow-xl` | `0 20px 25px rgba(0,0,0,0.15)` | Hero images, featured cards |

---

## Component Specs

### Buttons

```css
/* Primary Button */
.btn-primary {
  background: #D97706;
  color: white;
  padding: 12px 24px;
  border-radius: 8px;
  font-weight: 600;
  transition: all 200ms ease;
  cursor: pointer;
}

.btn-primary:hover {
  opacity: 0.9;
  transform: translateY(-1px);
}

/* Secondary Button */
.btn-secondary {
  background: transparent;
  color: #1E40AF;
  border: 2px solid #1E40AF;
  padding: 12px 24px;
  border-radius: 8px;
  font-weight: 600;
  transition: all 200ms ease;
  cursor: pointer;
}
```

### Cards

```css
.card {
  background: #F8FAFC;
  border-radius: 12px;
  padding: 24px;
  box-shadow: var(--shadow-md);
  transition: all 200ms ease;
  cursor: pointer;
}

.card:hover {
  box-shadow: var(--shadow-lg);
  transform: translateY(-2px);
}
```

### Inputs

```css
.input {
  padding: 12px 16px;
  border: 1px solid #E2E8F0;
  border-radius: 8px;
  font-size: 16px;
  transition: border-color 200ms ease;
}

.input:focus {
  border-color: #1E40AF;
  outline: none;
  box-shadow: 0 0 0 3px #1E40AF20;
}
```

### Modals

```css
.modal-overlay {
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
}

.modal {
  background: white;
  border-radius: 16px;
  padding: 32px;
  box-shadow: var(--shadow-xl);
  max-width: 500px;
  width: 90%;
}
```

---

## Style Guidelines

**Style:** Data-Dense Dashboard

**Keywords:** Multiple charts/widgets, data tables, KPI cards, minimal padding, grid layout, space-efficient, maximum data visibility

**Best For:** Business intelligence dashboards, financial analytics, enterprise reporting, operational dashboards, data warehousing

**Key Effects:** Hover tooltips, chart zoom on click, row highlighting on hover, smooth filter animations, data loading spinners

### Page Pattern

**Pattern Name:** Enterprise Gateway

- **Conversion Strategy:** Path selection (I am a...). Mega menu navigation. Trust signals prominent. Provide pause/stop for video and rotating logos; stop on focus and reduced motion. Logo carousel controls must be keyboard operable; pause moving media offscreen/hidden and render a static final state under reduced motion.
- **CTA Placement:** Contact Sales (Primary) + Login (Secondary)
- **Section Order:** Hero (Video/Mission) > Solutions by Industry > Solutions by Role > Client Logos > Contact Sales

---

## Motion

**Scroll Reveal** (Subtle) — Trigger: scroll (viewport enter) | Duration: 300-400ms | Easing: `power1.out`

```js
gsap.from(el, { opacity: 0, y: 12, duration: 0.35, ease: 'power1.out', scrollTrigger: { trigger: el, start: 'top 90%', toggleActions: 'play none none reverse' } });
```

**Framework notes:** Requires the ScrollTrigger plugin registered once via gsap.registerPlugin(ScrollTrigger); Use matchMedia('(prefers-reduced-motion: reduce)') to skip non-essential motion and render the final state immediately

- ✅ Keep the y offset small (8-16px) so it reads as a fade, not a slide
- ❌ Don't reveal below-the-fold content needed for SEO/crawlers as invisible-by-default without a no-JS fallback
- ⚡ toggleActions 'play none none reverse' avoids re-triggering on every scroll direction change

---

## Anti-Patterns (Do NOT Use)

- ❌ Ornate design
- ❌ No filtering

### Additional Forbidden Patterns

- ❌ **Emojis as icons** — Use SVG icons (Heroicons, Lucide, Simple Icons)
- ❌ **Missing cursor:pointer** — All clickable elements must have cursor:pointer
- ❌ **Layout-shifting hovers** — Avoid scale transforms that shift layout
- ❌ **Low contrast text** — Maintain 4.5:1 minimum contrast ratio
- ❌ **Instant state changes** — Always use transitions (150-300ms)
- ❌ **Invisible focus states** — Focus states must be visible for a11y

---

## Pre-Delivery Checklist

Before delivering any UI code, verify:

- [ ] No emojis used as icons (use SVG instead)
- [ ] All icons from consistent icon set (Heroicons/Lucide)
- [ ] `cursor-pointer` on all clickable elements
- [ ] Hover states with smooth transitions (150-300ms)
- [ ] Light mode: text contrast 4.5:1 minimum
- [ ] Focus states visible for keyboard navigation
- [ ] `prefers-reduced-motion` respected
- [ ] Responsive: 375px, 768px, 1024px, 1440px
- [ ] No content hidden behind fixed navbars
- [ ] No horizontal scroll on mobile
