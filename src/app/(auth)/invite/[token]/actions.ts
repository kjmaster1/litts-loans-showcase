"use server";

import { isAPIError } from "better-auth/api";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { auth } from "@/server/auth/auth";
import { withInviteContext } from "@/server/auth/invite-context";
import { db } from "@/server/db";
import { user } from "@/server/db/schema";
import { getRequestMeta } from "@/server/request";
import { completeInvite, findPendingInvite, isUsernameTaken, placeholderEmail } from "@/server/staff/invites";

export type AcceptInviteState = {
  fieldErrors?: Partial<Record<"username" | "password" | "confirm", string>>;
  formError?: string;
  values?: { username: string };
};

const schema = z
  .object({
    username: z
      .string()
      .trim()
      .toLowerCase()
      .min(3, "At least 3 characters.")
      .max(32, "At most 32 characters.")
      .regex(/^[a-z0-9._]+$/, "Use letters, numbers, dots and underscores only."),
    password: z.string().min(12, "Use at least 12 characters.").max(128, "Use at most 128 characters."),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { path: ["confirm"], message: "Passwords don't match." });

export async function acceptInviteAction(
  token: string,
  _prev: AcceptInviteState,
  formData: FormData,
): Promise<AcceptInviteState> {
  const raw = {
    username: String(formData.get("username") ?? ""),
    password: String(formData.get("password") ?? ""),
    confirm: String(formData.get("confirm") ?? ""),
  };
  const values = { username: raw.username };

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: AcceptInviteState["fieldErrors"] = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] as keyof NonNullable<AcceptInviteState["fieldErrors"]>;
      fieldErrors[key] ??= issue.message;
    }
    return { fieldErrors, values };
  }

  const invite = await findPendingInvite(token);
  if (!invite) return { formError: "This invite link is invalid, expired or already used.", values };

  const { username, password } = parsed.data;
  if (await isUsernameTaken(username)) {
    return { fieldErrors: { username: "That username is taken." }, values };
  }

  try {
    await withInviteContext(invite.inviteId, () =>
      auth.api.signUpEmail({
        body: { email: placeholderEmail(invite.staffId), password, name: invite.characterName, username },
      }),
    );
  } catch (error) {
    if (isAPIError(error)) {
      const code = (error.body as { code?: string } | undefined)?.code;
      if (code === "PASSWORD_COMPROMISED") {
        return { fieldErrors: { password: "This password has appeared in a data breach. Choose another." }, values };
      }
      if (code?.includes("USERNAME")) return { fieldErrors: { username: "That username isn't available." }, values };
    }
    console.error("[invite] sign-up failed", error);
    return { formError: "We couldn't create your account. Please try again.", values };
  }

  // Trust the database, not the sign-up response, for the new user's id.
  const created = await db.query.user.findFirst({ columns: { id: true }, where: eq(user.username, username) });
  if (!created) return { formError: "We couldn't create your account. Please try again.", values };

  try {
    await completeInvite({ invite, userId: created.id, request: await getRequestMeta() });
  } catch (error) {
    // Roll back the orphaned login so the invite can be retried cleanly.
    await db.delete(user).where(eq(user.id, created.id));
    console.error("[invite] completion failed", error);
    return { formError: "This invite has already been used.", values };
  }

  await auth.api.signInUsername({ body: { username, password }, headers: await headers() });
  redirect("/enroll-2fa");
}
