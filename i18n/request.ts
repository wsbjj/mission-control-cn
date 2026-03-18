import {getRequestConfig, requestLocale} from 'next-intl/server'; // 请求级配置工厂 / Factory for per-request config

// next-intl 请求级配置 / next-intl request-level configuration
export default getRequestConfig(async () => {
  // next-intl 3.22+ deprecates the `locale` callback parameter.
  // Use requestLocale() instead to resolve the locale for this request.
  const locale = await requestLocale();
  // 回退到默认语言 en，防止非法 locale 直接报错 / Fallback to default 'en' to avoid crashes for invalid locales
  const finalLocale = locale ?? 'en';

  // 加载对应语言的消息字典 / Load messages for the resolved locale
  const messages = (await import(`../messages/${finalLocale}.json`)).default;

  return {
    locale: finalLocale, // 当前请求语言 / Locale of the current request
    messages, // 国际化文案字典 / i18n messages dictionary
  };
});

