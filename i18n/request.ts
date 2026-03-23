import {getRequestConfig} from 'next-intl/server'; // 请求级配置工厂 / Factory for per-request config
import {routing} from '@/i18n/routing'; // 与 middleware 共用的语言列表 / Shared locale list with middleware

// next-intl 请求级配置 / next-intl request-level configuration
export default getRequestConfig(async ({requestLocale}) => {
  let locale = await requestLocale;
  if (!locale || !routing.locales.includes(locale as (typeof routing.locales)[number])) {
    locale = routing.defaultLocale;
  }

  const messages = (await import(`../messages/${locale}.json`)).default;

  return {
    locale,
    messages,
  };
});

