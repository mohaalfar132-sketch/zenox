import { z } from "zod";

import { publicProcedure, googleProcedure, router } from "./_core/trpc";
import {
  clearGoogleCookie,
  createDriveFolder,
  deleteDriveFile,
  disconnectGoogle,
  getGmailMessage,
  googleStatus,
  listDrive,
  listGmail,
  modifyGmail,
  sendGmail,
  shareDriveFile,
  updateDriveFile,
  uploadTextToDrive,
} from "./google";

export const googleRouter = router({
  status: publicProcedure.query(({ ctx }) => googleStatus(ctx.req, ctx.googleSub)),

  disconnect: publicProcedure.mutation(async ({ ctx }) => {
    if (ctx.googleSub) await disconnectGoogle(ctx.googleSub);
    clearGoogleCookie(ctx.res);
    return { disconnected: true };
  }),

  gmail: router({
    list: googleProcedure
      .input(z.object({ q: z.string().trim().max(300).optional(), max: z.number().int().min(1).max(25).optional() }).optional())
      .query(({ ctx, input }) => listGmail(ctx.googleSub, input ?? {})),
    get: googleProcedure
      .input(z.object({ id: z.string().trim().min(1).max(200) }))
      .query(({ ctx, input }) => getGmailMessage(ctx.googleSub, input.id)),
    send: googleProcedure
      .input(
        z.object({
          to: z.string().trim().email().max(320),
          subject: z.string().trim().min(1).max(200),
          body: z.string().trim().min(1).max(50_000),
        }),
      )
      .mutation(({ ctx, input }) => sendGmail(ctx.googleSub, input)),
    action: googleProcedure
      .input(
        z.object({
          id: z.string().trim().min(1).max(200),
          action: z.enum(["read", "unread", "archive", "unarchive", "trash", "untrash", "delete"]),
        }),
      )
      .mutation(({ ctx, input }) => modifyGmail(ctx.googleSub, input.id, input.action)),
  }),

  drive: router({
    list: googleProcedure
      .input(z.object({ q: z.string().trim().max(200).optional(), max: z.number().int().min(1).max(30).optional() }).optional())
      .query(({ ctx, input }) => listDrive(ctx.googleSub, input ?? {})),
    saveText: googleProcedure
      .input(
        z.object({
          name: z.string().trim().min(1).max(200),
          text: z.string().min(1).max(1_000_000),
          mimeType: z.string().trim().max(120).optional(),
        }),
      )
      .mutation(({ ctx, input }) => uploadTextToDrive(ctx.googleSub, input)),
    createFolder: googleProcedure
      .input(z.object({ name: z.string().trim().min(1).max(200), parentId: z.string().trim().max(300).optional() }))
      .mutation(({ ctx, input }) => createDriveFolder(ctx.googleSub, input)),
    update: googleProcedure
      .input(
        z.object({
          id: z.string().trim().min(1).max(300),
          name: z.string().trim().max(200).optional(),
          trashed: z.boolean().optional(),
        }),
      )
      .mutation(({ ctx, input }) => updateDriveFile(ctx.googleSub, input)),
    delete: googleProcedure
      .input(z.object({ id: z.string().trim().min(1).max(300) }))
      .mutation(({ ctx, input }) => deleteDriveFile(ctx.googleSub, input.id)),
    share: googleProcedure
      .input(
        z.object({
          id: z.string().trim().min(1).max(300),
          role: z.enum(["reader", "commenter", "writer"]),
          type: z.enum(["user", "group", "domain", "anyone"]),
          emailAddress: z.string().trim().email().max(320).optional(),
        }),
      )
      .mutation(({ ctx, input }) => shareDriveFile(ctx.googleSub, input)),
  }),
});
