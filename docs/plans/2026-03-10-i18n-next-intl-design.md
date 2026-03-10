# Mission Control i18n（next-intl）设计文档 / Mission Control i18n (next-intl) Design

> **For Claude / Cursor**: 本文描述的是架构与集成设计，不是实现步骤；后续实现计划会单独写在 implementation plan 中。  
> This document describes architecture & integration design, not step-by-step implementation; an implementation plan will be written separately.

---

## 1. 目标 / Goals

- **为 App Router 集成 next-intl**，支持 `en` 与 `zh` 两种语言。  
  Integrate next-intl into the App Router with `en` and `zh` locales.
- **引入 `[locale]` 路由前缀**，在不破坏现有 API 与 SSG 行为的前提下，实现 URL 级别的多语言。  
  Introduce a `[locale]` route prefix without breaking existing API and SSG behavior.
- **合并 next-intl middleware 与现有 API 中间件**，确保 API 鉴权、demo 模式、SSE 等逻辑完全不受 i18n 影响。  
  Merge next-intl middleware with existing API middleware while keeping API auth, demo mode, and SSE behavior untouched.
- **在 Header 中提供语言切换按钮**，风格与当前 UI 保持一致。  
  Add a language switcher button in the Header that matches the current UI style.

---

## 2. 目录与路由结构 / Directory & Routing Structure

### 2.1 现状 / Current State

- App Router 位于：`src/app`。  
  App Router root is in `src/app`.
- 根布局：`src/app/layout.tsx`，包含 `<html>`、`<body>`、字体与 `DemoBanner`。  
  Root layout at `src/app/layout.tsx` includes `<html>`, `<body>`, fonts and `DemoBanner`.
- 页面：  
  Pages:
  - `src/app/page.tsx`（主页 / home）  
  - `src/app/settings/page.tsx`（设置页 / settings page）  
  - `src/app/workspace/[slug]/page.tsx`（工作区主视图 / main workspace view）  
  - `src/app/workspace/[slug]/activity/page.tsx`（工作区活动页 / workspace activity page）

### 2.2 目标结构 / Target Structure

引入顶层动态段 `[locale]`，将页面迁移到其下：  
Introduce a top-level `[locale]` segment and move pages under it:

```text
src
└── app
    ├── layout.tsx                  // 根布局（不再渲染 <html>）/ Root layout (no longer renders <html>)
    └── [locale]
        ├── layout.tsx              // 基于 locale 的布局 / Locale-aware layout
        ├── page.tsx                // 首页（从原 app/page.tsx 迁移）/ Home (moved from app/page.tsx)
        ├── settings
        │   └── page.tsx            // 设置（从原 app/settings/page.tsx 迁移）/ Settings (moved from app/settings/page.tsx)
        └── workspace
            └── [slug]
                ├── page.tsx        // 工作区主视图 / Main workspace page
                └── activity
                    └── page.tsx    // 工作区活动页 / Workspace activity page
```

- 根 `layout.tsx`：仅负责引入 `globals.css` 与导出 `metadata`，不再包裹 `<html>` 与 `<body>`。  
  Root `layout.tsx` only imports `globals.css` and exports `metadata`, without wrapping `<html>` and `<body>`.
- `[locale]/layout.tsx`：  
  `[locale]/layout.tsx` will:
  - 校验 `params.locale` 是否为受支持语言。  
    Validate `params.locale` is a supported locale.
  - 动态导入对应 `messages/{locale}.json`。  
    Dynamically import `messages/{locale}.json`.
  - 渲染 `<html lang={locale}>` 和 `<body>`，并挂载 `NextIntlClientProvider`。  
    Render `<html lang={locale}>` and `<body>` with `NextIntlClientProvider`.
  - 保留原有字体与 `DemoBanner`。  
    Keep existing font and `DemoBanner`.

---

## 3. i18n 配置与消息字典 / i18n Config & Message Dictionaries

### 3.1 routing 配置 / Routing Configuration

新增 `src/i18n/routing.ts`：  
Add `src/i18n/routing.ts`:

- 使用 `defineRouting` 定义：  
  Use `defineRouting` to define:
  - `locales: ['en', 'zh']`
  - `defaultLocale: 'en'`
  - `localePrefix: 'always'`（所有页面 URL 都带显式前缀，如 `/en/...`）  
    `localePrefix: 'always'` so all page URLs include explicit prefixes like `/en/...`.
- （可选）使用 `createSharedPathnamesNavigation` 导出 `Link`、`useRouter`、`usePathname`。  
  Optionally use `createSharedPathnamesNavigation` to export `Link`, `useRouter`, `usePathname` helpers.
- 这些 helper 将用于 Header 中的语言切换器。  
  These helpers will be used for the language switcher in the Header.

### 3.2 消息字典 / Message Dictionaries

- 位置：  
  Location:
  - `messages/en.json`
  - `messages/zh.json`
- 设计原则 / Design principles:
  - Key 尽量语义化（如 `header.title`, `header.language.en`, `header.language.zh`）。  
    Use semantic keys like `header.title`, `header.language.en`, `header.language.zh`.
  - 仅包含文案，不混入业务逻辑。  
    Contain only copy, not business logic.
  - 中英双语注释写在使用这些 key 的 TS/TSX 文件里（例如 Header 与 i18n 配置），而不是 JSON 内部。  
    Bilingual comments will be added in the TS/TSX files that use these keys, not inside the JSON files.

示例键值 / Example keys:

- `header.title`：应用标题 / app title
- `header.allWorkspaces`：返回“所有工作区”按钮文案 / “All Workspaces” button label
- `header.online` / `header.offline`：在线状态文案 / online status copy
- `header.language.en` / `header.language.zh`：语言选项显示名称 / language option display names

---

## 4. middleware 合并设计 / Merged Middleware Design

### 4.1 现状 / Current State

当前 `src/middleware.ts`：  
Current `src/middleware.ts`:

- 仅通过 `config.matcher: '/api/:path*'` 作用于 `/api` 路由。  
  Applies only to `/api` routes via `config.matcher: '/api/:path*'`.
- 功能 / Features:
  - `MC_API_TOKEN` 鉴权 / `MC_API_TOKEN` authentication
  - `DEMO_MODE` 只读模式 / `DEMO_MODE` read-only mode
  - `/api/events/stream` 的 token 特例 / special token handling for `/api/events/stream`

### 4.2 目标结构 / Target Structure

合并后 `middleware.ts` 的逻辑分层：  
Logical layers in the merged `middleware.ts`:

1. **next-intl middleware 初始化**  
   **Initialize next-intl middleware**
   - `const handleI18n = createMiddleware(routing);`
2. **保留现有辅助函数与常量（原样）**  
   **Keep existing helpers and constants as-is**
   - `MC_API_TOKEN`、`DEMO_MODE`、`isSameOriginRequest` 等。  
     `MC_API_TOKEN`, `DEMO_MODE`, `isSameOriginRequest`, etc.
3. **入口函数 `middleware(request)` 拆分 / Split main `middleware(request)` function**

伪代码结构 / Pseudocode structure:

```ts
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 1) API 分支：完全跳过 next-intl
  //    API branch: skip next-intl entirely
  if (pathname.startsWith('/api/')) {
    // 这里包裹原有 API 中间件逻辑（仅增加缩进，不改语义）
    // Wrap existing API middleware logic here (only indentation changes, no semantic changes)
    // - DEMO_MODE 只读写保护 / demo mode write protection
    // - MC_API_TOKEN 鉴权 / MC_API_TOKEN authentication
    // - /api/events/stream query token 特例 / special query token handling
    // - 默认 NextResponse.next()
  }

  // 2) 页面分支：交给 next-intl 处理
  //    Page branch: handled by next-intl
  return handleI18n(request);
}
```

4. **matcher 扩展 / Matcher extension**

```ts
export const config = {
  matcher: [
    // 页面路由：匹配所有非 API、非 _next/_vercel、且不包含点号的路径
    // Page routes: match all non-API, non-_next/_vercel paths without a dot
    '/((?!api|_next|_vercel|.*\\..*).*)',

    // API 路由：保持对 /api/:path* 的显式匹配
    // API routes: keep explicit match for /api/:path*
    '/api/:path*'
  ]
};
```

**关键保证 / Key guarantees**:

- 所有 `/api/*` 请求都只经过「原有 API 逻辑」，不会被 next-intl 重写或拦截。  
  All `/api/*` requests go only through the original API logic; they are never rewritten or intercepted by next-intl.
- 所有非 `/api` 请求由 next-intl 负责 locale 检测与 URL 重写。  
  All non-`/api` requests are processed by next-intl for locale detection and URL rewriting.

---

## 5. Header 语言切换器设计 / Header Language Switcher Design

### 5.1 目标 / Goals

- 在 `src/components/Header.tsx` 中增加语言切换 UI。  
  Add language switch UI in `src/components/Header.tsx`.
- 样式与现有按钮（如 Settings 按钮、顶部状态 chips）保持一致。  
  Match the style of existing buttons (e.g., Settings button, status chips).
- 切换当前页面的 locale，并保持其余路径结构尽量不变。  
  Switch the locale for the current page while preserving the rest of the path.

### 5.2 技术实现 / Technical Implementation

- 从 `src/i18n/routing.ts` 导入 `useRouter` 与 `usePathname`（或直接从 `next-intl/navigation` 导入）。  
  Import `useRouter` and `usePathname` from `src/i18n/routing.ts` (or from `next-intl/navigation` directly).
- 通过 `usePathname()` 获取当前路径，例如 `/en/workspace/demo/activity`。  
  Use `usePathname()` to get current path, e.g. `/en/workspace/demo/activity`.
- 解析当前 locale 与余下路径：  
  Parse current locale and remaining path:

  ```ts
  const pathname = usePathname();
  const segments = pathname.split('/');
  const currentLocale = segments[1] || 'en';
  const restPath = '/' + segments.slice(2).join('/');
  ```

- 当用户点击切换到 `targetLocale` 时：  
  When user switches to `targetLocale`:

  ```ts
  const nextPath = `/${targetLocale}${restPath}`;
  router.push(nextPath);
  ```

- UI 形式：  
  UI form:
  - 桌面：在现有右侧区域（时钟、ONLINE 状态、Settings 按钮旁）增加一个小的语言按钮组（如 EN / 中文）。  
    Desktop: add a small language toggle next to the clock/ONLINE/Settings on the right.
  - 移动：在 Portrait header 中，紧邻 Settings 图标，用同样尺寸的圆角按钮或简洁下拉。  
    Mobile: place a similar button near the Settings icon in the portrait header.
- 所有新增 JSX 与逻辑行将携带中英双语注释。  
  All new JSX and logic lines will include bilingual comments.

---

## 6. 合规性与风险控制 / Compliance & Risk Control

- **API 合规**：  
  - API 请求仅匹配 `/api/:path*`，且仅走原有逻辑。  
    API requests are matched only by `/api/:path*` and processed by the original logic.
  - next-intl 的 middleware matcher 显式排除 `api` 前缀。  
    next-intl middleware matcher explicitly excludes the `api` prefix.
- **SSG / 路由**：  
  - 页面迁移时仅更改物理路径与 URL，内部数据获取与渲染逻辑保持不变。  
    When moving pages, only the physical path and URL prefix change; data fetching and rendering logic remain unchanged.
  - 若某些页面未来需要使用 `generateStaticParams` 等 SSG 特性，可以基于 `[locale]` 新结构安全地扩展。  
    If some pages later use `generateStaticParams` or other SSG features, they can be safely extended on top of the `[locale]` structure.
- **防御性编程**：  
  - middleware 中 API 分支与页面分支通过 `pathname.startsWith('/api/')` 明确区分。  
    API and page branches in middleware are clearly separated by `pathname.startsWith('/api/')`.
  - 不对原有 API 逻辑做重构，只做“包裹 + 缩进”调整。  
    No refactor of existing API logic—only wrapping and indentation changes.
  - 若在实现过程中发现 locale 与现有路径存在冲突（例如某些静态资源在 `/en` 之下无法访问），将立即停止并向用户报告。  
    If any conflicts between locale routing and existing paths appear (e.g., static assets under `/en`), implementation will pause and be reported to the user.

---

## 7. 后续实现摘要 / Implementation Summary (Next Steps)

1. 安装 `next-intl` 依赖并新增 `messages/en.json` 与 `messages/zh.json`。  
   Install `next-intl` and add `messages/en.json` and `messages/zh.json`.
2. 新增 `src/i18n/routing.ts`，配置 locales 与导航辅助函数。  
   Add `src/i18n/routing.ts` with locales and navigation helpers.
3. 重写 `src/middleware.ts` 为“API 分支 + next-intl 分支”的双通路结构。  
   Rewrite `src/middleware.ts` into a dual-path structure with API and next-intl branches.
4. 将 `src/app` 页面迁移到 `src/app/[locale]`，并新增 `[locale]/layout.tsx`。  
   Move pages from `src/app` to `src/app/[locale]` and add `[locale]/layout.tsx`.
5. 在 `Header.tsx` 中接入语言切换器，使用 next-intl 导航 helpers。  
   Integrate a language switcher into `Header.tsx` using next-intl navigation helpers.
6. 运行 lint 与构建，验证 API、SSG 与路由行为未被破坏。  
   Run lint and build to verify that API, SSG, and routing behavior remain intact.

