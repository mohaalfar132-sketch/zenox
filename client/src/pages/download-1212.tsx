import React from 'react';

export default function Download1212Page() {
  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center p-6">
      <div className="bg-gray-900 border border-emerald-500/30 rounded-2xl p-8 max-w-md w-full text-center shadow-2xl">
        <div className="text-4xl mb-4 font-mono text-emerald-400">1212</div>
        <h1 className="text-xl font-bold mb-2">الملف المضغوط الرمزي</h1>
        <p className="text-gray-400 text-sm mb-6">
          متذكرة برمجية مضغوطة برمز 1212 بحجم صغير جداً جاهزة للتنزيل المباشر على جهازك.
        </p>
        <a
          href="/zenox_1212.gz"
          download="zenox_1212.gz"
          className="inline-block w-full bg-emerald-600 hover:bg-emerald-500 text-white font-semibold py-3 px-6 rounded-xl transition duration-200 shadow-lg shadow-emerald-600/30 text-center"
        >
          تنزيل إلى جهازي الآن 📥
        </a>
      </div>
    </div>
  );
}
