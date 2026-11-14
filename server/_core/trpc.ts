import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from "../../shared/const.js";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";

const isProduction = process.env.NODE_ENV === "production";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  // Production errors must not leak file paths or stack frames to the client.
  errorFormatter({ shape, error }) {
    if (isProduction) {
      return {
        ...shape,
        message:
          error.code === "INTERNAL_SERVER_ERROR" || error.code === "PARSE_ERROR"
            ? "حدث خطأ غير متوقع. أعد المحاولة."
            : shape.message,
        data: { ...shape.data, stack: undefined },
      };
    }
    return shape;
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;

const requireUser = t.middleware(async (opts) => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const protectedProcedure = t.procedure.use(requireUser);

export const adminProcedure = t.procedure.use(
  t.middleware(async (opts) => {
    const { ctx, next } = opts;

    if (!ctx.user || ctx.user.role !== "admin") {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  }),
);

/** Google is a connection, not a ZENOX admin login: it never grants owner rights. */
export const googleProcedure = t.procedure.use(
  t.middleware(async (opts) => {
    const sub = opts.ctx.googleSub;
    if (!sub) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "اربط حساب Google أولًا من شاشة Gmail & Drive." });
    }
    return opts.next({
      ctx: {
        ...opts.ctx,
        googleSub: sub,
      },
    });
  }),
);
