import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { User } from "../../drizzle/schema";
import { sdk } from "./sdk";
import { ENV } from "./env";
import { readOwnerSession } from "./ownerAuth";
import { readGoogleSession } from "../google";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
  owner?: { ownerId: string } | null;
  googleSub: string | null;
  googleEmail: string | null;
};

/**
 * Owner sessions (password) are mapped onto a synthetic admin user so every
 * existing adminProcedure keeps working without a Manus OAuth round-trip.
 */
function ownerUser(ownerId: string): User {
  const now = new Date();
  return {
    id: -1,
    openId: ownerId,
    name: "ZENOX",
    email: null,
    loginMethod: "owner-password",
    role: "admin",
    createdAt: now,
    updatedAt: now,
    lastSignedIn: now,
  } as User;
}

export async function createContext(opts: CreateExpressContextOptions): Promise<TrpcContext> {
  let user: User | null = null;
  const owner = await readOwnerSession(opts.req).catch(() => null);
  const google = await readGoogleSession(opts.req).catch(() => null);

  try {
    user = await sdk.authenticateRequest(opts.req);
  } catch {
    // Authentication is optional for public procedures.
    user = null;
  }

  if (!user && owner) {
    user = ownerUser(ENV.ownerOpenId || owner.ownerId);
  }

  return {
    req: opts.req,
    res: opts.res,
    user,
    owner,
    googleSub: google?.sub ?? null,
    googleEmail: google?.email ?? null,
  };
}
