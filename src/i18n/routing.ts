import {defineRouting} from 'next-intl/routing'; // 路由配置工具 / Routing configuration helper
import {createNavigation} from 'next-intl/navigation'; // 导航辅助工厂方法 / Navigation helpers factory

// 定义路由与语言配置 / Define routing and locale configuration
export const routing = defineRouting({
  locales: ['en', 'zh'], // 支持的语言列表 / Supported locale list
  defaultLocale: 'en', // 默认语言配置 / Default locale configuration
  localePrefix: 'always', // 所有路径都带语言前缀 / Always prefix paths with locale
});

// 基于 routing 创建多语言导航工具 / Create locale-aware navigation helpers based on routing
export const {Link, redirect, usePathname, useRouter, getPathname} = createNavigation(routing); // 导出导航工具 / Export navigation helpers

