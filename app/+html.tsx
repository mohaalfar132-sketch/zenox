import { ScrollViewStyleReset, useServerDocumentContext } from "expo-router/html";

export default function Root({ children }: { children: React.ReactNode }) {
  const { bodyAttributes, bodyNodes, htmlAttributes, headNodes } = useServerDocumentContext();

  return (
    <html lang="ar" dir="rtl" {...htmlAttributes}>
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />
        <meta name="theme-color" content="#0A0D1F" />
        <meta name="description" content="ZENOX — منصة المحادثة والبرمجة والتفاعل الصوتي." />
        <meta property="og:title" content="ZENOX — منصة التحكم الذكية" />
        <meta property="og:description" content="محادثة وأدوات متعددة في تجربة واحدة." />
        <meta name="application-name" content="ZENOX" />
        <link rel="manifest" href="/manifest.json" />
        <ScrollViewStyleReset />
        {headNodes}
        <title>ZENOX — منصة التحكم الذكية</title>
      </head>
      <body {...bodyAttributes}>
        {children}
        {bodyNodes}
      </body>
    </html>
  );
}
