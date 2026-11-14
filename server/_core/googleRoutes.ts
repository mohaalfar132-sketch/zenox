import type { Express, Request, Response } from "express";

import {
  clearGoogleCookie,
  connectGoogleAccount,
  createGoogleSession,
  createGoogleState,
  googleAuthUrl,
  googleConfigured,
  googleRedirectUri,
  readGoogleState,
  safeReturnTo,
  setGoogleCookie,
} from "../google";

function errorPath(message: string, returnTo = "/google") {
  const target = safeReturnTo(returnTo);
  const separator = target.includes("?") ? "&" : "?";
  return `${target}${separator}google_error=${encodeURIComponent(message.slice(0, 240))}`;
}

function queryValue(value: unknown) {
  return typeof value === "string" ? value : Array.isArray(value) ? String(value[0] ?? "") : "";
}

/**
 * Google OAuth bridge. The browser leaves ZENOX for accounts.google.com and
 * comes back to this exact callback, which stores encrypted tokens server-side
 * and gives the browser only an httpOnly session cookie.
 */
export function registerGoogleRoutes(app: Express) {
  app.get("/api/google/start", async (req: Request, res: Response) => {
    try {
      if (!googleConfigured()) {
        res.redirect(errorPath("لم تُضبط مفاتيح Google OAuth على الخادم بعد."));
        return;
      }
      const returnTo = safeReturnTo(queryValue(req.query.return));
      const state = await createGoogleState(returnTo);
      res.redirect(googleAuthUrl({ redirectUri: googleRedirectUri(req), state }));
    } catch (error) {
      res.redirect(errorPath(error instanceof Error ? error.message : "تعذر بدء ربط Google."));
    }
  });

  app.get("/api/google/callback", async (req: Request, res: Response) => {
    const stateData = await readGoogleState(queryValue(req.query.state)).catch(() => null);
    const returnTo = stateData?.returnTo ?? "/google";
    try {
      if (!googleConfigured()) throw new Error("لم تُضبط مفاتيح Google OAuth على الخادم بعد.");
      if (!stateData) throw new Error("انتهت صلاحية طلب الربط. ابدأ الربط من جديد.");
      const denied = queryValue(req.query.error);
      if (denied) throw new Error("لم تمنح صلاحية الوصول إلى Gmail وDrive.");
      const code = queryValue(req.query.code);
      if (!code) throw new Error("لم يصل رمز التفويض من Google.");

      const profile = await connectGoogleAccount(code, googleRedirectUri(req));
      const session = await createGoogleSession(profile);
      setGoogleCookie(res, session);
      const separator = returnTo.includes("?") ? "&" : "?";
      res.redirect(`${returnTo}${separator}google=connected`);
    } catch (error) {
      clearGoogleCookie(res);
      res.redirect(errorPath(error instanceof Error ? error.message : "تعذر إكمال ربط Google.", returnTo));
    }
  });
}
