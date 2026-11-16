"use server";

import { redirect } from "next/navigation";
import { getRequestMeta } from "@/server/request";
import { InviteError } from "@/server/staff/invites";
import { completePasswordReset, newPasswordSchema } from "@/server/staff/password-reset";

export type ResetPasswordState = {
  fieldErrors?: Partial<Record<"password" | "confirm", string>>;
  formError?: string;
};

export async function resetPasswordAction(token: string, _prev: ResetPasswordState, formData: FormData): Promise<ResetPasswordState> {
  const parsed = newPasswordSchema.safeParse({ password: String(formData.get("password") ?? ""), confirm: String(formData.get("confirm") ?? "") });
  if (!parsed.success) {
    const fieldErrors: ResetPasswordState["fieldErrors"] = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] as keyof NonNullable<ResetPasswordState["fieldErrors"]>;
      fieldErrors[key] ??= issue.message;
    }
    return { fieldErrors };
  }
  try {
    await completePasswordReset(token, parsed.data.password, await getRequestMeta());
  } catch (error) {
    if (error instanceof InviteError) {
      return error.code === "weak_password" ? { fieldErrors: { password: error.message } } : { formError: error.message };
    }
    console.error("[password-reset] failed", error);
    return { formError: "We couldn't change your password. Please try again." };
  }
  redirect("/sign-in?reason=password_reset");
}
